import axios from "axios";
import path from "path";
import config, { getConfigJson } from "../config/config.js";
import {
  DEFAULT_REQUEST_COUNT_PER_TOKEN,
  TOKEN_REFRESH_BUFFER,
} from "../constants/index.js";
import { GEMINICLI_OAUTH_CONFIG } from "../constants/oauth.js";
import { TokenError } from "../utils/errors.js";
import { buildAxiosRequestConfig, httpRequest } from "../utils/httpClient.js";
import { generateTokenId } from "../utils/idGenerator.js";
import { log } from "../utils/logger.js";
import { getDataDir } from "../utils/paths.js";
import TokenStore from "./token_store.js";

// Gemini CLI API 配置
const GEMINICLI_API_CONFIG = {
  HOST: "cloudcode-pa.googleapis.com",
  USER_AGENT: "GeminiCLI/0.1.5 (Windows; AMD64)",
  BASE_URL: "https://cloudcode-pa.googleapis.com",
};

// 轮询策略枚举（复用 token_manager.js 的定义）
const RotationStrategy = {
  ROUND_ROBIN: "round_robin", // 均衡负载：每次请求切换
  QUOTA_EXHAUSTED: "quota_exhausted", // 额度耗尽才切换
  REQUEST_COUNT: "request_count", // 自定义次数后切换
};

/**
 * Gemini CLI Token 管理器
 * 基于 TokenManager 简化实现，专门用于 Gemini CLI 反代
 * 主要区别：
 * 1. 使用 geminicli_accounts.json 存储
 * 2. 使用 GEMINICLI_OAUTH_CONFIG 刷新 token
 * 3. 不需要 projectId 和 sessionId
 */
class GeminiCliTokenManager {
  /**
   * @param {string} filePath - Token 数据文件路径
   */
  constructor(filePath = path.join(getDataDir(), "geminicli_accounts.json")) {
    this.store = new TokenStore(filePath);
    /** @type {Array<Object>} */
    this.tokens = [];
    /** @type {number} */
    this.currentIndex = 0;

    // 轮询策略相关
    /** @type {string} */
    this.rotationStrategy = RotationStrategy.ROUND_ROBIN;
    /** @type {number} */
    this.requestCountPerToken = DEFAULT_REQUEST_COUNT_PER_TOKEN;
    /** @type {Map<string, number>} */
    this.tokenRequestCounts = new Map();

    /** @type {Promise<void>|null} */
    this._initPromise = null;
  }

  async _initialize() {
    try {
      log.info("[GeminiCLI] 正在初始化token管理器...");
      const tokenArray = await this.store.readAll();

      // Gemini CLI 不需要 sessionId
      this.tokens = tokenArray
        .filter((token) => token.enable !== false)
        .map((token) => ({
          ...token,
        }));

      this.currentIndex = 0;
      this.tokenRequestCounts.clear();

      // 加载轮询策略配置
      this.loadRotationConfig();

      if (this.tokens.length === 0) {
        log.warn("[GeminiCLI] ⚠ 暂无可用账号，请使用以下方式添加：");
        log.warn("[GeminiCLI]   方式1: 访问前端管理页面添加账号");
        log.warn("[GeminiCLI]   方式2: 手动编辑 geminicli_accounts.json");
      } else {
        log.info(`[GeminiCLI] 成功加载 ${this.tokens.length} 个可用token`);
        if (this.rotationStrategy === RotationStrategy.REQUEST_COUNT) {
          log.info(
            `[GeminiCLI] 轮询策略: ${this.rotationStrategy}, 每token请求 ${this.requestCountPerToken} 次后切换`,
          );
        } else {
          log.info(`[GeminiCLI] 轮询策略: ${this.rotationStrategy}`);
        }

        // 并发刷新所有过期的 token
        await this._refreshExpiredTokensConcurrently();
      }
    } catch (error) {
      log.error("[GeminiCLI] 初始化token失败:", error.message);
      this.tokens = [];
    }
  }

  /**
   * 并发刷新所有过期的 token
   * @private
   */
  async _refreshExpiredTokensConcurrently() {
    const expiredTokens = this.tokens.filter((token) => this.isExpired(token));
    if (expiredTokens.length === 0) {
      return;
    }

    const salt = await this.store.getSalt();
    const tokenIds = expiredTokens.map((token) =>
      generateTokenId(token.refresh_token, salt),
    );

    log.info(
      `[GeminiCLI] 正在批量刷新 ${tokenIds.length} 个token: ${tokenIds.join(", ")}`,
    );
    const startTime = Date.now();

    const results = await Promise.allSettled(
      expiredTokens.map((token) => this._refreshTokenSafe(token)),
    );

    let successCount = 0;
    let failCount = 0;
    const tokensToDisable = [];
    const disableReasons = [];
    const failedTokenIds = [];

    results.forEach((result, index) => {
      const token = expiredTokens[index];
      const tokenId = tokenIds[index];
      if (result.status === "fulfilled") {
        if (result.value.action === "success") {
          successCount++;
        } else if (result.value.action === "disable") {
          tokensToDisable.push(token);
          disableReasons.push(result.value.reason || "Token刷新失败");
          failCount++;
          failedTokenIds.push(tokenId);
        } else if (result.value.action === "skip") {
          failCount++;
          failedTokenIds.push(tokenId);
        }
      } else {
        failCount++;
        failedTokenIds.push(tokenId);
      }
    });

    // 批量禁用失效的 token
    for (let i = 0; i < tokensToDisable.length; i++) {
      this.disableToken(tokensToDisable[i], disableReasons[i]);
    }

    const elapsed = Date.now() - startTime;
    if (failCount > 0) {
      log.warn(
        `[GeminiCLI] 刷新完成: 成功 ${successCount}, 失败 ${failCount} (${failedTokenIds.join(", ")}), 耗时 ${elapsed}ms`,
      );
    } else {
      log.info(`[GeminiCLI] 刷新完成: 成功 ${successCount}, 耗时 ${elapsed}ms`);
    }
  }

  /**
   * 安全刷新单个 token（不抛出异常）
   * @param {Object} token - Token 对象
   * @returns {Promise<{action: 'success'|'disable'|'skip', reason?: string}>} 刷新结果
   * @private
   */
  async _refreshTokenSafe(token) {
    try {
      await this.refreshToken(token, true);
      this._clearTokenError(token);
      return { action: "success" };
    } catch (error) {
      const statusCode =
        error.statusCode || error.response?.status || error.status || 500;
      const rawMessage = error.message || "未知错误";
      const reason = `启动检测刷新失败(${statusCode}): ${rawMessage}`;
      this._recordTokenError(token, reason, "startup_refresh");
      if (statusCode === 403 || statusCode === 400) {
        return { action: "disable", reason };
      }
      return { action: "skip", reason };
    }
  }

  _recordTokenError(token, message, stage = "startup_refresh") {
    if (!token) return;
    const trimmed = String(message || "未知错误").slice(0, 800);
    token.lastError = trimmed;
    token.lastErrorTime = Date.now();
    token.lastErrorStage = stage;
    this.saveToFile(token);
  }

  _clearTokenError(token) {
    if (!token) return;
    if (token.lastError || token.lastErrorTime || token.lastErrorStage) {
      token.lastError = null;
      token.lastErrorTime = null;
      token.lastErrorStage = null;
      this.saveToFile(token);
    }
  }

  async _ensureInitialized() {
    if (!this._initPromise) {
      this._initPromise = this._initialize();
    }
    return this._initPromise;
  }

  // 加载轮询策略配置
  loadRotationConfig() {
    try {
      const jsonConfig = getConfigJson();
      // 优先使用 geminicli 专属配置，否则使用全局配置
      const rotationConfig =
        jsonConfig.geminicli?.rotation || jsonConfig.rotation;
      if (rotationConfig) {
        this.rotationStrategy =
          rotationConfig.strategy || RotationStrategy.ROUND_ROBIN;
        this.requestCountPerToken = rotationConfig.requestCount || 10;
      }
    } catch (error) {
      log.warn("[GeminiCLI] 加载轮询配置失败，使用默认值:", error.message);
    }
  }

  // 更新轮询策略（热更新）
  updateRotationConfig(strategy, requestCount) {
    if (strategy && Object.values(RotationStrategy).includes(strategy)) {
      this.rotationStrategy = strategy;
    }
    if (requestCount && requestCount > 0) {
      this.requestCountPerToken = requestCount;
    }
    this.tokenRequestCounts.clear();
    if (this.rotationStrategy === RotationStrategy.REQUEST_COUNT) {
      log.info(
        `[GeminiCLI] 轮询策略已更新: ${this.rotationStrategy}, 每token请求 ${this.requestCountPerToken} 次后切换`,
      );
    } else {
      log.info(`[GeminiCLI] 轮询策略已更新: ${this.rotationStrategy}`);
    }
  }

  /**
   * 检查 Token 是否过期
   * @param {Object} token - Token 对象
   * @returns {boolean} 是否过期
   */
  isExpired(token) {
    if (!token.timestamp || !token.expires_in) return true;
    const expiresAt = token.timestamp + token.expires_in * 1000;
    return Date.now() >= expiresAt - TOKEN_REFRESH_BUFFER;
  }

  /**
   * 刷新 Token
   * 使用 GEMINICLI_OAUTH_CONFIG 而非 OAUTH_CONFIG
   */
  async refreshToken(token, silent = false) {
    const salt = await this.store.getSalt();
    const tokenId = generateTokenId(token.refresh_token, salt);
    if (!silent) {
      log.info(`[GeminiCLI] 正在刷新token: ${tokenId}`);
    }

    const body = new URLSearchParams({
      client_id: GEMINICLI_OAUTH_CONFIG.CLIENT_ID,
      client_secret: GEMINICLI_OAUTH_CONFIG.CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
    });

    try {
      const response = await axios(
        buildAxiosRequestConfig({
          method: "POST",
          url: GEMINICLI_OAUTH_CONFIG.TOKEN_URL,
          headers: {
            Host: "oauth2.googleapis.com",
            "User-Agent": "google-oauth-playground",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept-Encoding": "gzip",
          },
          data: body.toString(),
        }),
      );

      token.access_token = response.data.access_token;
      token.expires_in = response.data.expires_in;
      token.timestamp = Date.now();
      this.saveToFile(token);
      return token;
    } catch (error) {
      const statusCode =
        error.response?.status || error.status || error.statusCode || 500;
      const rawBody = error.response?.data;
      const message =
        typeof rawBody === "string"
          ? rawBody
          : rawBody?.error?.message || error.message || "刷新 token 失败";
      const reason = `启动检测刷新失败(${statusCode}): ${message}`;
      this._recordTokenError(token, reason, "startup_refresh");
      throw new TokenError(message, tokenId, statusCode || 500);
    }
  }

  saveToFile(tokenToUpdate = null) {
    this.store.mergeActiveTokens(this.tokens, tokenToUpdate).catch((error) => {
      log.error("[GeminiCLI] 保存账号配置文件失败:", error.message);
    });
  }

  disableToken(token, reason = "未知原因") {
    log.warn(
      `[GeminiCLI] 禁用token ...${token.access_token.slice(-8)}, 原因: ${reason}`,
    );
    token.enable = false;
    token.disableReason = reason;
    token.disableTime = Date.now();
    token.lastError = reason;
    token.lastErrorTime = token.disableTime;
    token.lastErrorStage = "disable";
    this.saveToFile();
    this.tokenRequestCounts.delete(token.refresh_token);
    this.tokens = this.tokens.filter(
      (t) => t.refresh_token !== token.refresh_token,
    );
    this.currentIndex = this.currentIndex % Math.max(this.tokens.length, 1);
  }

  // 原子操作：获取并递增请求计数
  incrementRequestCount(tokenKey) {
    const current = this.tokenRequestCounts.get(tokenKey) || 0;
    const newCount = current + 1;
    this.tokenRequestCounts.set(tokenKey, newCount);
    return newCount;
  }

  // 原子操作：重置请求计数
  resetRequestCount(tokenKey) {
    this.tokenRequestCounts.set(tokenKey, 0);
  }

  /**
   * 通过 loadCodeAssist API 获取 projectId
   * @param {Object} token - Token 对象
   * @returns {Promise<string|null>} projectId 或 null
   */
  async fetchProjectId(token) {
    const salt = await this.store.getSalt();
    const tokenId = generateTokenId(token.refresh_token, salt);
    log.info(`[GeminiCLI] 正在获取 projectId: ${tokenId}`);

    const geminicliConfig = config.geminicli?.api || {};
    const baseUrl = geminicliConfig.baseUrl || GEMINICLI_API_CONFIG.BASE_URL;
    const url = `${baseUrl}/v1internal:loadCodeAssist`;

    const headers = {
      Host: geminicliConfig.host || GEMINICLI_API_CONFIG.HOST,
      "User-Agent":
        geminicliConfig.userAgent || GEMINICLI_API_CONFIG.USER_AGENT,
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      "Accept-Encoding": "gzip",
    };

    const requestBody = {
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    };

    try {
      const response = await httpRequest({
        method: "POST",
        url,
        headers,
        data: requestBody,
        timeout: 30000,
      });

      const data = response.data;

      // 检查是否有 currentTier（表示用户已激活）
      if (data.currentTier) {
        const projectId = data.cloudaicompanionProject;
        if (projectId) {
          log.info(`[GeminiCLI] 成功获取 projectId: ${projectId}`);
          return projectId;
        }
        log.warn("[GeminiCLI] loadCodeAssist 响应中无 projectId");
        return null;
      }

      // 用户未激活，尝试 onboardUser
      log.info("[GeminiCLI] 用户未激活，尝试 onboardUser...");
      return await this._tryOnboardUser(token, data);
    } catch (error) {
      const status = error.response?.status || error.status || 500;
      log.error(`[GeminiCLI] 获取 projectId 失败 (${status}):`, error.message);

      if (status === 403 || status === 401) {
        throw new TokenError("Token 无权限获取 projectId", tokenId, status);
      }
      throw new TokenError(
        `获取 projectId 失败: ${error.message}`,
        tokenId,
        status,
      );
    }
  }

  /**
   * 尝试通过 onboardUser 获取 projectId（长时间运行操作）
   * @param {Object} token - Token 对象
   * @param {Object} loadCodeAssistData - loadCodeAssist 的响应数据
   * @returns {Promise<string|null>} projectId 或 null
   * @private
   */
  async _tryOnboardUser(token, loadCodeAssistData) {
    const geminicliConfig = config.geminicli?.api || {};
    const baseUrl = geminicliConfig.baseUrl || GEMINICLI_API_CONFIG.BASE_URL;
    const url = `${baseUrl}/v1internal:onboardUser`;

    const headers = {
      Host: geminicliConfig.host || GEMINICLI_API_CONFIG.HOST,
      "User-Agent":
        geminicliConfig.userAgent || GEMINICLI_API_CONFIG.USER_AGENT,
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      "Accept-Encoding": "gzip",
    };

    // 从 loadCodeAssist 响应中获取默认 tier
    let tierId = "LEGACY";
    const allowedTiers = loadCodeAssistData?.allowedTiers || [];
    for (const tier of allowedTiers) {
      if (tier.isDefault) {
        tierId = tier.id;
        break;
      }
    }

    const requestBody = {
      tierId,
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    };

    // onboardUser 是长时间运行操作，需要轮询
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      log.debug(`[GeminiCLI] onboardUser 轮询 ${attempt}/${maxAttempts}`);

      try {
        const response = await httpRequest({
          method: "POST",
          url,
          headers,
          data: requestBody,
          timeout: 30000,
        });

        const data = response.data;

        if (data.done) {
          const responseData = data.response || {};
          const projectObj = responseData.cloudaicompanionProject;

          let projectId = null;
          if (typeof projectObj === "object" && projectObj !== null) {
            projectId = projectObj.id;
          } else if (typeof projectObj === "string") {
            projectId = projectObj;
          }

          if (projectId) {
            log.info(
              `[GeminiCLI] onboardUser 成功获取 projectId: ${projectId}`,
            );
            return projectId;
          }
          log.warn("[GeminiCLI] onboardUser 完成但响应中无 projectId");
          return null;
        }

        // 操作未完成，等待后重试
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch (error) {
        log.error(`[GeminiCLI] onboardUser 失败:`, error.message);
        throw error;
      }
    }

    log.error("[GeminiCLI] onboardUser 超时");
    return null;
  }

  /**
   * 准备单个 token（刷新 + 获取 projectId）
   * @param {Object} token - Token 对象
   * @returns {Promise<{action: 'ready'|'disable', reason?: string}>} 处理结果
   * @private
   */
  async _prepareToken(token) {
    // 刷新过期的 token
    if (this.isExpired(token)) {
      await this.refreshToken(token);
    }

    // 获取 projectId（如果没有）
    if (!token.projectId) {
      const projectId = await this.fetchProjectId(token);
      if (!projectId) {
        log.warn(`[GeminiCLI] 无法获取 projectId，禁用账号`);
        return {
          action: "disable",
          reason: "无法获取projectId，该账号可能不支持 Gemini CLI",
        };
      }
      token.projectId = projectId;
      this.saveToFile(token);
    }

    return { action: "ready" };
  }

  /**
   * 处理 token 准备过程中的错误
   * @param {Error} error - 错误对象
   * @param {Object} token - Token 对象
   * @returns {{action: 'disable'|'skip', reason?: string}} 处理结果
   * @private
   */
  _handleTokenError(error, token) {
    const suffix = token.access_token?.slice(-8) || "unknown";
    if (error.statusCode === 403 || error.statusCode === 400) {
      log.warn(
        `[GeminiCLI] ...${suffix}: Token 已失效或错误，已自动禁用该账号`,
      );
      return {
        action: "disable",
        reason: `Token准备失败(${error.statusCode}): ${error.message}`,
      };
    }
    log.error(`[GeminiCLI] ...${suffix} 操作失败:`, error.message);
    return { action: "skip" };
  }

  /**
   * 获取可用的 token
   * @returns {Promise<Object|null>} token 对象
   */
  async getToken() {
    await this._ensureInitialized();
    if (this.tokens.length === 0) return null;

    const totalTokens = this.tokens.length;
    const startIndex = this.currentIndex;

    for (let i = 0; i < totalTokens; i++) {
      const index = (startIndex + i) % totalTokens;
      const token = this.tokens[index];

      try {
        const result = await this._prepareToken(token);
        if (result.action === "disable") {
          this.disableToken(token, result.reason);
          if (this.tokens.length === 0) return null;
          continue;
        }

        // 更新当前索引
        this.currentIndex = index;

        // 根据策略决定是否切换
        if (this.rotationStrategy === RotationStrategy.ROUND_ROBIN) {
          this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        } else if (this.rotationStrategy === RotationStrategy.REQUEST_COUNT) {
          const tokenKey = token.refresh_token;
          const count = this.tokenRequestCounts.get(tokenKey) || 0;
          if (count >= this.requestCountPerToken) {
            this.resetRequestCount(tokenKey);
            this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
          }
        }

        return token;
      } catch (error) {
        const errorResult = this._handleTokenError(error, token);
        if (errorResult.action === "disable") {
          this.disableToken(token, errorResult.reason);
          if (this.tokens.length === 0) return null;
        }
        // skip: 继续尝试下一个 token
      }
    }

    return null;
  }

  disableCurrentToken(token, reason = "API请求返回403，账号无使用权限") {
    const found = this.tokens.find(
      (t) => t.access_token === token.access_token,
    );
    if (found) {
      this.disableToken(found, reason);
    }
  }

  // API管理方法
  async reload() {
    this._initPromise = this._initialize();
    await this._initPromise;
    log.info("[GeminiCLI] Token已热重载");
  }

  async addToken(tokenData) {
    try {
      const allTokens = await this.store.readAll();

      const newToken = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in || 3599,
        timestamp: tokenData.timestamp || Date.now(),
        enable: tokenData.enable !== undefined ? tokenData.enable : true,
      };

      if (tokenData.email) {
        newToken.email = tokenData.email;
      }

      if (tokenData.projectId) {
        newToken.projectId = tokenData.projectId;
      }

      allTokens.push(newToken);
      await this.store.writeAll(allTokens);

      await this.reload();
      return { success: true, message: "Token添加成功" };
    } catch (error) {
      log.error("[GeminiCLI] 添加Token失败:", error.message);
      return { success: false, message: error.message };
    }
  }

  async updateToken(refreshToken, updates) {
    try {
      const allTokens = await this.store.readAll();

      const index = allTokens.findIndex(
        (t) => t.refresh_token === refreshToken,
      );
      if (index === -1) {
        return { success: false, message: "Token不存在" };
      }

      // 重新启用时清除禁用原因
      if (updates.enable === true) {
        updates.disableReason = null;
        updates.disableTime = null;
      }

      allTokens[index] = { ...allTokens[index], ...updates };
      await this.store.writeAll(allTokens);

      await this.reload();
      return { success: true, message: "Token更新成功" };
    } catch (error) {
      log.error("[GeminiCLI] 更新Token失败:", error.message);
      return { success: false, message: error.message };
    }
  }

  async deleteToken(refreshToken) {
    try {
      const allTokens = await this.store.readAll();

      const filteredTokens = allTokens.filter(
        (t) => t.refresh_token !== refreshToken,
      );
      if (filteredTokens.length === allTokens.length) {
        return { success: false, message: "Token不存在" };
      }

      await this.store.writeAll(filteredTokens);

      await this.reload();
      return { success: true, message: "Token删除成功" };
    } catch (error) {
      log.error("[GeminiCLI] 删除Token失败:", error.message);
      return { success: false, message: error.message };
    }
  }

  async getTokenList() {
    try {
      const allTokens = await this.store.readAll();
      const salt = await this.store.getSalt();

      return allTokens.map((token) => ({
        id: generateTokenId(token.refresh_token, salt),
        expires_in: token.expires_in,
        timestamp: token.timestamp,
        enable: token.enable !== false,
        email: token.email || null,
        projectId: token.projectId || null,
        disableReason: token.disableReason || null,
        disableTime: token.disableTime || null,
        lastError: token.lastError || null,
        lastErrorTime: token.lastErrorTime || null,
        lastErrorStage: token.lastErrorStage || null,
      }));
    } catch (error) {
      log.error("[GeminiCLI] 获取Token列表失败:", error.message);
      return [];
    }
  }

  /**
   * 根据 tokenId 获取并更新 projectId
   * @param {string} tokenId - 安全的 token ID
   * @returns {Promise<Object>} 包含 projectId 的结果
   */
  async fetchProjectIdForToken(tokenId) {
    const tokenData = await this.findTokenById(tokenId);
    if (!tokenData) {
      throw new TokenError("Token不存在", null, 404);
    }

    // 确保 token 未过期
    if (this.isExpired(tokenData)) {
      await this.refreshToken(tokenData);
    }

    const projectId = await this.fetchProjectId(tokenData);
    if (!projectId) {
      throw new TokenError("无法获取 projectId，该账号可能无资格", null, 400);
    }

    // 更新并保存
    tokenData.projectId = projectId;

    // 更新文件
    const allTokens = await this.store.readAll();
    const salt = await this.store.getSalt();
    const index = allTokens.findIndex(
      (t) => generateTokenId(t.refresh_token, salt) === tokenId,
    );
    if (index !== -1) {
      allTokens[index].projectId = projectId;
      await this.store.writeAll(allTokens);
    }

    // 更新内存中的 token
    const memoryToken = this.tokens.find(
      (t) => t.refresh_token === tokenData.refresh_token,
    );
    if (memoryToken) {
      memoryToken.projectId = projectId;
    }

    return { projectId };
  }

  /**
   * 根据 tokenId 查找完整的 token 对象
   * @param {string} tokenId - 安全的 token ID
   * @returns {Promise<Object|null>} token 对象或 null
   */
  async findTokenById(tokenId) {
    try {
      const allTokens = await this.store.readAll();
      const salt = await this.store.getSalt();

      return (
        allTokens.find(
          (token) => generateTokenId(token.refresh_token, salt) === tokenId,
        ) || null
      );
    } catch (error) {
      log.error("[GeminiCLI] 查找Token失败:", error.message);
      return null;
    }
  }

  /**
   * 根据 tokenId 更新 token
   * @param {string} tokenId - 安全的 token ID
   * @param {Object} updates - 更新内容
   * @returns {Promise<Object>} 操作结果
   */
  async updateTokenById(tokenId, updates) {
    try {
      const allTokens = await this.store.readAll();
      const salt = await this.store.getSalt();

      const index = allTokens.findIndex(
        (token) => generateTokenId(token.refresh_token, salt) === tokenId,
      );

      if (index === -1) {
        return { success: false, message: "Token不存在" };
      }

      // 重新启用时清除禁用原因
      if (updates.enable === true) {
        updates.disableReason = null;
        updates.disableTime = null;
        updates.lastError = null;
        updates.lastErrorTime = null;
        updates.lastErrorStage = null;
      }

      allTokens[index] = { ...allTokens[index], ...updates };
      await this.store.writeAll(allTokens);

      await this.reload();
      return { success: true, message: "Token更新成功" };
    } catch (error) {
      log.error("[GeminiCLI] 更新Token失败:", error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * 发送测试消息验证凭证在 API 层面的可用性
   * 通过非流式 generateContent 发送一个极简请求，检查是否会返回 403 等致命错误
   * @param {Object} token - Token 对象（必须已刷新且包含 projectId）
   * @returns {Promise<{ok: boolean, status?: number, message?: string}>}
   * @private
   */
  async _sendTestMessage(token) {
    const geminicliConfig = config.geminicli?.api || {};
    const noStreamUrl =
      geminicliConfig.noStreamUrl ||
      "https://cloudcode-pa.googleapis.com/v1internal:generateContent";

    const testRequestBody = {
      model: "gemini-2.5-flash",
      project: token.projectId,
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: {
          maxOutputTokens: 1,
          candidateCount: 1,
        },
      },
    };

    try {
      await httpRequest({
        method: "POST",
        url: noStreamUrl,
        headers: {
          Host: geminicliConfig.host || GEMINICLI_API_CONFIG.HOST,
          "User-Agent":
            geminicliConfig.userAgent || GEMINICLI_API_CONFIG.USER_AGENT,
          Authorization: `Bearer ${token.access_token}`,
          "Content-Type": "application/json",
          "Accept-Encoding": "gzip",
        },
        data: testRequestBody,
        timeout: 30000,
      });
      return { ok: true };
    } catch (error) {
      const status =
        error.response?.status || error.status || error.statusCode || 500;
      let errorBody = "";
      try {
        const data = error.response?.data;
        errorBody =
          typeof data === "string"
            ? data
            : data
              ? JSON.stringify(data)
              : error.message;
      } catch {
        errorBody = error.message || "未知错误";
      }

      if (status === 403) {
        const isContextLimit = String(errorBody).includes(
          "The caller does not",
        );
        if (!isContextLimit) {
          return { ok: false, status, message: errorBody };
        }
      }

      // 其他非致命状态码不阻止启用
      return { ok: true };
    }
  }

  /**
   * 从禁用池启用 token（先测试可用性）
   * @param {string} tokenId - 安全的 token ID
   * @returns {Promise<Object>} 操作结果
   */
  async enableTokenById(tokenId) {
    try {
      const tokenData = await this.findTokenById(tokenId);
      if (!tokenData) {
        return { success: false, message: "Token不存在" };
      }

      // 如果 token 已经启用，直接返回
      if (tokenData.enable !== false) {
        return { success: true, message: "Token已处于启用状态" };
      }

      log.info(`[GeminiCLI][启用检测] 正在测试 token ${tokenId} 的可用性...`);

      // 步骤1: 尝试刷新 token
      try {
        await this.refreshToken(tokenData);
      } catch (error) {
        const statusCode = error.statusCode || 500;
        if (statusCode === 403 || statusCode === 400) {
          log.warn(
            `[GeminiCLI][启用检测] token ${tokenId} 刷新失败(${statusCode}): ${error.message}`,
          );
          return {
            success: false,
            message: `凭证不可用，刷新失败(${statusCode}): ${error.message}`,
          };
        }
        log.warn(
          `[GeminiCLI][启用检测] token ${tokenId} 刷新失败: ${error.message}`,
        );
        return { success: false, message: `凭证刷新失败: ${error.message}` };
      }

      // 步骤2: 尝试获取 projectId（验证账号权限）
      try {
        const projectId = await this.fetchProjectId(tokenData);
        if (projectId) {
          tokenData.projectId = projectId;
        } else if (!tokenData.projectId) {
          log.warn(`[GeminiCLI][启用检测] token ${tokenId} 无法获取 projectId`);
          return {
            success: false,
            message:
              "凭证不可用: 无法获取 projectId，该账号可能不支持 Gemini CLI",
          };
        }
      } catch (error) {
        const statusCode = error.statusCode || 500;
        if (statusCode === 403 || statusCode === 401) {
          log.warn(
            `[GeminiCLI][启用检测] token ${tokenId} 权限验证失败(${statusCode}): ${error.message}`,
          );
          return {
            success: false,
            message: `凭证不可用，权限验证失败(${statusCode}): ${error.message}`,
          };
        }
        // 非致命错误，继续启用
        log.warn(
          `[GeminiCLI][启用检测] token ${tokenId} 获取 projectId 时出现非致命错误: ${error.message}，继续启用`,
        );
      }

      // 步骤3: 发送测试消息，验证 API 调用是否会触发 403
      if (tokenData.projectId) {
        log.info(`[GeminiCLI][启用检测] 正在发送测试消息验证 API 可用性...`);
        const testResult = await this._sendTestMessage(tokenData);
        if (!testResult.ok) {
          log.warn(
            `[GeminiCLI][启用检测] token ${tokenId} 测试消息失败(${testResult.status}): ${testResult.message}`,
          );
          return {
            success: false,
            message: `凭证不可用，API 测试失败(${testResult.status}): ${testResult.message}`,
          };
        }
        log.info(`[GeminiCLI][启用检测] token ${tokenId} 测试消息通过`);
      }

      log.info(
        `[GeminiCLI][启用检测] token ${tokenId} 全部检测通过，正在启用...`,
      );

      // 测试通过，执行启用
      const allTokens = await this.store.readAll();
      const salt = await this.store.getSalt();

      const index = allTokens.findIndex(
        (token) => generateTokenId(token.refresh_token, salt) === tokenId,
      );

      if (index === -1) {
        return { success: false, message: "Token不存在" };
      }

      const updates = {
        enable: true,
        disableReason: null,
        disableTime: null,
        lastError: null,
        lastErrorTime: null,
        lastErrorStage: null,
      };
      if (tokenData.projectId) updates.projectId = tokenData.projectId;

      allTokens[index] = { ...allTokens[index], ...updates };
      await this.store.writeAll(allTokens);

      await this.reload();
      return { success: true, message: "Token更新成功" };
    } catch (error) {
      log.error("[GeminiCLI] 启用Token失败:", error.message);
      return { success: false, message: `启用失败: ${error.message}` };
    }
  }

  /**
   * 根据 tokenId 删除 token
   * @param {string} tokenId - 安全的 token ID
   * @returns {Promise<Object>} 操作结果
   */
  async deleteTokenById(tokenId) {
    try {
      const allTokens = await this.store.readAll();
      const salt = await this.store.getSalt();

      const filteredTokens = allTokens.filter(
        (token) => generateTokenId(token.refresh_token, salt) !== tokenId,
      );

      if (filteredTokens.length === allTokens.length) {
        return { success: false, message: "Token不存在" };
      }

      await this.store.writeAll(filteredTokens);

      await this.reload();
      return { success: true, message: "Token删除成功" };
    } catch (error) {
      log.error("[GeminiCLI] 删除Token失败:", error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * 根据 tokenId 刷新 token
   * @param {string} tokenId - 安全的 token ID
   * @returns {Promise<Object>} 刷新后的 token 信息（不含敏感数据）
   */
  async refreshTokenById(tokenId) {
    const tokenData = await this.findTokenById(tokenId);
    if (!tokenData) {
      throw new TokenError("Token不存在", null, 404);
    }

    const refreshedToken = await this.refreshToken(tokenData);
    return {
      expires_in: refreshedToken.expires_in,
      timestamp: refreshedToken.timestamp,
    };
  }

  /**
   * 获取盐值
   * @returns {Promise<string>} 盐值
   */
  async getSalt() {
    return this.store.getSalt();
  }

  // 获取当前轮询配置
  getRotationConfig() {
    return {
      strategy: this.rotationStrategy,
      requestCount: this.requestCountPerToken,
      currentIndex: this.currentIndex,
      tokenCounts: Object.fromEntries(this.tokenRequestCounts),
    };
  }
}

// 导出策略枚举
export { RotationStrategy };

const geminicliTokenManager = new GeminiCliTokenManager();
export default geminicliTokenManager;
