import geminicliTokenManager from "../auth/geminicli_token_manager.js";
import config from "../config/config.js";
import { createApiError } from "../utils/errors.js";
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
 * @param {Error} error - 错误对象
 * @param {Object} token - Token 对象
 */
async function handleApiError(error, token) {
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
    geminicliTokenManager.disableCurrentToken(token);
    throw createApiError(
      `该账号没有使用权限，已自动禁用。错误详情: ${errorBody}`,
      status,
      errorBody,
    );
  }

  if (status === 429) {
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
    await handleApiError(error, token);
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
    await handleApiError(error, token);
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
 */
export function disableCurrentToken(token) {
  geminicliTokenManager.disableCurrentToken(token);
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
