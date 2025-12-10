import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateAssistantResponse, generateAssistantResponseNoStream, getAvailableModels, generateImageForSD, closeRequester } from '../api/client.js';
import { generateRequestBody } from '../utils/utils.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import tokenManager from '../auth/token_manager.js';
import adminRouter from '../routes/admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

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
};

// 工具函数：构建流式数据块
const createStreamChunk = (id, created, model, delta, finish_reason = null) => ({
  id,
  object: 'chat.completion.chunk',
  created,
  model,
  choices: [{ index: 0, delta, finish_reason }]
});

// 工具函数：写入流式数据
const writeStreamData = (res, data) => {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

// 工具函数：结束流式响应
const endStream = (res) => {
  res.write('data: [DONE]\n\n');
  res.end();
};

app.use(express.json({ limit: config.security.maxRequestSize }));

// 静态文件服务
app.use('/images', express.static(path.join(__dirname, '../../public/images')));
app.use(express.static(path.join(__dirname, '../../public')));

// 管理路由
app.use('/admin', adminRouter);

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `请求体过大，最大支持 ${config.security.maxRequestSize}` });
  }
  next(err);
});

app.use((req, res, next) => {
  const ignorePaths = ['/images', '/favicon.ico', '/.well-known'];
  if (!ignorePaths.some(path => req.path.startsWith(path))) {
    const start = Date.now();
    res.on('finish', () => {
      logger.request(req.method, req.path, res.statusCode, Date.now() - start);
    });
  }
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith('/v1/')) {
    const apiKey = config.security?.apiKey;
    if (apiKey) {
      const authHeader = req.headers.authorization;
      const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      if (providedKey !== apiKey) {
        logger.warn(`API Key 验证失败: ${req.method} ${req.path}`);
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

// ==================== Stable Diffusion API ====================

app.get('/sdapi/v1/sd-models', async (req, res) => {
  try {
    const models = await getAvailableModels();
    const imageModels = models.data
      .filter(m => m.id.includes('-image'))
      .map(m => ({
        title: m.id,
        model_name: m.id,
        hash: null,
        sha256: null,
        filename: m.id,
        config: null
      }));
    res.json(imageModels);
  } catch (error) {
    logger.error('获取SD模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/sdapi/v1/txt2img', async (req, res) => {
  const { prompt, negative_prompt, steps, cfg_scale, width, height, seed, sampler_name } = req.body;
  
  try {
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    
    const token = await tokenManager.getToken();
    if (!token) {
      throw new Error('没有可用的token');
    }
    
    const model = 'gemini-3-pro-image';
    const messages = [{ role: 'user', content: prompt }];
    const requestBody = generateRequestBody(messages, model, {}, null, token);
    
    requestBody.request.generationConfig = { candidateCount: 1 };
    requestBody.requestType = 'image_gen';
    delete requestBody.request.systemInstruction;
    delete requestBody.request.tools;
    delete requestBody.request.toolConfig;
    
    const images = await generateImageForSD(requestBody, token);
    
    if (images.length === 0) {
      throw new Error('未生成图片');
    }
    
    res.json({
      images,
      parameters: { prompt, negative_prompt, steps, cfg_scale, width, height, seed, sampler_name },
      info: JSON.stringify({ prompt, seed: seed || -1 })
    });
  } catch (error) {
    logger.error('SD生图失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/sdapi/v1/options', (req, res) => {
  res.json({
    sd_model_checkpoint: 'gemini-3-pro-image',
    sd_vae: 'auto',
    CLIP_stop_at_last_layers: 1
  });
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
    const requestBody = await generateRequestBody(messages, model, params, tools, token);
    if (isImageModel) {
      requestBody.request.generationConfig={
        candidateCount: 1,
        // imageConfig:{
        //   aspectRatio: "1:1"
        // }
      }
      requestBody.requestType="image_gen";
      //requestBody.request.systemInstruction.parts[0].text += "现在你作为绘画模型聚焦于帮助用户生成图片";
      delete requestBody.request.systemInstruction;
      delete requestBody.request.tools;
      delete requestBody.request.toolConfig;
    }
    //console.log(JSON.stringify(requestBody,null,2))
    
    const { id, created } = createResponseMeta();
    
    if (stream) {
      setStreamHeaders(res);
      
      if (isImageModel) {
        //console.log(JSON.stringify(requestBody,null,2));
        const { content, usage } = await generateAssistantResponseNoStream(requestBody, token);
        writeStreamData(res, createStreamChunk(id, created, model, { content }));
        writeStreamData(res, { ...createStreamChunk(id, created, model, {}, 'stop'), usage });
        endStream(res);
      } else {
        let hasToolCall = false;
        let usageData = null;
        await generateAssistantResponse(requestBody, token, (data) => {
          if (data.type === 'usage') {
            usageData = data.usage;
          } else {
            const delta = data.type === 'tool_calls' 
              ? { tool_calls: data.tool_calls } 
              : { content: data.content };
            if (data.type === 'tool_calls') hasToolCall = true;
            writeStreamData(res, createStreamChunk(id, created, model, delta));
          }
        });
        writeStreamData(res, { ...createStreamChunk(id, created, model, {}, hasToolCall ? 'tool_calls' : 'stop'), usage: usageData });
        endStream(res);
      }
    } else {
      const { content, toolCalls, usage } = await generateAssistantResponseNoStream(requestBody, token);
      const message = { role: 'assistant', content };
      if (toolCalls.length > 0) message.tool_calls = toolCalls;
      
      res.json({
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
      });
    }
  } catch (error) {
    logger.error('生成响应失败:', error.message);
    if (!res.headersSent) {
      // Claude-specific: Return actual HTTP errors for API failures
      if (model && model.includes('claude') && error.status && error.status >= 400) {
        let errorJson;
        try { errorJson = JSON.parse(error.message); } catch(e) { }
        
        // Construct standard OpenAI Error format
        const errorResponse = {
            error: {
                message: errorJson?.error?.message || errorJson?.message || error.message,
                type: 'invalid_request_error',
                code: error.status,
                param: null 
            }
        };
        // If the upstream error already has the structure, try to use it? 
        // Google errors are usually { error: { code, message, status } }
        // We'll stick to a clean wrapper.
        
        if (stream) {
             // For stream, we must send an error event if possible or just end?
             // Usually streaming clients handle HTTP status on connect, but if headers not sent...
             // setHeaders was called inside 'if (stream)' block? 
             // Wait, `if (stream)` block calls `setStreamHeaders(res)`. 
             // If we are here, headers might NOT be sent if error happened in `generateAssistantResponse` (which is awaited).
             // But `generateAssistantResponse` is awaited *inside* `if (stream)`.
             // `setStreamHeaders` is called *before* await.
             // So headers ARE sent (200 OK).
             // We cannot send 400 now. We must send generic error in stream.
             // So this 400 logic only applies if `!stream` OR if headers NOT sent.
             // But the catch block checks `if (!res.headersSent)`.
             
             // If headers SENT, we fall through to existing logic (writeStreamData).
             // If headers NOT SENT, we can send 400.
             
             return res.status(error.status).json(errorResponse);
        } else {
             return res.status(error.status).json(errorResponse);
        }
      }
      const { id, created } = createResponseMeta();
      const errorContent = `错误: ${error.message}`;
      
      if (stream) {
        setStreamHeaders(res);
        writeStreamData(res, createStreamChunk(id, created, model, { content: errorContent }));
        writeStreamData(res, createStreamChunk(id, created, model, {}, 'stop'));
        endStream(res);
      } else {
        res.json({
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: errorContent },
            finish_reason: 'stop'
          }]
        });
      }
    }
  }
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
  closeRequester();
  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
