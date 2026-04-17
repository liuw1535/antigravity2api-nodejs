import { randomUUID } from 'crypto';
import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';
import { saveBase64Image } from '../utils/imageStorage.js';
import logger from '../utils/logger.js';
import memoryManager from '../utils/memoryManager.js';
import requesterManager from '../utils/requesterManager.js';
import { generateTrajectorybody } from '../utils/trajectory.js';
import { buildRecordCodeAssistMetricsBody } from '../utils/recordCodeAssistMetrics.js';
import { createTelemetryBatch, serializeTelemetryBatch } from "../utils/createTelemetry.js"
import { createLog1, createLog2 } from "../utils/additionalLogs.js"
import { buildClientRegister, buildFrontEnd, buildClientFeatrueHeaders, buildClientRegisterHeaders, buildFrontEndHeaders } from "../utils/unleash.js"
import { MODEL_LIST_CACHE_TTL, QA_PAIRS } from '../constants/index.js';
import { createApiError } from '../utils/errors.js';
import { generateCheckpointBody } from '../utils/checkPoint.js';
import {
  convertToToolCall,
  registerStreamMemoryCleanup
} from './stream_parser.js';
import { setSignature, setToolCallSignature, shouldCacheSignature, isImageModel } from '../utils/thoughtSignatureCache.js';
import {
  isDebugDumpEnabled,
  createDumpId,
  createStreamCollector,
  collectStreamChunk,
  dumpFinalRequest,
  dumpStreamResponse,
  dumpFinalRawResponse
} from './debugDump.js';
import { getUpstreamStatus, readUpstreamErrorBody, isCallerDoesNotHavePermission } from './upstreamError.js';
import { createStreamLineProcessor } from './streamLineProcessor.js';
import { runSseStream, postJsonAndParse } from './geminiTransport.js';
import { parseGeminiCandidateParts, toOpenAIUsage } from './geminiResponseParser.js';
import { buildAuthorizedHeaders } from '../utils/googleAuth.js';

// ==================== Token 计时器管理 ====================
const tokenTimers = new Map(); // { tokenKey: { lastUsed: timestamp, intervalId: intervalId } }
const TOKEN_TIMEOUT = 3 * 60 * 1000; // 3分钟
const BACKEND_CALL_INTERVAL = 60 * 1000; // 60秒
const checkPointList = new Set([]);

function getTokenKey(token) {
  return token.access_token;
}

function startTokenTimer(token) {
  const key = getTokenKey(token);
  const now = Date.now();

  if (tokenTimers.has(key)) {
    tokenTimers.get(key).lastUsed = now;
    return;
  }
  sendClientRegister(token).catch(err => logger.warn('定时调用ClientRegister失败:', err.message));
  sendClientFeature(token).catch(err => logger.warn('定时调用ClientFeature失败:', err.message));
  sendFrontEnd(token).catch(err => logger.warn('定时调用FrontEnd失败:', err.message));

  const intervalId = setInterval(() => {
    sendClientRegister(token).catch(err => logger.warn('定时调用ClientRegister失败:', err.message));
    sendClientFeature(token).catch(err => logger.warn('定时调用ClientFeature失败:', err.message));
    sendFrontEnd(token).catch(err => logger.warn('定时调用FrontEnd失败:', err.message));
  }, BACKEND_CALL_INTERVAL);

  tokenTimers.set(key, { lastUsed: now, intervalId });
}

function checkTokenTimeout() {
  const now = Date.now();
  for (const [key, data] of tokenTimers.entries()) {
    if (now - data.lastUsed > TOKEN_TIMEOUT) {
      clearInterval(data.intervalId);
      tokenTimers.delete(key);
    }
  }
}

setInterval(checkTokenTimeout, 30 * 1000); // 每30秒检查一次超时

// ==================== 模型列表缓存（智能管理） ====================
const getModelCacheTTL = () => {
  return config.cache?.modelListTTL || MODEL_LIST_CACHE_TTL;
};

let modelListCache = null;
let modelListCacheTime = 0;

// 默认模型列表（当 API 请求失败时使用）
// 使用 Object.freeze 防止意外修改，并帮助 V8 优化
const DEFAULT_MODELS = Object.freeze([
  'claude-opus-4-6',
  'claude-opus-4-6-thinking',
  'claude-opus-4-7',
  'claude-opus-4-7-thinking',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking',
  'gemini-3.1-pro-high',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-image-4K',
  'gemini-3.1-flash-image-2K',
  'gemini-2.5-flash-thinking',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-3.1-pro-low',
  'chat_20706',
  'rev19-uic3-1p',
  'gpt-oss-120b-medium',
  'chat_23310'
]);

// 生成默认模型列表响应
function getDefaultModelList() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: DEFAULT_MODELS.map(id => ({
      id,
      object: 'model',
      created,
      owned_by: 'google'
    }))
  };
}


// 注册对象池与模型缓存的内存清理回调
function registerMemoryCleanup() {
  // 由流式解析模块管理自身对象池大小
  registerStreamMemoryCleanup();

  // 统一由内存清理器定时触发：仅清理"已过期"的模型列表缓存
  memoryManager.registerCleanup(() => {
    const ttl = getModelCacheTTL();
    const now = Date.now();
    if (modelListCache && (now - modelListCacheTime) > ttl) {
      modelListCache = null;
      modelListCacheTime = 0;
    }
  });
}

// 初始化时注册清理回调
registerMemoryCleanup();

// ==================== 辅助函数 ====================

function buildHeaders(token, hostOverride = null) {
  return buildAuthorizedHeaders(token, {
    host: hostOverride || config.api.host,
    transferEncoding: 'chunked'
  });
}

// ==================== 上游 baseURL Fallback ====================

/**
 * 判断错误是否应触发 baseURL fallback
 * 429 不触发（交给 with429Retry 的三档处理）
 * 403/400 不触发（权限/请求错误，换 URL 没用）
 */
function shouldFallback(error) {
  // 如果已经向客户端发送过流数据，禁止 fallback（避免脏数据）
  if (error?._skipFallback) return false;
  const status = getUpstreamStatus(error);
  if (status === 429) return false;
  if (status === 403) return false;
  if (status === 400) return false;
  if (status === 503) return true;
  if (status >= 500) return true;
  // 网络错误/超时（无 status 或 fallback 默认 500）
  const code = error?.code || error?.cause?.code;
  const networkCodes = [
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
    'EAI_AGAIN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT'
  ];
  if (code && networkCodes.includes(code)) return true;
  if (error?.message?.includes('timeout')) return true;
  return false;
}

/**
 * 带上游 baseURL fallback 的执行器
 * 按 config.api.upstreamCandidates 顺序尝试，遇到 503/网络错误/5xx 时自动切换下一个
 * 429/403/400 等不 fallback，直接抛出让上层处理
 *
 * @param {Function} fn - (candidate) => Promise，candidate 包含 { name, url, noStreamUrl, host, ... }
 *                        candidate 为 null 时表示无候选列表，应使用默认 config
 * @returns {Promise<any>}
 */
async function withUpstreamFallback(fn) {
  const candidates = config.api.upstreamCandidates;
  if (!candidates || candidates.length === 0) {
    // 无候选列表，直接用默认配置执行
    return fn(null);
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await fn(candidate);
    } catch (error) {
      lastError = error;
      if (!shouldFallback(error)) {
        throw error; // 429/403/400 等不应 fallback 的错误直接抛出
      }
      const status = getUpstreamStatus(error);
      logger.warn(
        `[upstream-fallback] ${candidate.name} 失败 (${status || 'network error'}: ${error.message?.substring(0, 100)})，` +
        `尝试下一个上游...`
      );
    }
  }
  logger.error('[upstream-fallback] 所有上游均失败');
  throw lastError;
}

// 统一错误处理
async function handleApiError(error, token, dumpId = null) {
  const status = getUpstreamStatus(error);
  const errorBody = await readUpstreamErrorBody(error);

  if (dumpId) {
    await dumpFinalRawResponse(dumpId, String(errorBody ?? ''));
  }

  if (status === 403) {
    if (isCallerDoesNotHavePermission(errorBody)) {
      throw createApiError(`超出模型最大上下文。错误详情: ${errorBody}`, status, errorBody);
    }
    tokenManager.disableToken(token);
    throw createApiError(`该账号没有使用权限，已自动禁用。错误详情: ${errorBody}`, status, errorBody);
  }

  throw createApiError(`API请求失败 (${status}): ${errorBody}`, status, errorBody);
}


// ==================== 导出函数 ====================

export async function generateAssistantResponse(requestBody, token, callback) {
  startTokenTimer(token);
  const trajectoryId = requestBody.requestId.split('/')[2];
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const modelName = requestBody.model;
  const dumpId = isDebugDumpEnabled() ? createDumpId('stream') : null;
  const streamCollector = dumpId ? createStreamCollector() : null;
  let num = Math.floor(Math.random() * QA_PAIRS.length);
  if (dumpId) {
    await dumpFinalRequest(dumpId, requestBody);
  }
  //console.log(JSON.stringify(requestBody,null,2));

  try {
    // 追踪是否已经向客户端发送过流数据（用于防止 fallback 时产生脏数据）
    let hasEmittedData = false;
    const safeCallback = (...args) => {
      hasEmittedData = true;
      return callback(...args);
    };

    await withUpstreamFallback(async (candidate) => {
      const targetUrl = candidate?.url || config.api.url;
      const targetHost = candidate?.host || config.api.host;
      const headers = buildHeaders(token, targetHost);
      headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody)));

      // 每次 fallback 尝试都创建新的 state/processor（避免上一次尝试的脏状态）
      const state = {
        toolCalls: [],
        reasoningSignature: null,
        sessionId: requestBody.request?.sessionId,
        model: requestBody.model
      };
      const processor = createStreamLineProcessor({
        state,
        onEvent: safeCallback,
        onRawChunk: (chunk) => collectStreamChunk(streamCollector, chunk)
      });

      try {
        await runSseStream({
          url: targetUrl,
          headers,
          body: requestBody,
          processor,
          onErrorChunk: (chunk) => collectStreamChunk(streamCollector, chunk)
        });
      } catch (error) {
        try { processor.close(); } catch { }
        // 如果已经向客户端发送过数据，不能 fallback（否则客户端收到重复/混乱的流事件）
        if (hasEmittedData) {
          error._skipFallback = true;
        }
        throw error; // 让 withUpstreamFallback 判断是否 fallback
      }
    });

    // 流式响应结束后，以 JSON 格式写入日志
    if (dumpId) {
      await dumpStreamResponse(dumpId, streamCollector);
    }
    sendRecordCodeAssistMetrics(token, trajectoryId).catch(err => logger.warn('发送RecordCodeAssistMetrics失败:', err.message));
    sendRecordTrajectoryAnalytics(token, num, trajectoryId, messageId, conversationId, modelName).catch(err => logger.warn('发送轨迹分析失败:', err.message));
    sendLog(token, num, trajectoryId, conversationId, messageId).catch(err => logger.warn('发送log失败:', err.message));
    sendCheckPoint(token).catch(err => logger.warn('发送checkPoint失败:', err.message));;
  } catch (error) {
    await handleApiError(error, token, dumpId);
  }
}

// 内部工具：从远端拉取完整模型原始数据
async function fetchRawModels(headers, token) {
  try {
    const { data } = await requesterManager.fetch(config.api.modelsUrl, {
      method: 'POST',
      headers,
      body: {},
    });
    return data;
  } catch (error) {
    await handleApiError(error, token);
  }
}

export async function getAvailableModels() {
  // 检查缓存是否有效（动态 TTL）
  const now = Date.now();
  const ttl = getModelCacheTTL();
  if (modelListCache && (now - modelListCacheTime) < ttl) {
    return modelListCache;
  }

  const token = await tokenManager.getToken();
  if (!token) {
    // 没有 token 时返回默认模型列表
    logger.warn('没有可用的 token，返回默认模型列表');
    return getDefaultModelList();
  }

  const headers = buildHeaders(token);
  const data = await fetchRawModels(headers, token);
  if (!data) {
    // fetchRawModels 里已经做了统一错误处理，这里兜底为默认列表
    return getDefaultModelList();
  }

  const created = Math.floor(Date.now() / 1000);
  const modelList = Object.keys(data.models || {}).map(id => ({
    id,
    object: 'model',
    created,
    owned_by: 'google'
  }));

  // 添加默认模型（如果 API 返回的列表中没有）
  const existingIds = new Set(modelList.map(m => m.id));
  for (const defaultModel of DEFAULT_MODELS) {
    if (!existingIds.has(defaultModel)) {
      modelList.push({
        id: defaultModel,
        object: 'model',
        created,
        owned_by: 'google'
      });
    }
  }

  const result = {
    object: 'list',
    data: modelList
  };

  // 更新缓存
  modelListCache = result;
  modelListCacheTime = now;
  const currentTTL = getModelCacheTTL();
  logger.info(`模型列表已缓存 (有效期: ${currentTTL / 1000}秒, 模型数量: ${modelList.length})`);

  return result;
}

// 清除模型列表缓存（可用于手动刷新）
export function clearModelListCache() {
  modelListCache = null;
  modelListCacheTime = 0;
  logger.info('模型列表缓存已清除');
}

export async function getModelsWithQuotas(token) {
  const headers = buildHeaders(token);
  const data = await fetchRawModels(headers, token);
  if (!data) return {};

  const quotas = {};
  Object.entries(data.models || {}).forEach(([modelId, modelData]) => {
    if (modelData.quotaInfo) {
      quotas[modelId] = {
        r: modelData.quotaInfo.remainingFraction,
        t: modelData.quotaInfo.resetTime
      };
    }
  });

  return quotas;
}

export async function generateAssistantResponseNoStream(requestBody, token) {
  startTokenTimer(token);
  const trajectoryId = requestBody.requestId.split('/')[2];
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const modelName = requestBody.model;
  const dumpId = isDebugDumpEnabled() ? createDumpId('no_stream') : null;
  let num = Math.floor(Math.random() * QA_PAIRS.length);

  if (dumpId) await dumpFinalRequest(dumpId, requestBody);
  let data;
  try {
    data = await withUpstreamFallback(async (candidate) => {
      const targetUrl = candidate?.noStreamUrl || config.api.noStreamUrl;
      const targetHost = candidate?.host || config.api.host;
      const headers = buildHeaders(token, targetHost);
      headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody)));

      return postJsonAndParse({
        url: targetUrl,
        headers,
        body: requestBody,
        dumpId,
        dumpFinalRawResponse,
        rawFormat: 'json'
      });
    });
    sendRecordCodeAssistMetrics(token, trajectoryId).catch(err => logger.warn('发送RecordCodeAssistMetrics失败:', err.message));
    sendRecordTrajectoryAnalytics(token, num, trajectoryId, messageId, conversationId, modelName).catch(err => logger.warn('发送轨迹分析失败:', err.message));
    sendLog(token, num, trajectoryId, conversationId, messageId).catch(err => logger.warn('发送log失败:', err.message));
  } catch (error) {
    await handleApiError(error, token, dumpId);
  }
  //console.log(JSON.stringify(data));
  const parts = data.response?.candidates?.[0]?.content?.parts || [];
  const parsed = parseGeminiCandidateParts({
    parts,
    sessionId: requestBody.request?.sessionId,
    model: requestBody.model,
    convertToToolCall,
    saveBase64Image
  });

  const usageData = toOpenAIUsage(data.response?.usageMetadata);

  // 将新的签名和思考内容写入全局缓存（按 model），供后续请求兜底使用
  const sessionId = requestBody.request?.sessionId;
  const model = requestBody.model;
  const hasTools = parsed.toolCalls.length > 0;
  const isImage = isImageModel(model);

  // 判断是否应该缓存签名
  if (sessionId && model && shouldCacheSignature({ hasTools, isImageModel: isImage })) {
    // 获取最终使用的签名（优先使用工具签名，回退到思维签名）
    let finalSignature = parsed.reasoningSignature;

    // 工具签名：取最后一个带 thoughtSignature 的工具作为缓存源（更接近"最新"）
    if (hasTools) {
      for (let i = parsed.toolCalls.length - 1; i >= 0; i--) {
        const sig = parsed.toolCalls[i]?.thoughtSignature;
        if (sig) {
          finalSignature = sig;
          break;
        }
      }
    }

    if (finalSignature) {
      const cachedContent = parsed.reasoningContent || ' ';
      setSignature(sessionId, model, finalSignature, cachedContent, { hasTools, isImageModel: isImage });
      if (hasTools) {
        for (const toolCall of parsed.toolCalls) {
          if (toolCall?.id && toolCall?.thoughtSignature) {
            setToolCallSignature(sessionId, model, toolCall.id, toolCall.thoughtSignature, cachedContent, {
              hasTools: true,
              isImageModel: isImage
            });
          }
        }
      }
    }
  }

  // 生图模型：转换为 markdown 格式
  if (parsed.imageUrls.length > 0) {
    let markdown = parsed.content ? parsed.content + '\n\n' : '';
    markdown += parsed.imageUrls.map(url => `![image](${url})`).join('\n\n');
    return { content: markdown, reasoningContent: parsed.reasoningContent, reasoningSignature: parsed.reasoningSignature, toolCalls: parsed.toolCalls, usage: usageData };
  }

  return { content: parsed.content, reasoningContent: parsed.reasoningContent, reasoningSignature: parsed.reasoningSignature, toolCalls: parsed.toolCalls, usage: usageData };
}

export async function generateImageForSD(requestBody, token) {
  startTokenTimer(token);
  const trajectoryId = requestBody.requestId.split('/')[2];
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const modelName = requestBody.model;
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  let num = Math.floor(Math.random() * QA_PAIRS.length);

  //console.log(JSON.stringify(requestBody,null,2));

  let data;
  try {
    const result = await requesterManager.fetch(config.api.noStreamUrl, {
      method: 'POST',
      headers,
      body: requestBody,
    });
    data = result.data;
  } catch (error) {
    await handleApiError(error, token);
  }
  sendRecordCodeAssistMetrics(token, trajectoryId).catch(err => logger.warn('发送RecordCodeAssistMetrics失败:', err.message));
  sendRecordTrajectoryAnalytics(token, num, trajectoryId, messageId, conversationId, modelName).catch(err => logger.warn('发送轨迹分析失败:', err.message));
  sendLog(token, num, trajectoryId, conversationId, messageId).catch(err => logger.warn('发送log失败:', err.message));

  const parts = data.response?.candidates?.[0]?.content?.parts || [];
  const images = parts.filter(p => p.inlineData).map(p => p.inlineData.data);

  return images;
}

export async function sendRecordTrajectoryAnalytics(token, num, trajectoryId, executionId, cascadeId, modelName = "claude-opus-4-6-thinking") {
  const trajectorybody = generateTrajectorybody(num, trajectoryId, executionId, cascadeId, modelName, token);
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(trajectorybody)));
  try {
    await requesterManager.fetch(config.api.recordTrajectory, {
      method: 'POST',
      headers,
      body: trajectorybody,
      okStatus: [200],
    });
  } catch (error) {
    throw new Error(`轨迹分析请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendLog(token, num, trajectoryId, conversationId, messageId) {
  const sessionId = trajectoryId;
  //const conversationId = randomUUID();

  const logs = [
    createLog2(conversationId, token, sessionId),
    createTelemetryBatch(num, sessionId, conversationId, messageId, token.sub),
    createLog1(conversationId, token, sessionId)
  ];

  const headers = buildHeaders(token);
  headers["Host"] = "play.googleapis.com";
  headers["User-Agent"] = "Go-http-client/1.1";
  headers["Content-Type"] = "application/octet-stream";
  headers["Accept-Encoding"] = "gzip";

  try {
    for (const log of logs) {
      const serializeData = serializeTelemetryBatch(log);
      if (!serializeData.success) {
        throw new Error(`Telemetry proto 序列化失败: ${serializeData.error}`);
      }
      const serializeLogBody = Buffer.from(serializeData.data);
      const requestHeaders = {
        ...headers,
        "Content-Length": String(serializeLogBody.length)
      };

      await requesterManager.fetch("https://play.googleapis.com/log", {
        method: 'POST',
        headers: requestHeaders,
        body: serializeLogBody,
        okStatus: [200, 204]
      });
    }
  } catch (error) {
    throw error;
  }
}

export async function sendRecordCodeAssistMetrics(token, trajectoryId) {
  const requestBody = buildRecordCodeAssistMetricsBody(token, trajectoryId);
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  try {
    await requesterManager.fetch(config.api.recordCodeAssistMetrics, {
      method: 'POST',
      headers,
      body: requestBody,
      okStatus: [200],
    });
  } catch (error) {
    throw new Error(`RecordCodeAssistMetrics请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendClientRegister(token) {
  const requestBody = buildClientRegister(token);
  const headers = buildClientRegisterHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  try {
    await requesterManager.fetch(config.api.unleash.register, {
      method: 'POST',
      headers,
      body: requestBody,
      okStatus: [200, 202],
    });
  } catch (error) {
    throw new Error(`ClientRegister请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendClientFeature(token) {
  const headers = buildClientFeatrueHeaders(token);
  //console.log(headers);
  try {
    await requesterManager.fetch(config.api.unleash.features, {
      method: 'GET',
      headers,
      okStatus: [200, 202],
    });
  } catch (error) {
    throw new Error(`ClientFeature请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendFrontEnd(token) {
  const requestBody = buildFrontEnd(token);
  const headers = buildFrontEndHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  try {
    await requesterManager.fetch(config.api.unleash.frontend, {
      method: 'POST',
      headers,
      body: requestBody,
      okStatus: [200, 202],
    });
  } catch (error) {
    throw new Error(`FrontEnd请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendCheckPoint(token) {
  const requestBody = generateCheckpointBody(token);
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody), 'utf-8'));
  if (checkPointList.has(token.sessionId)) {
    return;
  } else {
    checkPointList.add(token.sessionId);
  }
  try {
    await requesterManager.fetch(config.api.url, {
      method: 'POST',
      headers,
      body: requestBody,
      okStatus: [200, 202],
    });
  } catch (error) {
    throw new Error(`CheckPoint请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

// 导出内存清理注册函数（供外部调用）
export { registerMemoryCleanup };
