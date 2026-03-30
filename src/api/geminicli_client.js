import geminicliTokenManager from "../auth/geminicli_token_manager.js";
import config from "../config/config.js";
import quotaManager from "../auth/quota_manager.js";
import tokenCooldownManager from "../auth/token_cooldown_manager.js";
import { createApiError } from "../utils/errors.js";
import { httpRequest } from "../utils/httpClient.js";
import { saveBase64Image } from "../utils/imageStorage.js";
import {
  collectStreamChunk,
  createDumpId,
  createStreamCollector,
  dumpFinalRawResponse,
  dumpFinalRequest,
  dumpStreamResponse,
  isDebugDumpEnabled,
} from "./debugDump.js";
import {
  parseGeminiCandidateParts,
  toOpenAIUsage,
} from "./geminiResponseParser.js";
import { postJsonAndParse, runAxiosSseStream } from "./geminiTransport.js";
import { convertToToolCall } from "./stream_parser.js";
import { createStreamLineProcessor } from "./streamLineProcessor.js";
import {
  getUpstreamStatus,
  isCallerDoesNotHavePermission,
  readUpstreamErrorBody,
} from "./upstreamError.js";

// ==================== 调试：复用 client.js 的调试日志实现 ====================

/**
 * Gemini CLI API 客户端
 * 基于 client.js 简化实现，专门用于 Gemini CLI 反代
 * 主要区别：
 * 1. 使用 cloudcode-pa.googleapis.com 端点
 * 2. 使用 GeminiCLI User-Agent
 * 3. 使用 v1internal 端点，模型名称在请求体中指定
 * 4. 不需要 sessionId
 */

// ==================== 辅助函数 ====================

/**
 * 构建 Gemini CLI 请求头
 * @param {Object} token - Token 对象
 * @returns {Object} 请求头
 */
function buildHeaders(token) {
  const geminicliConfig = config.geminicli?.api || {};
  return {
    Host: geminicliConfig.host || "cloudcode-pa.googleapis.com",
    "User-Agent":
      geminicliConfig.userAgent || "GeminiCLI/0.1.5 (Windows; AMD64)",
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip",
  };
}

/**
 * 构建 Gemini CLI API URL
 * @param {boolean} stream - 是否流式
 * @returns {string} API URL
 */
function buildApiUrl(stream = true) {
  const geminicliConfig = config.geminicli?.api || {};
  // 使用 v1internal 端点，模型名称在请求体中指定
  return stream
    ? geminicliConfig.url ||
        "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
    : geminicliConfig.noStreamUrl ||
        "https://cloudcode-pa.googleapis.com/v1internal:generateContent";
}

/**
 * 获取 Gemini CLI 基础 URL（支持从完整 URL 解析）
 * @returns {string}
 */
function getGeminiCliBaseUrl() {
  const geminicliConfig = config.geminicli?.api || {};
  if (geminicliConfig.baseUrl) return geminicliConfig.baseUrl;

  const sampleUrl = geminicliConfig.url || geminicliConfig.noStreamUrl;
  if (sampleUrl) {
    try {
      return new URL(sampleUrl).origin;
    } catch {
      // ignore
    }
  }

  return "https://cloudcode-pa.googleapis.com";
}

/**
 * 构建 Gemini CLI 请求体
 * @param {Object} requestBody - 原始请求体（已包含 contents, generationConfig 等）
 * @param {string} model - 模型名称
 * @param {string} projectId - 项目ID（必需）
 * @returns {Object} 完整的请求体
 */
function buildRequestBody(requestBody, model, projectId) {
  // Gemini CLI 使用 v1internal 端点，请求格式与 Antigravity 类似
  // 需要包含 model、project、request 等字段
  // 注意：project 字段是必需的，否则会返回 500 Internal Error
  return {
    model: model,
    project: projectId,
    request: requestBody,
  };
}

/**
 * 统一错误处理
 * 
 * 429 处理策略（参考 MD 文档第 11.3 节）：
 * - 429 不禁用凭证，只对当前凭证+当前模型设置冷却
 * - 从错误响应中解析冷却结束时间
 * @param {Error} error - 错误对象
 * @param {Object} token - Token 对象
 * @param {string} [model] - 模型名称（用于模型级冷却）
 */
async function handleApiError(error, token, model) {
  const status = getUpstreamStatus(error);
  const errorBody = await readUpstreamErrorBody(error);

  if (status === 403) {
    if (isCallerDoesNotHavePermission(errorBody)) {
      throw createApiError(
        `超出模型最大上下文。错误详情: ${errorBody}`,
        status,
        errorBody,
      );
    }
    geminicliTokenManager.disableCurrentToken(token, `API请求返回403: ${errorBody}`);
    throw createApiError(
      `该账号没有使用权限，已自动禁用。错误详情: ${errorBody}`,
      status,
      errorBody,
    );
  }

  if (status === 429) {
    // 尝试解析冷却时间并设置模型级冷却
    if (model && token?.refresh_token) {
      try {
        const salt = await geminicliTokenManager.getSalt();
        const { generateTokenId } = await import("../utils/idGenerator.js");
        const tokenId = generateTokenId(token.refresh_token, salt);

        // 尝试从错误体中提取 resetTime
        let resetTimestamp = null;
        try {
          const parsed = typeof errorBody === "string" ? JSON.parse(errorBody) : errorBody;
          const resetTimeStr =
            parsed?.error?.details?.[0]?.metadata?.resetTime ||
            parsed?.resetTime ||
            parsed?.error?.resetTime;
          if (resetTimeStr) {
            const ms = Date.parse(resetTimeStr);
            if (Number.isFinite(ms) && ms > Date.now()) {
              resetTimestamp = ms;
            }
          }
        } catch {
          // 解析失败，使用默认冷却时间
        }

        // 如果无法从响应解析到 resetTime，默认冷却 5 分钟
        if (!resetTimestamp) {
          resetTimestamp = Date.now() + 5 * 60 * 1000;
        }

        tokenCooldownManager.setCooldown(tokenId, model, resetTimestamp);
      } catch {
        // 设置冷却失败不影响错误抛出
      }
    }

    throw createApiError(
      `请求频率过高，请稍后重试。错误详情: ${errorBody}`,
      status,
      errorBody,
    );
  }

  throw createApiError(
    `API请求失败 (${status}): ${errorBody}`,
    status,
    errorBody,
  );
}

// ==================== 导出函数 ====================

/**
 * 流式生成响应
 * @param {Object} requestBody - Gemini API 格式的请求体
 * @param {Object} token - Token 对象（必须包含 projectId）
 * @param {string} model - 模型名称
 * @param {Function} callback - 回调函数
 */
export async function generateStreamResponse(
  requestBody,
  token,
  model,
  callback,
) {
  if (!token.projectId) {
    throw createApiError(
      "Token 缺少 projectId，请在管理页面获取 ProjectId",
      400,
    );
  }

  const headers = buildHeaders(token);
  const url = buildApiUrl(true);
  const fullRequestBody = buildRequestBody(requestBody, model, token.projectId);

  // 调试日志
  const dumpId = isDebugDumpEnabled() ? createDumpId("cli_stream") : null;
  const streamCollector = dumpId ? createStreamCollector() : null;
  if (dumpId) {
    await dumpFinalRequest(dumpId, fullRequestBody);
  }

  // 状态对象用于流式解析
  const state = {
    toolCalls: [],
    reasoningSignature: null,
    sessionId: null, // Gemini CLI 不使用 sessionId
    model: model,
  };
  const processor = createStreamLineProcessor({
    state,
    onEvent: callback,
    onRawChunk: (chunk) => collectStreamChunk(streamCollector, chunk),
  });

  try {
    await runAxiosSseStream({
      url,
      headers,
      data: fullRequestBody,
      timeout: config.timeout,
      proxy: config.proxy || null,
      processor,
    });

    // 流式响应结束后写入日志
    if (dumpId) {
      await dumpStreamResponse(dumpId, streamCollector);
    }
  } catch (error) {
    try {
      processor.close();
    } catch {}
    await handleApiError(error, token, model);
  }
}

/**
 * 非流式生成响应
 * @param {Object} requestBody - Gemini API 格式的请求体
 * @param {Object} token - Token 对象（必须包含 projectId）
 * @param {string} model - 模型名称
 * @returns {Promise<Object>} 响应内容
 */
export async function generateNoStreamResponse(requestBody, token, model) {
  if (!token.projectId) {
    throw createApiError(
      "Token 缺少 projectId，请在管理页面获取 ProjectId",
      400,
    );
  }

  const headers = buildHeaders(token);
  const url = buildApiUrl(false);
  const fullRequestBody = buildRequestBody(requestBody, model, token.projectId);

  // 调试日志
  const dumpId = isDebugDumpEnabled() ? createDumpId("cli_no_stream") : null;
  if (dumpId) {
    await dumpFinalRequest(dumpId, fullRequestBody);
  }

  let data;
  try {
    data = await postJsonAndParse({
      useAxios: true,
      url,
      headers,
      body: fullRequestBody,
      timeout: config.timeout,
      proxy: config.proxy || null,
      dumpId,
      dumpFinalRawResponse,
    });
  } catch (error) {
    await handleApiError(error, token, model);
  }

  // 处理 GeminiCLI 的 response 包装格式
  // GeminiCLI API 返回格式: { "response": { "candidates": [...] } }
  if (data.response) {
    data = data.response;
  }

  // 解析响应内容
  const parts = data.candidates?.[0]?.content?.parts || [];
  const parsed = parseGeminiCandidateParts({
    parts,
    sessionId: null,
    model,
    convertToToolCall,
    saveBase64Image,
  });

  const usageData = toOpenAIUsage(data.usageMetadata);

  if (parsed.imageUrls.length > 0) {
    let markdown = parsed.content ? parsed.content + "\n\n" : "";
    markdown += parsed.imageUrls.map((url) => `![image](${url})`).join("\n\n");
    return {
      content: markdown,
      reasoningContent: parsed.reasoningContent,
      reasoningSignature: parsed.reasoningSignature,
      toolCalls: parsed.toolCalls,
      usage: usageData,
    };
  }

  return {
    content: parsed.content,
    reasoningContent: parsed.reasoningContent,
    reasoningSignature: parsed.reasoningSignature,
    toolCalls: parsed.toolCalls,
    usage: usageData,
  };
}

/**
 * 获取可用的 Token
 * @returns {Promise<Object|null>} Token 对象
 */
export async function getToken() {
  return geminicliTokenManager.getToken();
}

/**
 * 禁用当前 Token
 * @param {Object} token - Token 对象
 * @param {string} [reason] - 禁用原因
 */
export function disableCurrentToken(token, reason) {
  geminicliTokenManager.disableCurrentToken(token, reason);
}

/**
 * 记录请求（用于轮询策略）
 * @param {Object} token - Token 对象
 */
export function recordRequest(token) {
  if (token && token.refresh_token) {
    geminicliTokenManager.incrementRequestCount(token.refresh_token);
  }
}

/**
 * 获取 Gemini CLI 额度信息
 * 优先使用 retrieveUserQuota，失败时回退到 fetchAvailableModels
 * @param {Object} token - Token 对象（必须包含 projectId）
 * @returns {Promise<Object>} quotas: { [modelId]: { r, t } }
 */
export async function getGeminiCliQuotas(token) {
  if (!token?.projectId) {
    throw createApiError("Token 缺少 projectId，请先获取 Project ID", 400);
  }

  const baseUrl = getGeminiCliBaseUrl();
  const geminicliConfig = config.geminicli?.api || {};

  // ===== 第一优先：retrieveUserQuota =====
  try {
    const url = `${baseUrl}/v1internal:retrieveUserQuota`;
    const headers = {
      Host: geminicliConfig.host || "cloudcode-pa.googleapis.com",
      "User-Agent":
        geminicliConfig.userAgent || "GeminiCLI/0.1.5 (Windows; AMD64)",
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      "Accept-Encoding": "gzip",
    };

    const response = await httpRequest({
      method: "POST",
      url,
      headers,
      data: { project: token.projectId },
      timeout: config.timeout,
    });

    const buckets = response?.data?.buckets || [];
    const quotas = {};

    for (const bucket of buckets) {
      const modelId = bucket?.modelId || bucket?.model || bucket?.id;
      const fractionRaw = Number(bucket?.remainingFraction);
      if (!modelId || !Number.isFinite(fractionRaw)) continue;

      const remainingFraction = Math.min(1, Math.max(0, fractionRaw));
      const resetTime =
        typeof bucket?.resetTime === "string" ? bucket.resetTime : null;

      if (!quotas[modelId]) {
        quotas[modelId] = { r: remainingFraction, t: resetTime };
        continue;
      }

      // 同一模型取更低的剩余额度
      if (remainingFraction < quotas[modelId].r) {
        quotas[modelId].r = remainingFraction;
      }

      // 取更早的重置时间
      if (resetTime) {
        const currentReset = quotas[modelId].t;
        if (!currentReset) {
          quotas[modelId].t = resetTime;
        } else if (Date.parse(resetTime) < Date.parse(currentReset)) {
          quotas[modelId].t = resetTime;
        }
      }
    }

    return quotas;
  } catch (primaryError) {
    // retrieveUserQuota 失败，尝试 fetchAvailableModels 回退
    const primaryStatus =
      primaryError.response?.status || primaryError.status || primaryError.statusCode || 500;

    // 如果是认证/权限错误，不需要回退
    if (primaryStatus === 401 || primaryStatus === 403) {
      throw primaryError;
    }

    try {
      const fallbackUrl = `${baseUrl}/v1internal:fetchAvailableModels`;
      const fallbackHeaders = {
        Host: geminicliConfig.host || "cloudcode-pa.googleapis.com",
        "User-Agent":
          geminicliConfig.userAgent || "GeminiCLI/0.1.5 (Windows; AMD64)",
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip",
      };

      const fallbackResponse = await httpRequest({
        method: "POST",
        url: fallbackUrl,
        headers: fallbackHeaders,
        data: {},
        timeout: config.timeout,
      });

      const data = fallbackResponse?.data;
      const quotas = {};

      // fetchAvailableModels 返回格式: { models: { modelId: { quotaInfo: { remainingFraction, resetTime } } } }
      Object.entries(data?.models || {}).forEach(([modelId, modelData]) => {
        const quotaInfo = modelData?.quotaInfo;
        if (!quotaInfo) return;

        const fractionRaw = Number(quotaInfo.remainingFraction);
        if (!Number.isFinite(fractionRaw)) return;

        const remainingFraction = Math.min(1, Math.max(0, fractionRaw));
        const resetTime =
          typeof quotaInfo.resetTime === "string" ? quotaInfo.resetTime : null;

        quotas[modelId] = { r: remainingFraction, t: resetTime };
      });

      return quotas;
    } catch (fallbackError) {
      // 两个接口都失败了，抛出原始错误
      throw primaryError;
    }
  }
}
