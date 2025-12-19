import express from 'express';
import cors from 'cors';
import path from 'path';
import { generateAssistantResponse, generateAssistantResponseNoStream, getAvailableModels, generateImageForSD, closeRequester } from '../api/client.js';
import { generateRequestBody, generateGeminiRequestBody, generateClaudeRequestBody, prepareImageRequest } from '../utils/utils.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import tokenManager from '../auth/token_manager.js';
import adminRouter from '../routes/admin.js';
import sdRouter from '../routes/sd.js';
import memoryManager, { registerMemoryPoolCleanup } from '../utils/memoryManager.js';
import { getPublicDir, getRelativePath } from '../utils/paths.js';
import { DEFAULT_HEARTBEAT_INTERVAL, MEMORY_CHECK_INTERVAL } from '../constants/index.js';
import { buildOpenAIErrorPayload, errorHandler, ValidationError } from '../utils/errors.js';

const publicDir = getPublicDir();

logger.info(`静态文件目录: ${getRelativePath(publicDir)}`);

const app = express();

// ==================== 通用重试工具（处理 429） ====================
const with429Retry = async (fn, maxRetries, loggerPrefix = '') => {
  const retries = Number.isFinite(maxRetries) && maxRetries > 0 ? Math.floor(maxRetries) : 0;
  let attempt = 0;
  // 首次执行 + 最多 retries 次重试
  while (true) {
    try {
      return await fn(attempt);
    } catch (error) {
      const status = Number(error.status || error.response?.status);
      if (status === 429 && attempt < retries) {
        const nextAttempt = attempt + 1;
        logger.warn(`${loggerPrefix}收到 429，正在进行第 ${nextAttempt} 次重试（共 ${retries} 次）`);
        attempt = nextAttempt;
        continue;
      }
      throw error;
    }
  }
};

// ==================== 心跳机制（防止 CF 超时） ====================
const HEARTBEAT_INTERVAL = config.server.heartbeatInterval || DEFAULT_HEARTBEAT_INTERVAL;
const SSE_HEARTBEAT = Buffer.from(': heartbeat\n\n');

// 创建心跳定时器
const createHeartbeat = (res) => {
  const timer = setInterval(() => {
    if (!res.writableEnded) {
      res.write(SSE_HEARTBEAT);
    } else {
      clearInterval(timer);
    }
  }, HEARTBEAT_INTERVAL);
  
  // 响应结束时清理
  res.on('close', () => clearInterval(timer));
  res.on('finish', () => clearInterval(timer));
  
  return timer;
};

// 预编译的常量字符串（避免重复创建）
const SSE_PREFIX = Buffer.from('data: ');
const SSE_SUFFIX = Buffer.from('\n\n');
const SSE_DONE = Buffer.from('data: [DONE]\n\n');

// 工具函数：生成响应元数据
const createResponseMeta = () => ({
  id: `chatcmpl-${Date.now()}`,
  created: Math.floor(Date.now() / 1000)
});

// 工具函数：设置流式响应头
const setStreamHeaders = (res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 禁用 nginx 缓冲
};

// 工具函数：构建流式数据块（使用动态对象池减少 GC）
// 支持 DeepSeek 格式的 reasoning_content
const chunkPool = [];
const getChunkObject = () => chunkPool.pop() || { choices: [{ index: 0, delta: {}, finish_reason: null }] };
const releaseChunkObject = (obj) => {
  const maxSize = memoryManager.getPoolSizes().chunk;
  if (chunkPool.length < maxSize) chunkPool.push(obj);
};

// 注册内存清理回调（使用统一工具收缩对象池）
registerMemoryPoolCleanup(chunkPool, () => memoryManager.getPoolSizes().chunk);

// 启动内存管理器
memoryManager.start(MEMORY_CHECK_INTERVAL);

const createStreamChunk = (id, created, model, delta, finish_reason = null) => {
  const chunk = getChunkObject();
  chunk.id = id;
  chunk.object = 'chat.completion.chunk';
  chunk.created = created;
  chunk.model = model;
  chunk.choices[0].delta = delta;
  chunk.choices[0].finish_reason = finish_reason;
  return chunk;
};

// 工具函数：零拷贝写入流式数据
const writeStreamData = (res, data) => {
  const json = JSON.stringify(data);
  res.write(SSE_PREFIX);
  res.write(json);
  res.write(SSE_SUFFIX);
};

// 工具函数：结束流式响应
const endStream = (res) => {
  if (res.writableEnded) return;
  res.write(SSE_DONE);
  res.end();
};


// Gemini 兼容错误响应构造
const buildGeminiErrorPayload = (error, statusCode) => {
  // 尝试解析原始错误信息
  let message = error.message || 'Internal server error';
  if (error.isUpstreamApiError && error.rawBody) {
    try {
      const raw = typeof error.rawBody === 'string' ? JSON.parse(error.rawBody) : error.rawBody;
      message = raw.error?.message || raw.message || message;
    } catch {}
  }

  return {
    error: {
      code: statusCode,
      message: message,
      status: "INTERNAL" // 简单映射，实际可根据 statusCode 细化
    }
  };
};

// Gemini 响应构建工具
const createGeminiResponse = (content, reasoning, toolCalls, finishReason, usage) => {
  const parts = [];
  if (reasoning) {
    parts.push({ text: reasoning, thought: true });
  }
  if (content) {
    parts.push({ text: content });
  }
  if (toolCalls && toolCalls.length > 0) {
    toolCalls.forEach(tc => {
      try {
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments)
          }
        });
      } catch (e) {
        // 忽略解析错误
      }
    });
  }

  const response = {
    candidates: [{
      content: {
        parts: parts,
        role: "model"
      },
      finishReason: finishReason || "STOP",
      index: 0
    }]
  };

  if (usage) {
    response.usageMetadata = {
      promptTokenCount: usage.prompt_tokens,
      candidatesTokenCount: usage.completion_tokens,
      totalTokenCount: usage.total_tokens
    };
  }
  
  return response;
};

app.use(cors());
app.use(express.json({ limit: config.security.maxRequestSize }));

// 静态文件服务
app.use('/images', express.static(path.join(publicDir, 'images')));
app.use(express.static(publicDir));

// 管理路由
app.use('/admin', adminRouter);

// 使用统一错误处理中间件
app.use(errorHandler);

app.use((req, res, next) => {
  const ignorePaths = ['/images', '/favicon.ico', '/.well-known', '/sdapi/v1/options', '/sdapi/v1/samplers', '/sdapi/v1/schedulers', '/sdapi/v1/upscalers', '/sdapi/v1/latent-upscale-modes', '/sdapi/v1/sd-vae', '/sdapi/v1/sd-modules'];
  if (!ignorePaths.some(path => req.path.startsWith(path))) {
    const start = Date.now();
    res.on('finish', () => {
      logger.request(req.method, req.path, res.statusCode, Date.now() - start);
    });
  }
  next();
});
app.use('/sdapi/v1', sdRouter);

app.use((req, res, next) => {
  if (req.path.startsWith('/v1/')) {
    const apiKey = config.security?.apiKey;
    if (apiKey) {
      const authHeader = req.headers.authorization || req.headers['x-api-key'];
      const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      if (providedKey !== apiKey) {
        logger.warn(`API Key 验证失败: ${req.method} ${req.path} (提供的Key: ${providedKey ? providedKey.substring(0, 10) + '...' : '无'})`);
        return res.status(401).json({ error: 'Invalid API Key' });
      }
    }
  }
  next();
});

app.get('/v1/models', async (req, res) => {
  try {
    const models = await getAvailableModels();
    res.json(models);
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 内存监控端点
app.get('/v1/memory', (req, res) => {
  const usage = process.memoryUsage();
  res.json({
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    rss: usage.rss,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    pressure: memoryManager.getCurrentPressure(),
    poolSizes: memoryManager.getPoolSizes(),
    chunkPoolSize: chunkPool.length
  });
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});



app.post('/v1/chat/completions', async (req, res) => {
  const { messages, model, stream = false, tools, ...params} = req.body;
  try {
    if (!messages) {
      return res.status(400).json({ error: 'messages is required' });
    }
    const token = await tokenManager.getToken();
    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }
    const isImageModel = model.includes('-image');
    const requestBody = generateRequestBody(messages, model, params, tools, token);
    if (isImageModel) {
      prepareImageRequest(requestBody);
    }
    //console.log(JSON.stringify(requestBody,null,2))
    
    const { id, created } = createResponseMeta();
    const maxRetries = Number(config.retryTimes || 0);
    const safeRetries = maxRetries > 0 ? Math.floor(maxRetries) : 0;
    
    if (stream) {
      setStreamHeaders(res);
      
      // 启动心跳，防止 Cloudflare 超时断连
      const heartbeatTimer = createHeartbeat(res);

      try {
        if (isImageModel) {
          const { content, usage } = await with429Retry(
            () => generateAssistantResponseNoStream(requestBody, token),
            safeRetries,
            'chat.stream.image '
          );
          writeStreamData(res, createStreamChunk(id, created, model, { content }));
          writeStreamData(res, { ...createStreamChunk(id, created, model, {}, 'stop'), usage });
        } else {
          let hasToolCall = false;
          let usageData = null;

          await with429Retry(
            () => generateAssistantResponse(requestBody, token, (data) => {
              if (data.type === 'usage') {
                usageData = data.usage;
              } else if (data.type === 'reasoning') {
                const delta = { reasoning_content: data.reasoning_content };
                if (data.thoughtSignature && config.passSignatureToClient) {
                  delta.thoughtSignature = data.thoughtSignature;
                }
                writeStreamData(res, createStreamChunk(id, created, model, delta));
              } else if (data.type === 'tool_calls') {
                hasToolCall = true;
                // 根据配置决定是否透传工具调用中的签名
                const toolCallsWithIndex = data.tool_calls.map((toolCall, index) => {
                  if (config.passSignatureToClient) {
                    return { index, ...toolCall };
                  } else {
                    const { thoughtSignature, ...rest } = toolCall;
                    return { index, ...rest };
                  }
                });
                const delta = { tool_calls: toolCallsWithIndex };
                writeStreamData(res, createStreamChunk(id, created, model, delta));
              } else {
                const delta = { content: data.content };
                writeStreamData(res, createStreamChunk(id, created, model, delta));
              }
            }),
            safeRetries,
            'chat.stream '
          );

          writeStreamData(res, { ...createStreamChunk(id, created, model, {}, hasToolCall ? 'tool_calls' : 'stop'), usage: usageData });
        }

        clearInterval(heartbeatTimer);
        endStream(res);
      } catch (error) {
        clearInterval(heartbeatTimer);
        throw error;
      }
    } else {
      // 非流式请求：设置较长超时，避免大模型响应超时
      req.setTimeout(0); // 禁用请求超时
      res.setTimeout(0); // 禁用响应超时
      
      const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        () => generateAssistantResponseNoStream(requestBody, token),
        safeRetries,
        'chat.no_stream '
      );
      // DeepSeek 格式：reasoning_content 在 content 之前
      const message = { role: 'assistant' };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      if (reasoningSignature && config.passSignatureToClient) message.thoughtSignature = reasoningSignature;
      message.content = content;
      if (toolCalls.length > 0) {
        // 根据配置决定是否透传工具调用中的签名
        if (config.passSignatureToClient) {
          message.tool_calls = toolCalls;
        } else {
          message.tool_calls = toolCalls.map(({ thoughtSignature, ...rest }) => rest);
        }
      }
      
      // 使用预构建的响应对象，减少内存分配
      const response = {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
        }],
        usage
      };
      
      res.json(response);
    }
  } catch (error) {
    logger.error('生成响应失败:', error.message);
    // 如果已经开始写响应，就不再追加错误内容，避免协议冲突
    if (res.headersSent) {
      return;
    }

    // OpenAI 兼容错误返回：HTTP 状态码 + { error: { message, type, code } }
    const statusCode = Number(error.status) || 500;
    const errorPayload = buildOpenAIErrorPayload(error, statusCode);
    return res.status(statusCode).json(errorPayload);
  }
});

// Gemini 模型列表格式转换
const convertToGeminiModelList = (openaiModels) => {
  const models = openaiModels.data.map(model => ({
    name: `models/${model.id}`,
    version: "001",
    displayName: model.id,
    description: "Imported model",
    inputTokenLimit: 32768, // 默认值
    outputTokenLimit: 8192, // 默认值
    supportedGenerationMethods: ["generateContent", "countTokens"],
    temperature: 0.9,
    topP: 1.0,
    topK: 40
  }));
  return { models };
};

// Gemini API 路由
app.get('/v1beta/models', async (req, res) => {
  try {
    const openaiModels = await getAvailableModels();
    const geminiModels = convertToGeminiModelList(openaiModels);
    res.json(geminiModels);
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    res.status(500).json({ error: { code: 500, message: error.message, status: "INTERNAL" } });
  }
});

app.get('/v1beta/models/:model', async (req, res) => {
  try {
    const modelId = req.params.model.replace(/^models\//, '');
    const openaiModels = await getAvailableModels();
    const model = openaiModels.data.find(m => m.id === modelId);
    
    if (model) {
      const geminiModel = {
        name: `models/${model.id}`,
        version: "001",
        displayName: model.id,
        description: "Imported model",
        inputTokenLimit: 32768,
        outputTokenLimit: 8192,
        supportedGenerationMethods: ["generateContent", "countTokens"],
        temperature: 0.9,
        topP: 1.0,
        topK: 40
      };
      res.json(geminiModel);
    } else {
      res.status(404).json({ error: { code: 404, message: `Model ${modelId} not found`, status: "NOT_FOUND" } });
    }
  } catch (error) {
    logger.error('获取模型详情失败:', error.message);
    res.status(500).json({ error: { code: 500, message: error.message, status: "INTERNAL" } });
  }
});

const handleGeminiRequest = async (req, res, modelName, isStream) => {
  try {
    const token = await tokenManager.getToken();
    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }

    const requestBody = generateGeminiRequestBody(req.body, modelName, token);
    const maxRetries = Number(config.retryTimes || 0);
    const safeRetries = maxRetries > 0 ? Math.floor(maxRetries) : 0;

    if (isStream) {
      setStreamHeaders(res);
      const heartbeatTimer = createHeartbeat(res);

      try {
        let usageData = null;
        let hasToolCall = false;

        await with429Retry(
          () => generateAssistantResponse(requestBody, token, (data) => {
            if (data.type === 'usage') {
              usageData = data.usage;
            } else if (data.type === 'reasoning') {
              // Gemini 思考内容
              const chunk = createGeminiResponse(null, data.reasoning_content, null, null, null);
              writeStreamData(res, chunk);
            } else if (data.type === 'tool_calls') {
              hasToolCall = true;
              // Gemini 工具调用
              const chunk = createGeminiResponse(null, null, data.tool_calls, null, null);
              writeStreamData(res, chunk);
            } else {
              // 普通文本
              const chunk = createGeminiResponse(data.content, null, null, null, null);
              writeStreamData(res, chunk);
            }
          }),
          safeRetries,
          'gemini.stream '
        );

        // 发送结束块和 usage
        const finishReason = hasToolCall ? "STOP" : "STOP"; // Gemini 工具调用也是 STOP
        const finalChunk = createGeminiResponse(null, null, null, finishReason, usageData);
        writeStreamData(res, finalChunk);

        clearInterval(heartbeatTimer);
        endStream(res);
      } catch (error) {
        clearInterval(heartbeatTimer);
        throw error;
      }
    } else {
      // 非流式
      req.setTimeout(0);
      res.setTimeout(0);

      const { content, reasoningContent, toolCalls, usage } = await with429Retry(
        () => generateAssistantResponseNoStream(requestBody, token),
        safeRetries,
        'gemini.no_stream '
      );

      const finishReason = toolCalls.length > 0 ? "STOP" : "STOP";
      const response = createGeminiResponse(content, reasoningContent, toolCalls, finishReason, usage);
      res.json(response);
    }
  } catch (error) {
    logger.error('Gemini 请求失败:', error.message);
    if (res.headersSent) return;

    const statusCode = Number(error.status) || 500;
    const errorPayload = buildGeminiErrorPayload(error, statusCode);
    res.status(statusCode).json(errorPayload);
  }
};

app.post('/v1beta/models/:model\\:streamGenerateContent', (req, res) => {
  const modelName = req.params.model;
  handleGeminiRequest(req, res, modelName, true);
});

app.post('/v1beta/models/:model\\:generateContent', (req, res) => {
  const modelName = req.params.model;
  const isStream = req.query.alt === 'sse';
  handleGeminiRequest(req, res, modelName, isStream);
});

// ==================== Claude API ====================

// Claude 错误响应构造
const buildClaudeErrorPayload = (error, statusCode) => {
  let message = error.message || 'Internal server error';
  if (error.isUpstreamApiError && error.rawBody) {
    try {
      const raw = typeof error.rawBody === 'string' ? JSON.parse(error.rawBody) : error.rawBody;
      message = raw.error?.message || raw.message || message;
    } catch {}
  }

  return {
    type: "error",
    error: {
      type: statusCode === 401 ? "authentication_error" :
            statusCode === 429 ? "rate_limit_error" :
            statusCode === 400 ? "invalid_request_error" :
            "api_error",
      message: message
    }
  };
};

// Claude 流式响应工具
const createClaudeStreamEvent = (eventType, data) => {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
};

// Claude 非流式响应构建
const createClaudeResponse = (id, model, content, reasoning, toolCalls, stopReason, usage) => {
  const contentBlocks = [];
  
  // 思维链内容（如果有）- Claude 格式用 thinking 类型
  if (reasoning) {
    contentBlocks.push({
      type: "thinking",
      thinking: reasoning
    });
  }
  
  // 文本内容
  if (content) {
    contentBlocks.push({
      type: "text",
      text: content
    });
  }
  
  // 工具调用
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      try {
        contentBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments)
        });
      } catch (e) {
        // 解析失败时传入空对象
        contentBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: {}
        });
      }
    }
  }

  return {
    id: id,
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model: model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usage ? {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0
    } : { input_tokens: 0, output_tokens: 0 }
  };
};

// Claude API 处理函数
const handleClaudeRequest = async (req, res, isStream) => {
  const { messages, model, system, tools, max_tokens, temperature, top_p, top_k, ...otherParams } = req.body;
  
  try {
    if (!messages) {
      return res.status(400).json(buildClaudeErrorPayload({ message: 'messages is required' }, 400));
    }
    
    const token = await tokenManager.getToken();
    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }
    
    // 构建参数
    const parameters = {
      max_tokens: max_tokens || config.defaults.max_tokens,
      temperature: temperature ?? config.defaults.temperature,
      top_p: top_p ?? config.defaults.top_p,
      top_k: top_k ?? config.defaults.top_k,
      ...otherParams
    };
    
    const requestBody = generateClaudeRequestBody(messages, model, parameters, tools, system, token);
    
    const msgId = `msg_${Date.now()}`;
    const maxRetries = Number(config.retryTimes || 0);
    const safeRetries = maxRetries > 0 ? Math.floor(maxRetries) : 0;
    
    if (isStream) {
      setStreamHeaders(res);
      const heartbeatTimer = createHeartbeat(res);
      
      try {
        let contentIndex = 0;
        let usageData = null;
        let hasToolCall = false;
        let currentBlockType = null;
        let reasoningSent = false;
        
        // 发送 message_start
        res.write(createClaudeStreamEvent('message_start', {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            content: [],
            model: model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        }));
        
        await with429Retry(
          () => generateAssistantResponse(requestBody, token, (data) => {
            if (data.type === 'usage') {
              usageData = data.usage;
            } else if (data.type === 'reasoning') {
              // 思维链内容 - 使用 thinking 类型
              if (!reasoningSent) {
                // 开始思维块
                res.write(createClaudeStreamEvent('content_block_start', {
                  type: "content_block_start",
                  index: contentIndex,
                  content_block: { type: "thinking", thinking: "" }
                }));
                currentBlockType = 'thinking';
                reasoningSent = true;
              }
              // 发送思维增量
              res.write(createClaudeStreamEvent('content_block_delta', {
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "thinking_delta", thinking: data.reasoning_content || '' }
              }));
            } else if (data.type === 'tool_calls') {
              hasToolCall = true;
              // 结束之前的块（如果有）
              if (currentBlockType) {
                res.write(createClaudeStreamEvent('content_block_stop', {
                  type: "content_block_stop",
                  index: contentIndex
                }));
                contentIndex++;
              }
              // 工具调用
              for (const tc of data.tool_calls) {
                try {
                  const inputObj = JSON.parse(tc.function.arguments);
                  res.write(createClaudeStreamEvent('content_block_start', {
                    type: "content_block_start",
                    index: contentIndex,
                    content_block: { type: "tool_use", id: tc.id, name: tc.function.name, input: {} }
                  }));
                  // 发送 input 增量
                  res.write(createClaudeStreamEvent('content_block_delta', {
                    type: "content_block_delta",
                    index: contentIndex,
                    delta: { type: "input_json_delta", partial_json: JSON.stringify(inputObj) }
                  }));
                  res.write(createClaudeStreamEvent('content_block_stop', {
                    type: "content_block_stop",
                    index: contentIndex
                  }));
                  contentIndex++;
                } catch (e) {
                  // 解析失败，跳过
                }
              }
              currentBlockType = null;
            } else {
              // 普通文本内容
              if (currentBlockType === 'thinking') {
                // 结束思维块
                res.write(createClaudeStreamEvent('content_block_stop', {
                  type: "content_block_stop",
                  index: contentIndex
                }));
                contentIndex++;
                currentBlockType = null;
              }
              if (currentBlockType !== 'text') {
                // 开始文本块
                res.write(createClaudeStreamEvent('content_block_start', {
                  type: "content_block_start",
                  index: contentIndex,
                  content_block: { type: "text", text: "" }
                }));
                currentBlockType = 'text';
              }
              // 发送文本增量
              res.write(createClaudeStreamEvent('content_block_delta', {
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "text_delta", text: data.content || '' }
              }));
            }
          }),
          safeRetries,
          'claude.stream '
        );
        
        // 结束最后一个内容块
        if (currentBlockType) {
          res.write(createClaudeStreamEvent('content_block_stop', {
            type: "content_block_stop",
            index: contentIndex
          }));
        }
        
        // 发送 message_delta
        const stopReason = hasToolCall ? 'tool_use' : 'end_turn';
        res.write(createClaudeStreamEvent('message_delta', {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: usageData ? { output_tokens: usageData.completion_tokens || 0 } : { output_tokens: 0 }
        }));
        
        // 发送 message_stop
        res.write(createClaudeStreamEvent('message_stop', {
          type: "message_stop"
        }));
        
        clearInterval(heartbeatTimer);
        res.end();
      } catch (error) {
        clearInterval(heartbeatTimer);
        throw error;
      }
    } else {
      // 非流式请求
      req.setTimeout(0);
      res.setTimeout(0);
      
      const { content, reasoningContent, toolCalls, usage } = await with429Retry(
        () => generateAssistantResponseNoStream(requestBody, token),
        safeRetries,
        'claude.no_stream '
      );
      
      const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
      const response = createClaudeResponse(
        msgId,
        model,
        content,
        reasoningContent,
        toolCalls,
        stopReason,
        usage
      );
      
      res.json(response);
    }
  } catch (error) {
    logger.error('Claude 请求失败:', error.message);
    if (res.headersSent) return;
    
    const statusCode = Number(error.status) || 500;
    const errorPayload = buildClaudeErrorPayload(error, statusCode);
    res.status(statusCode).json(errorPayload);
  }
};

// Claude Messages API 端点
app.post('/v1/messages', (req, res) => {
  const isStream = req.body.stream === true;
  handleClaudeRequest(req, res, isStream);
});

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`服务器已启动: ${config.server.host}:${config.server.port}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    logger.error(`端口 ${config.server.port} 无权限访问`);
    process.exit(1);
  } else {
    logger.error('服务器启动失败:', error.message);
    process.exit(1);
  }
});

const shutdown = () => {
  logger.info('正在关闭服务器...');
  
  // 停止内存管理器
  memoryManager.stop();
  logger.info('已停止内存管理器');
  
  // 关闭子进程请求器
  closeRequester();
  logger.info('已关闭子进程请求器');
  
  // 清理对象池
  chunkPool.length = 0;
  logger.info('已清理对象池');
  
  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
  
  // 5秒超时强制退出
  setTimeout(() => {
    logger.warn('服务器关闭超时，强制退出');
    process.exit(0);
  }, 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 未捕获异常处理
process.on('uncaughtException', (error) => {
  logger.error('未捕获异常:', error.message);
  // 不立即退出，让当前请求完成
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的 Promise 拒绝:', reason);
});
