import axios from 'axios';
import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';
import { generateToolCallId } from '../utils/idGenerator.js';
import AntigravityRequester from '../AntigravityRequester.js';
import { saveBase64Image } from '../utils/imageStorage.js';
import logger from '../utils/logger.js';

// 请求客户端：优先使用 AntigravityRequester，失败则降级到 axios
let requester = null;
let useAxios = false;

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

function buildAxiosConfig(url, headers, body = null) {
  const axiosConfig = {
    method: 'POST',
    url,
    headers,
    timeout: config.timeout,
    proxy: config.proxy ? (() => {
      const proxyUrl = new URL(config.proxy);
      return { protocol: proxyUrl.protocol.replace(':', ''), host: proxyUrl.hostname, port: parseInt(proxyUrl.port) };
    })() : false
  };
  if (body !== null) axiosConfig.data = body;
  return axiosConfig;
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
    tokenManager.disableCurrentToken(token);
    throw new Error(`该账号没有使用权限，已自动禁用。错误详情: ${errorBody}`);
  } else if (status === 429) {
    // 其实是多次429了，那就先等会儿
    tokenManager.set429(token, errorBody);
    throw new Error(`API请求太频繁，请稍后再试。错误详情: ${errorBody}`);
  }
  
  throw new Error(`API请求失败 (${status}): ${errorBody}`);
}

// 转换 functionCall 为 OpenAI 格式
function convertToToolCall(functionCall) {
  return {
    id: functionCall.id || generateToolCallId(),
    type: 'function',
    function: {
      name: functionCall.name,
      arguments: JSON.stringify(functionCall.args)
    }
  };
}

// 解析并发送流式响应片段（会修改 state 并触发 callback）
function parseAndEmitStreamChunk(line, state, callback) {
  if (!line.startsWith('data: ')) return;
  
  try {
    const data = JSON.parse(line.slice(6));
    const parts = data.response?.candidates?.[0]?.content?.parts;
    
    if (parts) {
      for (const part of parts) {
        if (part.thought === true) {
          // 思维链内容
          if (!state.thinkingStarted) {
            callback({ type: 'thinking', content: '<think>\n' });
            state.thinkingStarted = true;
          }
          callback({ type: 'thinking', content: part.text || '' });
        } else if (part.text !== undefined) {
          // 普通文本内容
          if (state.thinkingStarted) {
            callback({ type: 'thinking', content: '\n</think>\n' });
            state.thinkingStarted = false;
          }
          callback({ type: 'text', content: part.text });
        } else if (part.functionCall) {
          // 工具调用
          state.toolCalls.push(convertToToolCall(part.functionCall));
        }
      }
    }
    
    // 响应结束时发送工具调用
    if (data.response?.candidates?.[0]?.finishReason && state.toolCalls.length > 0) {
      if (state.thinkingStarted) {
        callback({ type: 'thinking', content: '\n</think>\n' });
        state.thinkingStarted = false;
      }
      callback({ type: 'tool_calls', tool_calls: state.toolCalls });
      state.toolCalls = [];
    }
  } catch (e) {
    // 忽略 JSON 解析错误
  }
}

// ==================== 导出函数 ====================

export async function generateAssistantResponse(requestBody, token, callback, retryCount=0) {
  
  const headers = buildHeaders(token);
  const state = { thinkingStarted: false, toolCalls: [] };
  let buffer = ''; // 缓冲区：处理跨 chunk 的不完整行
  
  const processChunk = (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 保留最后一行（可能不完整）
    lines.forEach(line => parseAndEmitStreamChunk(line, state, callback));
  };

  if (retryCount) {
    logger.info(`429第${retryCount}次重试`);
  }
  
  if (useAxios) {
    try {
      const axiosConfig = { ...buildAxiosConfig(config.api.url, headers, requestBody), responseType: 'stream' };
      const response = await axios(axiosConfig);
      
      response.data.on('data', chunk => processChunk(chunk.toString()));
      await new Promise((resolve, reject) => {
        response.data.on('end', resolve);
        response.data.on('error', reject);
      });
    } catch (error) {
      // 如果是429或500，则要重试几次
      const status = error.response?.status || error.status || 'Unknown';
      if ((status == 429 || status == 500) && retryCount < config.tokenReuse.retryMaxCount) {
        logger.info(`出现错误状态码${status}，尝试重试...`);
        await new Promise(resolve => setTimeout(resolve, config.tokenReuse.retryDelay));
        await generateAssistantResponse(requestBody, token, callback, retryCount + 1);
      } else await handleApiError(error, token);
    }
  } else {
    try {
      const streamResponse = requester.antigravity_fetchStream(config.api.url, buildRequesterConfig(headers, requestBody));
      let errorBody = '';
      let statusCode = null;

      await new Promise((resolve, reject) => {
        streamResponse
          .onStart(({ status }) => { statusCode = status; })
          .onData((chunk) => statusCode !== 200 ? errorBody += chunk : processChunk(chunk))
          .onEnd(() => statusCode !== 200 ? reject({ status: statusCode, message: errorBody }) : resolve())
          .onError(reject);
      });
    } catch (error) {
      // 如果是429要重试几次
      const status = error.response?.status || error.status || 'Unknown';
      if ((status == 429 || status == 500) && retryCount < config.tokenReuse.retryMaxCount) {
        logger.info(`出现错误状态码${status}，尝试重试...`);
        await new Promise(resolve => setTimeout(resolve, config.tokenReuse.retryDelay));
        await generateAssistantResponse(requestBody, token, callback, retryCount + 1);
      } else await handleApiError(error, token);
    }
  }
}

export async function getAvailableModels() {
  const token = await tokenManager.getToken();
  if (!token) throw new Error('没有可用的token，请运行 npm run login 获取token');
  
  const headers = buildHeaders(token);
  
  try {
    let data;
    if (useAxios) {
      data = (await axios(buildAxiosConfig(config.api.modelsUrl, headers, {}))).data;
    } else {
      const response = await requester.antigravity_fetch(config.api.modelsUrl, buildRequesterConfig(headers, {}));
      if (response.status !== 200) {
        const errorBody = await response.text();
        throw { status: response.status, message: errorBody };
      }
      data = await response.json();
    }
    const modelList = Object.keys(data.models).map(id => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'google'
      }));
    modelList.push({
      id: "claude-opus-4-5",
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'google'
    })
    
    return {
      object: 'list',
      data: modelList
    };
  } catch (error) {
    await handleApiError(error, token);
  }
}

export async function generateAssistantResponseNoStream(requestBody, token) {
  
  const headers = buildHeaders(token);
  let data;
  
  try {
    if (useAxios) {
      data = (await axios(buildAxiosConfig(config.api.noStreamUrl, headers, requestBody))).data;
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
  
  // 解析响应内容
  const parts = data.response?.candidates?.[0]?.content?.parts || [];
  let content = '';
  let thinkingContent = '';
  const toolCalls = [];
  const imageUrls = [];
  
  for (const part of parts) {
    if (part.thought === true) {
      thinkingContent += part.text || '';
    } else if (part.text !== undefined) {
      content += part.text;
    } else if (part.functionCall) {
      toolCalls.push(convertToToolCall(part.functionCall));
    } else if (part.inlineData) {
      // 保存图片到本地并获取 URL
      const imageUrl = saveBase64Image(part.inlineData.data, part.inlineData.mimeType);
      imageUrls.push(imageUrl);
    }
  }
  
  // 拼接思维链标签
  if (thinkingContent) {
    content = `<think>\n${thinkingContent}\n</think>\n${content}`;
  }
  
  // 生图模型：转换为 markdown 格式
  if (imageUrls.length > 0) {
    let markdown = content ? content + '\n\n' : '';
    markdown += imageUrls.map(url => `![image](${url})`).join('\n\n');
    return { content: markdown, toolCalls };
  }
  
  return { content, toolCalls };
}

export function closeRequester() {
  if (requester) requester.close();
}
