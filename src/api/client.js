import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';
import { generateToolCallId } from '../utils/idGenerator.js';
import AntigravityRequester from '../AntigravityRequester.js';
import { saveBase64Image } from '../utils/imageStorage.js';
import logger from '../utils/logger.js';
import memoryManager, { MemoryPressure, registerMemoryPoolCleanup } from '../utils/memoryManager.js';
import { buildAxiosRequestConfig, httpRequest, httpStreamRequest } from '../utils/httpClient.js';
import { setReasoningSignature, setToolSignature } from '../utils/thoughtSignatureCache.js';
import { getOriginalToolName } from '../utils/toolNameCache.js';

// 请求客户端：优先使用 AntigravityRequester，失败则降级到 axios
let requester = null;
let useAxios = false;

// ==================== 模型列表缓存（智能管理） ====================
// 缓存过期时间根据内存压力动态调整
const getModelCacheTTL = () => {
  const baseTTL = config.cache?.modelListTTL || 60 * 60 * 1000;
  const pressure = memoryManager.currentPressure;
  // 高压力时缩短缓存时间
  if (pressure === MemoryPressure.CRITICAL) return Math.min(baseTTL, 5 * 60 * 1000);
  if (pressure === MemoryPressure.HIGH) return Math.min(baseTTL, 15 * 60 * 1000);
  return baseTTL;
};

let modelListCache = null;
let modelListCacheTime = 0;

// 默认模型列表（当 API 请求失败时使用）
const DEFAULT_MODELS = [
  'claude-opus-4-5',
  'claude-opus-4-5-thinking',
  'claude-sonnet-4-5-thinking',
  'claude-sonnet-4-5',
  'gemini-3-pro-high',
  'gemini-2.5-flash-lite',
  'gemini-3-pro-image',
  'gemini-2.5-flash-thinking',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-3-pro-low',
  'chat_20706',
  'rev19-uic3-1p',
  'gpt-oss-120b-medium',
  'chat_23310'
];

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

if (config.useNativeAxios === true) {
  useAxios = true;
} else {
  try {
    requester = new AntigravityRequester();
  } catch (error) {
    console.warn('AntigravityRequester 初始化失败，降级使用 axios:', error.message);
    useAxios = true;
  }
}

// ==================== 零拷贝优化 ====================

// 预编译的常量（避免重复创建字符串）
const DATA_PREFIX = 'data: ';
const DATA_PREFIX_LEN = DATA_PREFIX.length;

// 高效的行分割器（零拷贝，避免 split 创建新数组）
// 使用对象池复用 LineBuffer 实例
class LineBuffer {
  constructor() {
    this.buffer = '';
    this.lines = [];
  }
  
  // 追加数据并返回完整的行
  append(chunk) {
    this.buffer += chunk;
    this.lines.length = 0; // 重用数组
    
    let start = 0;
    let end;
    while ((end = this.buffer.indexOf('\n', start)) !== -1) {
      this.lines.push(this.buffer.slice(start, end));
      start = end + 1;
    }
    
    // 保留未完成的部分
    this.buffer = start < this.buffer.length ? this.buffer.slice(start) : '';
    return this.lines;
  }
  
  // 清空缓冲区（用于归还到池之前）
  clear() {
    this.buffer = '';
    this.lines.length = 0;
  }
}

// LineBuffer 对象池
const lineBufferPool = [];
const getLineBuffer = () => {
  const buffer = lineBufferPool.pop();
  if (buffer) {
    buffer.clear();
    return buffer;
  }
  return new LineBuffer();
};
const releaseLineBuffer = (buffer) => {
  const maxSize = memoryManager.getPoolSizes().lineBuffer;
  if (lineBufferPool.length < maxSize) {
    buffer.clear();
    lineBufferPool.push(buffer);
  }
};

// 对象池：复用 toolCall 对象
const toolCallPool = [];
const getToolCallObject = () => toolCallPool.pop() || { id: '', type: 'function', function: { name: '', arguments: '' } };
const releaseToolCallObject = (obj) => {
  const maxSize = memoryManager.getPoolSizes().toolCall;
  if (toolCallPool.length < maxSize) toolCallPool.push(obj);
};

// 注册内存清理回调
function registerMemoryCleanup() {
  // 使用通用池清理工具，避免重复 while-pop 逻辑
  registerMemoryPoolCleanup(toolCallPool, () => memoryManager.getPoolSizes().toolCall);
  registerMemoryPoolCleanup(lineBufferPool, () => memoryManager.getPoolSizes().lineBuffer);

  memoryManager.registerCleanup((pressure) => {
    // 高压力或紧急时清理模型缓存
    if (pressure === MemoryPressure.HIGH || pressure === MemoryPressure.CRITICAL) {
      const ttl = getModelCacheTTL();
      const now = Date.now();
      if (modelListCache && (now - modelListCacheTime) > ttl) {
        modelListCache = null;
        modelListCacheTime = 0;
        logger.info('已清理过期模型列表缓存');
      }
    }
    
    // 紧急时强制清理模型缓存
    if (pressure === MemoryPressure.CRITICAL && modelListCache) {
      modelListCache = null;
      modelListCacheTime = 0;
      logger.info('紧急清理模型列表缓存');
    }
  });
}

// 初始化时注册清理回调
registerMemoryCleanup();

// ==================== 辅助函数 ====================

function buildHeaders(token) {
  return {
    'Host': config.api.host,
    'User-Agent': config.api.userAgent,
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip'
  };
}

function buildRequesterConfig(headers, body = null) {
  const reqConfig = {
    method: 'POST',
    headers,
    timeout_ms: config.timeout,
    proxy: config.proxy
  };
  if (body !== null) reqConfig.body = JSON.stringify(body);
  return reqConfig;
}

// 统一构造上游 API 错误对象，方便服务器层识别并透传
function createApiError(message, status, rawBody) {
  const err = new Error(message);
  err.status = status;
  err.rawBody = rawBody;
  err.isUpstreamApiError = true;
  return err;
}

// 统一错误处理
async function handleApiError(error, token) {
  const status = error.response?.status || error.status || 'Unknown';
  let errorBody = error.message;
  
  if (error.response?.data?.readable) {
    const chunks = [];
    for await (const chunk of error.response.data) {
      chunks.push(chunk);
    }
    errorBody = Buffer.concat(chunks).toString();
  } else if (typeof error.response?.data === 'object') {
    errorBody = JSON.stringify(error.response.data, null, 2);
  } else if (error.response?.data) {
    errorBody = error.response.data;
  }
  
  if (status === 403) {
    if (JSON.stringify(errorBody).includes("The caller does not")){
      throw createApiError(`超出模型最大上下文。错误详情: ${errorBody}`, status, errorBody);
    }
    tokenManager.disableCurrentToken(token);
    throw createApiError(`该账号没有使用权限，已自动禁用。错误详情: ${errorBody}`, status, errorBody);
  }
  
  throw createApiError(`API请求失败 (${status}): ${errorBody}`, status, errorBody);
}

// 转换 functionCall 为 OpenAI 格式（使用对象池）
// 会尝试将安全工具名还原为原始工具名
function convertToToolCall(functionCall, sessionId, model) {
  const toolCall = getToolCallObject();
  toolCall.id = functionCall.id || generateToolCallId();
  let name = functionCall.name;
  if (sessionId && model) {
    const original = getOriginalToolName(sessionId, model, functionCall.name);
    if (original) name = original;
  }
  toolCall.function.name = name;
  toolCall.function.arguments = JSON.stringify(functionCall.args);
  return toolCall;
}

// 解析并发送流式响应片段（会修改 state 并触发 callback）
// 支持 DeepSeek 格式：思维链内容通过 reasoning_content 字段输出
// 同时透传 thoughtSignature，方便客户端后续复用
function parseAndEmitStreamChunk(line, state, callback) {
  if (!line.startsWith(DATA_PREFIX)) return;
  
  try {
    const data = JSON.parse(line.slice(DATA_PREFIX_LEN));
    //console.log(JSON.stringify(data));
    const parts = data.response?.candidates?.[0]?.content?.parts;
    
    if (parts) {
      for (const part of parts) {
        if (part.thought === true) {
          // 思维链内容 - 使用 DeepSeek 格式的 reasoning_content
          // 缓存最新的签名，方便后续片段缺省时复用，并写入全局缓存
          if (part.thoughtSignature) {
            state.reasoningSignature = part.thoughtSignature;
            if (state.sessionId && state.model) {
              setReasoningSignature(state.sessionId, state.model, part.thoughtSignature);
            }
          }
          callback({
            type: 'reasoning',
            reasoning_content: part.text || '',
            thoughtSignature: part.thoughtSignature || state.reasoningSignature || null
          });
        } else if (part.text !== undefined) {
          // 普通文本内容
          callback({ type: 'text', content: part.text });
        } else if (part.functionCall) {
          // 工具调用，透传工具签名，并写入全局缓存
          const toolCall = convertToToolCall(part.functionCall, state.sessionId, state.model);
          if (part.thoughtSignature) {
            toolCall.thoughtSignature = part.thoughtSignature;
            if (state.sessionId && state.model) {
              setToolSignature(state.sessionId, state.model, part.thoughtSignature);
            }
          }
          state.toolCalls.push(toolCall);
        }
      }
    }
    
    // 响应结束时发送工具调用和使用统计
    if (data.response?.candidates?.[0]?.finishReason) {
      if (state.toolCalls.length > 0) {
        callback({ type: 'tool_calls', tool_calls: state.toolCalls });
        state.toolCalls = [];
      }
      // 提取 token 使用统计
      const usage = data.response?.usageMetadata;
      if (usage) {
        callback({
          type: 'usage',
          usage: {
            prompt_tokens: usage.promptTokenCount || 0,
            completion_tokens: usage.candidatesTokenCount || 0,
            total_tokens: usage.totalTokenCount || 0
          }
        });
      }
    }
  } catch (e) {
    // 忽略 JSON 解析错误
  }
}

// ==================== 导出函数 ====================

export async function generateAssistantResponse(requestBody, token, callback) {
  
  const headers = buildHeaders(token);
  // 在 state 中临时缓存思维链签名，供流式多片段复用，并携带 session 与 model 信息以写入全局缓存
  const state = {
    toolCalls: [],
    reasoningSignature: null,
    sessionId: requestBody.request?.sessionId,
    model: requestBody.model
  };
  const lineBuffer = getLineBuffer(); // 从对象池获取
  
  const processChunk = (chunk) => {
    const lines = lineBuffer.append(chunk);
    for (let i = 0; i < lines.length; i++) {
      parseAndEmitStreamChunk(lines[i], state, callback);
    }
  };
  
  try {
    if (useAxios) {
      const response = await httpStreamRequest({
        method: 'POST',
        url: config.api.url,
        headers,
        data: requestBody
      });
      
      // 使用 Buffer 直接处理，避免 toString 的内存分配
      response.data.on('data', chunk => {
        processChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      });
      
      await new Promise((resolve, reject) => {
        response.data.on('end', () => {
          releaseLineBuffer(lineBuffer); // 归还到对象池
          resolve();
        });
        response.data.on('error', reject);
      });
    } else {
      const streamResponse = requester.antigravity_fetchStream(config.api.url, buildRequesterConfig(headers, requestBody));
      let errorBody = '';
      let statusCode = null;

      await new Promise((resolve, reject) => {
        streamResponse
          .onStart(({ status }) => { statusCode = status; })
          .onData((chunk) => {
            if (statusCode !== 200) {
              errorBody += chunk;
            } else {
              processChunk(chunk);
            }
          })
          .onEnd(() => {
            releaseLineBuffer(lineBuffer); // 归还到对象池
            if (statusCode !== 200) {
              reject({ status: statusCode, message: errorBody });
            } else {
              resolve();
            }
          })
          .onError(reject);
      });
    }
  } catch (error) {
    releaseLineBuffer(lineBuffer); // 确保归还
    await handleApiError(error, token);
  }
}

// 内部工具：从远端拉取完整模型原始数据
async function fetchRawModels(headers, token) {
  try {
    if (useAxios) {
      const response = await httpRequest({
        method: 'POST',
        url: config.api.modelsUrl,
        headers,
        data: {}
      });
      return response.data;
    }
    const response = await requester.antigravity_fetch(config.api.modelsUrl, buildRequesterConfig(headers, {}));
    if (response.status !== 200) {
      const errorBody = await response.text();
      throw { status: response.status, message: errorBody };
    }
    return await response.json();
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
  
  const headers = buildHeaders(token);
  let data;
  
  try {
    if (useAxios) {
      data = (await httpRequest({
        method: 'POST',
        url: config.api.noStreamUrl,
        headers,
        data: requestBody
      })).data;
    } else {
      const response = await requester.antigravity_fetch(config.api.noStreamUrl, buildRequesterConfig(headers, requestBody));
      if (response.status !== 200) {
        const errorBody = await response.text();
        throw { status: response.status, message: errorBody };
      }
      data = await response.json();
    }
  } catch (error) {
    await handleApiError(error, token);
  }
  //console.log(JSON.stringify(data));
  // 解析响应内容
  const parts = data.response?.candidates?.[0]?.content?.parts || [];
  let content = '';
  let reasoningContent = '';
  let reasoningSignature = null;
  const toolCalls = [];
  const imageUrls = [];
  
  for (const part of parts) {
    if (part.thought === true) {
      // 思维链内容 - 使用 DeepSeek 格式的 reasoning_content
      reasoningContent += part.text || '';
      if (part.thoughtSignature && !reasoningSignature) {
        reasoningSignature = part.thoughtSignature;
      }
    } else if (part.text !== undefined) {
      content += part.text;
    } else if (part.functionCall) {
      const toolCall = convertToToolCall(part.functionCall, requestBody.request?.sessionId, requestBody.model);
      if (part.thoughtSignature) {
        toolCall.thoughtSignature = part.thoughtSignature;
      }
      toolCalls.push(toolCall);
    } else if (part.inlineData) {
      // 保存图片到本地并获取 URL
      const imageUrl = saveBase64Image(part.inlineData.data, part.inlineData.mimeType);
      imageUrls.push(imageUrl);
    }
  }
  
  // 提取 token 使用统计
  const usage = data.response?.usageMetadata;
  const usageData = usage ? {
    prompt_tokens: usage.promptTokenCount || 0,
    completion_tokens: usage.candidatesTokenCount || 0,
    total_tokens: usage.totalTokenCount || 0
  } : null;
  
  // 将新的签名写入全局缓存（按 sessionId + model），供后续请求兜底使用
  const sessionId = requestBody.request?.sessionId;
  const model = requestBody.model;
  if (sessionId && model) {
    if (reasoningSignature) {
      setReasoningSignature(sessionId, model, reasoningSignature);
    }
    // 工具签名：取第一个带 thoughtSignature 的工具作为缓存源
    const toolSig = toolCalls.find(tc => tc.thoughtSignature)?.thoughtSignature;
    if (toolSig) {
      setToolSignature(sessionId, model, toolSig);
    }
  }

  // 生图模型：转换为 markdown 格式
  if (imageUrls.length > 0) {
    let markdown = content ? content + '\n\n' : '';
    markdown += imageUrls.map(url => `![image](${url})`).join('\n\n');
    return { content: markdown, reasoningContent: reasoningContent || null, reasoningSignature, toolCalls, usage: usageData };
  }
  
  return { content, reasoningContent: reasoningContent || null, reasoningSignature, toolCalls, usage: usageData };
}

export async function generateImageForSD(requestBody, token) {
  const headers = buildHeaders(token);
  let data;
  //console.log(JSON.stringify(requestBody,null,2));
  
  try {
    if (useAxios) {
      data = (await httpRequest({
        method: 'POST',
        url: config.api.noStreamUrl,
        headers,
        data: requestBody
      })).data;
    } else {
      const response = await requester.antigravity_fetch(config.api.noStreamUrl, buildRequesterConfig(headers, requestBody));
      if (response.status !== 200) {
        const errorBody = await response.text();
        throw { status: response.status, message: errorBody };
      }
      data = await response.json();
    }
  } catch (error) {
    await handleApiError(error, token);
  }
  
  const parts = data.response?.candidates?.[0]?.content?.parts || [];
  const images = parts.filter(p => p.inlineData).map(p => p.inlineData.data);
  
  return images;
}

export function closeRequester() {
  if (requester) requester.close();
}

// 导出内存清理注册函数（供外部调用）
export { registerMemoryCleanup };
