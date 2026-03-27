import axios from "axios";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import config from "../config/config.js";
import {
  GEMINICLI_OAUTH_CONFIG,
  GEMINICLI_OAUTH_SCOPES,
  OAUTH_CONFIG,
  OAUTH_SCOPES,
} from "../constants/oauth.js";
import fingerprintRequester from "../requester.js";
import { buildAxiosRequestConfig } from "../utils/httpClient.js";
import log from "../utils/logger.js";
import tokenManager from "./token_manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 请求客户端：优先使用 FingerprintRequester，失败则自动降级到 axios
let requester = null;
let useAxios = false;

if (config.useNativeAxios === true) {
  useAxios = true;
} else {
  try {
    const isPkg = typeof process.pkg !== "undefined";
    const configPath = isPkg
      ? path.join(path.dirname(process.execPath), "bin", "tls_config.json")
      : path.join(__dirname, "..", "bin", "tls_config.json");
    requester = fingerprintRequester.create({
      configPath,
      timeout: config.timeout ? Math.ceil(config.timeout / 1000) : 30,
    });
  } catch (error) {
    log.warn(
      "[OAuthManager] FingerprintRequester 初始化失败，自动降级使用 axios:",
      error.message,
    );
    useAxios = true;
  }
}

function buildRequesterConfig(
  headers,
  body = null,
  method = "POST",
  proxy = null,
) {
  const effectiveProxy =
    proxy || (config.proxy?.allRequests ? config.proxy : null);
  const reqConfig = {
    method,
    headers,
    timeout_ms: config.timeout,
  };
  if (effectiveProxy) {
    reqConfig.proxy = effectiveProxy;
  }
  if (body !== null) {
    reqConfig.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return reqConfig;
}

class OAuthManager {
  constructor() {
    this.state = crypto.randomUUID();
  }

  /**
   * 生成授权URL
   * @param {number} port - 回调端口
   * @param {string} mode - 模式：'antigravity' 或 'geminicli'
   */
  generateAuthUrl(port, mode = "antigravity") {
    const oauthConfig =
      mode === "geminicli" ? GEMINICLI_OAUTH_CONFIG : OAUTH_CONFIG;
    const scopes = mode === "geminicli" ? GEMINICLI_OAUTH_SCOPES : OAUTH_SCOPES;

    const params = new URLSearchParams({
      access_type: "offline",
      client_id: oauthConfig.CLIENT_ID,
      prompt: "consent",
      redirect_uri: `http://localhost:${port}/oauth-callback`,
      response_type: "code",
      scope: scopes.join(" "),
      state: `${this.state}_${mode}`, // 在 state 中包含 mode 信息
    });
    return `${oauthConfig.AUTH_URL}?${params.toString()}`;
  }

  /**
   * 交换授权码获取Token
   * @param {string} code - 授权码
   * @param {number} port - 回调端口
   * @param {string} mode - 模式：'antigravity' 或 'geminicli'
   */
  async exchangeCodeForToken(code, port, mode = "antigravity") {
    const oauthConfig =
      mode === "geminicli" ? GEMINICLI_OAUTH_CONFIG : OAUTH_CONFIG;

    const postData = new URLSearchParams({
      code,
      client_id: oauthConfig.CLIENT_ID,
      client_secret: oauthConfig.CLIENT_SECRET,
      redirect_uri: `http://localhost:${port}/oauth-callback`,
      grant_type: "authorization_code",
    });

    const headers = {
      Host: "oauth2.googleapis.com",
      "User-Agent": "Go-http-client/1.1",
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept-Encoding": "gzip",
    };

    if (useAxios) {
      const response = await axios(
        buildAxiosRequestConfig({
          method: "POST",
          url: oauthConfig.TOKEN_URL,
          headers,
          data: postData.toString(),
          timeout: config.timeout,
        }),
      );
      return response.data;
    }

    const response = await requester.antigravity_fetch(
      oauthConfig.TOKEN_URL,
      buildRequesterConfig(headers, postData.toString()),
    );
    if (response.status !== 200) {
      const errorBody = await response.text();
      throw new Error(`Token交换请求失败 (${response.status}): ${errorBody}`);
    }
    return await response.json();
  }

  /**
   * 获取用户邮箱
   */
  async fetchUserEmail(accessToken) {
    const headers = {
      Host: "www.googleapis.com",
      "User-Agent": "Go-http-client/1.1",
      Authorization: `Bearer ${accessToken}`,
      "Accept-Encoding": "gzip",
    };

    try {
      if (useAxios) {
        const response = await axios(
          buildAxiosRequestConfig({
            method: "GET",
            url: "https://www.googleapis.com/oauth2/v2/userinfo",
            headers,
            timeout: config.timeout,
          }),
        );
        return response.data?.email;
      }

      const response = await requester.antigravity_fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        buildRequesterConfig(headers, null, "GET"),
      );
      if (response.status !== 200) {
        const errorBody = await response.text();
        throw new Error(`获取用户信息失败 (${response.status}): ${errorBody}`);
      }
      const data = await response.json();
      return data?.email;
    } catch (err) {
      log.warn("获取用户邮箱失败:", err.message);
      return null;
    }
  }

  /**
   * 资格校验：尝试获取projectId
   */
  async validateAndGetProjectId(accessToken) {
    try {
      log.info("正在验证账号资格...");
      const { projectId, sub } =
        (await tokenManager.fetchProjectId({ access_token: accessToken })) ||
        {};

      if (projectId === undefined || projectId === null) {
        log.warn("该账号无法获取 projectId，可能无资格或需要稍后重试");
        return { projectId: null, hasQuota: false, sub };
      }

      log.info("账号验证通过，projectId: " + projectId);
      return { projectId, hasQuota: true, sub };
    } catch (err) {
      log.error("验证账号资格失败: " + err.message);
      sub = "free-tier";
      return { projectId: null, hasQuota: false, sub };
    }
  }

  /**
   * 完整的OAuth认证流程：交换Token -> 获取邮箱 -> 资格校验
   * @param {string} code - 授权码
   * @param {number} port - 回调端口
   * @param {string} mode - 模式：'antigravity' 或 'geminicli'
   */
  async authenticate(code, port, mode = "antigravity") {
    // 1. 交换授权码获取Token
    const tokenData = await this.exchangeCodeForToken(code, port, mode);

    if (!tokenData.access_token) {
      throw new Error("Token交换失败：未获取到access_token");
    }

    const account = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      timestamp: Date.now(),
    };

    // 2. 获取用户邮箱
    const email = await this.fetchUserEmail(account.access_token);
    if (email) {
      account.email = email;
      log.info(`[${mode}] 获取到用户邮箱: ${email}`);
    }

    // 3. 资格校验（仅 antigravity 模式需要 projectId）
    if (mode === "antigravity") {
      const { projectId, hasQuota, sub } = await this.validateAndGetProjectId(
        account.access_token,
      );
      account.projectId = projectId;
      account.hasQuota = hasQuota;
      account.sub = sub;
    }

    account.enable = true;

    return account;
  }

  /**
   * Gemini CLI 专用认证流程（简化版，不需要 projectId）
   * @param {string} code - 授权码
   * @param {number} port - 回调端口
   */
  async authenticateGeminiCli(code, port) {
    return this.authenticate(code, port, "GeminiCLI");
  }
}

export default new OAuthManager();
