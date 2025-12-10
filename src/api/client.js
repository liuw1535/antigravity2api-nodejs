import axios from 'axios';
import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';
import { generateToolCallId } from '../utils/idGenerator.js';
import AntigravityRequester from '../AntigravityRequester.js';
import { saveBase64Image } from '../utils/imageStorage.js';
import { buildAxiosProxyOptions } from '../utils/proxy.js';
import log from '../utils/logger.js';


// Simple hash for correlation logging
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).substring(0, 8);
}

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

// AntigravityRequester 目前不支持 SOCKS 代理，遇到 SOCKS 时强制使用 axios
if (config.proxy?.startsWith('socks')) {
  useAxios = true;
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
    ...buildAxiosProxyOptions(config.proxy)
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
async function handleApiError(error, token, requestBody = null) {
  const status = error.response?.status || error.status || 'Unknown';
  let errorBody = error.message;
  if (requestBody) {
    try {
      const logBody = JSON.parse(JSON.stringify(requestBody));
      // Sanitize logBody contents to show word count for text
      if (logBody.request?.contents) {
        logBody.request.contents.forEach(msg => {
          if (msg.role === 'user' && msg.parts) {
            msg.parts.forEach(p => {
              if (p.text && p.text.length > 100) {
                const wordCount = p.text.split(/\s+/).length;
                p.text = `[Text: ~${wordCount} words]`;
              }
            });
          }
        });
      }
      if (logBody.request?.tools) { log.error('[API Error] Tool Summary:', logBody.request.tools.map((t, i) => `[${i}] ${t.functionDeclarations?.[0]?.name || 'unknown'}`).join(', ')); log.error('[API Error] tools[7] Full Schema:', JSON.stringify(logBody.request.tools[7], null, 2)); logBody.request.tools = '<excluded>'; } log.error('[API Error] Request Body:', JSON.stringify(logBody, null, 2));
    } catch (e) { log.error('[API Error] Failed to stringify request body'); }
  }
  if (requestBody.request?.contents) { log.error('--- Request Content Indices ---'); requestBody.request.contents.forEach((msg, idx) => { const types = msg.parts?.map(p => { if (p.functionCall) return `ToolCall:${p.functionCall.name}`; if (p.functionResponse) return `ToolResp:${p.functionResponse.name}`; return 'Text'; }).join(', ') || 'Empty'; log.error(`[Index ${idx}] ${msg.role}: ${types.substring(0, 100)}`); }); log.error('-------------------------------'); }

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
    const finalError403 = new Error(`该账号没有使用权限，已自动禁用。错误详情: ${errorBody}`);
    finalError403.status = 403;
    throw finalError403;
  }

  const finalError = new Error(errorBody);
  finalError.status = status;
  throw finalError;
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
function mapFinishReason(reason) {
  if (!reason) return null;
  switch (reason) {
    case 'STOP': return 'stop';
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY':
    case 'MALICIOUS': return 'content_filter';
    case 'Recitation': return 'content_filter';
    default: return 'stop';
  }
}

function parseAndEmitStreamChunk(line, state, callback) {
  if (!line.startsWith('data: ')) return;

  try {
    const data = JSON.parse(line.slice(6));
    log.info('[LLM_RESPONSE] ' + JSON.stringify(data));
    const parts = data.response?.candidates?.[0]?.content?.parts;

    if (parts) {
      for (const part of parts) {
        if (part.thoughtSignature || part.thought_signature) {
          state.thoughtSignature = part.thoughtSignature || part.thought_signature;
        }

        if (part.thought || part.thoughtSignature || part.thought_signature) {
          log.info(`[THOUGHT DEBUG] thought=${part.thought} sig=${part.thoughtSignature || part.thought_signature} textlen=${(part.text || '').length}`);
        }
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
            callback({ type: 'thinking', content: (state.model && state.model.includes('claude') && state.thoughtSignature) ? `\n<!-- signature="${state.thoughtSignature}" -->\n</think>\n` : '\n</think>\n' });
            state.thinkingStarted = false;
          }
          // Capture text part signature if present (optional but recommended)
          const textSig = part.thoughtSignature || part.thought_signature;
          if (textSig) {
            log.info(`[SIG-TRACE] TEXT SIGNATURE from Gemini: ${textSig.substring(0, 20)}...`);
            // Store for potential use - attach to state for downstream
            state.lastTextSignature = textSig;
          }
          callback({ type: 'text', content: part.text, thought_signature: textSig });
        } else if (part.functionCall) {
          // 工具调用
          const tc = convertToToolCall(part.functionCall);
          // 尝试捕获 thoughtSignature (camelCase 或 snake_case) 并传递给下游
          if (part.thoughtSignature) {
            tc.function.thought_signature = part.thoughtSignature;
            const callHash = simpleHash(tc.function.name + tc.function.arguments);
            log.info(`[TOOL-IN] hash=${callHash} name=${tc.function.name} hasSig=true sig=${part.thoughtSignature.substring(0, 10)}...`);
          } else if (part.thought_signature) {
            tc.function.thought_signature = part.thought_signature;
            log.info(`[SIG-TRACE] RECEIVED from Gemini: toolCallId=${tc.id}, signature=${part.thought_signature.substring(0, 20)}...`);
          } else {
            const callHashNoSig = simpleHash(tc.function.name + tc.function.arguments);
            log.info(`[TOOL-IN] hash=${callHashNoSig} name=${tc.function.name} hasSig=false (parallel call)`);
          }
          state.toolCalls.push(tc);
        }
      }
    }

    // 响应结束时发送工具调用和使用统计
    if (data.response?.candidates?.[0]?.finishReason) {
      if (state.thinkingStarted) {
        callback({ type: 'thinking', content: (state.model && state.model.includes('claude') && state.thoughtSignature) ? `\n<!-- signature="${state.thoughtSignature}" -->\n</think>\n` : '\n</think>\n' });
        state.thinkingStarted = false;
      }
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
  const state = { thinkingStarted: false, toolCalls: [], model: requestBody.model || '' };
  let buffer = ''; // 缓冲区：处理跨 chunk 的不完整行

  const processChunk = (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 保留最后一行（可能不完整）
    lines.forEach(line => parseAndEmitStreamChunk(line, state, callback));
  };

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
      await handleApiError(error, token, requestBody);
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
      await handleApiError(error, token, requestBody);
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
    //console.log(JSON.stringify(data,null,2));
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
    await handleApiError(error, token, requestBody);
  }
}

export async function getModelsWithQuotas(token) {
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
  } catch (error) {
    await handleApiError(error, token, requestBody);
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
    await handleApiError(error, token, requestBody);
  }
  //console.log(JSON.stringify(data));
  // 解析响应内容
  const parts = data.response?.candidates?.[0]?.content?.parts || [];
  let content = '';
  let thinkingContent = '';
  let thinkingSignature = '';
  const toolCalls = [];
  const imageUrls = [];

  for (const part of parts) {
    if (part.thoughtSignature || part.thought_signature) {
      thinkingSignature = part.thoughtSignature || part.thought_signature;
    }

    if (part.thought || part.thoughtSignature || part.thought_signature) {
      log.info(`[THOUGHT DEBUG] thought=${part.thought} sig=${part.thoughtSignature || part.thought_signature} textlen=${(part.text || '').length}`);
    }
    if (part.thought === true) {
      thinkingContent += part.text || '';
      if (!thinkingSignature && (part.thoughtSignature || part.thought_signature)) {
        thinkingSignature = part.thoughtSignature || part.thought_signature;
      }
    } else if (part.text !== undefined) {
      content += part.text;
    } else if (part.functionCall) {
      const tc = convertToToolCall(part.functionCall);
      if (part.thoughtSignature) {
        tc.function.thought_signature = part.thoughtSignature;
      } else if (part.thought_signature) {
        tc.function.thought_signature = part.thought_signature;
      }
      toolCalls.push(tc);
    } else if (part.inlineData) {
      // 保存图片到本地并获取 URL
      const imageUrl = saveBase64Image(part.inlineData.data, part.inlineData.mimeType);
      imageUrls.push(imageUrl);
    }
  }

  // 拼接思维链标签
  if (thinkingContent) {
    const thinkTag = thinkingSignature ? `<think signature="${thinkingSignature}">` : '<think>';
    content = `${thinkTag}\n${thinkingContent}\n</think>\n${content}`;
  }



  // 提取 token 使用统计
  const usage = data.response?.usageMetadata;
  const usageData = usage ? {
    prompt_tokens: usage.promptTokenCount || 0,
    completion_tokens: usage.candidatesTokenCount || 0,
    total_tokens: usage.totalTokenCount || 0
  } : null;

  // 生图模型：转换为 markdown 格式

  let finishReason = undefined;
  if (requestBody.model && (requestBody.model.includes('claude') || requestBody.model.includes('gemini'))) {
    const rawFinishReason = data.response?.candidates?.[0]?.finishReason;
    finishReason = toolCalls.length > 0 ? 'tool_calls' : mapFinishReason(rawFinishReason);
  }
  if (imageUrls.length > 0) {
    let markdown = content ? content + '\n\n' : '';
    markdown += imageUrls.map(url => `![image](${url})`).join('\n\n');
    return { content: markdown, toolCalls, usage: usageData, finishReason };
  }

  return { content, toolCalls, usage: usageData, finishReason };
}

export async function generateImageForSD(requestBody, token) {
  const headers = buildHeaders(token);
  let data;
  //console.log(JSON.stringify(requestBody,null,2));
  
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
  
  const parts = data.response?.candidates?.[0]?.content?.parts || [];
  const images = parts.filter(p => p.inlineData).map(p => p.inlineData.data);
  
  return images;
}

export function closeRequester() {
  if (requester) requester.close();
}
