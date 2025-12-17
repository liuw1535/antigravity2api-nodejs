import config from '../config/config.js';
import tokenManager from '../auth/token_manager.js';
import { generateRequestId } from './idGenerator.js';
import os from 'os';

function extractImagesFromContent(content) {
  const result = { text: '', images: [] };

  // 如果content是字符串，直接返回
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  // 如果content是数组（multimodal格式）
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        // 提取base64图片数据
        const imageUrl = item.image_url?.url || '';

        // 匹配 data:image/{format};base64,{data} 格式
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const format = match[1]; // 例如 png, jpeg, jpg
          const base64Data = match[2];
          result.images.push({
            inlineData: {
              mimeType: `image/${format}`,
              data: base64Data
            }
          })
        }
      }
    }
  }

  return result;
}
function handleUserMessage(extracted, antigravityMessages){
  antigravityMessages.push({
    role: "user",
    parts: [
      {
        text: extracted.text
      },
      ...extracted.images
    ]
  })
}
function handleAssistantMessage(message, antigravityMessages){
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const hasContent = message.content && message.content.trim() !== '';
  
  const antigravityTools = hasToolCalls ? message.tool_calls.map(toolCall => ({
    functionCall: {
      id: toolCall.id,
      name: toolCall.function.name,
      args: {
        query: toolCall.function.arguments
      }
    }
  })) : [];
  
  if (lastMessage?.role === "model" && hasToolCalls && !hasContent){
    lastMessage.parts.push(...antigravityTools)
  }else{
    const parts = [];
    if (hasContent) parts.push({ text: message.content.trimEnd() });
    parts.push(...antigravityTools);
    
    antigravityMessages.push({
      role: "model",
      parts
    })
  }
}
function handleToolCall(message, antigravityMessages){
  // 从之前的 model 消息中找到对应的 functionCall name
  let functionName = '';
  for (let i = antigravityMessages.length - 1; i >= 0; i--) {
    if (antigravityMessages[i].role === 'model') {
      const parts = antigravityMessages[i].parts;
      for (const part of parts) {
        if (part.functionCall && part.functionCall.id === message.tool_call_id) {
          functionName = part.functionCall.name;
          break;
        }
      }
      if (functionName) break;
    }
  }
  
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const functionResponse = {
    functionResponse: {
      id: message.tool_call_id,
      name: functionName,
      response: {
        output: message.content
      }
    }
  };
  
  // 如果上一条消息是 user 且包含 functionResponse，则合并
  if (lastMessage?.role === "user" && lastMessage.parts.some(p => p.functionResponse)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({
      role: "user",
      parts: [functionResponse]
    });
  }
}
function openaiMessageToAntigravity(openaiMessages){
  const antigravityMessages = [];
  for (const message of openaiMessages) {
    if (message.role === "user") {
      const extracted = extractImagesFromContent(message.content);
      handleUserMessage(extracted, antigravityMessages);
    } else if (message.role === "system") {
      // 中间的 system 消息作为 user 处理（开头的 system 已在 generateRequestBody 中过滤）
      const extracted = extractImagesFromContent(message.content);
      handleUserMessage(extracted, antigravityMessages);
    } else if (message.role === "assistant") {
      handleAssistantMessage(message, antigravityMessages);
    } else if (message.role === "tool") {
      handleToolCall(message, antigravityMessages);
    }
  }
  
  return antigravityMessages;
}

/**
 * 从 OpenAI 消息中提取并合并 system 指令
 * 规则：
 * 1. SYSTEM_INSTRUCTION 作为基础 system，可为空
 * 2. 保留用户首条 system 信息，合并在基础 system 后面
 * 3. 如果连续多条 system，合并成一条 system
 * 4. 避免把真正的 system 重复作为 user 发送
 */
function extractSystemInstruction(openaiMessages) {
  const baseSystem = config.systemInstruction || '';
  
  // 收集开头连续的 system 消息
  const systemTexts = [];
  for (const message of openaiMessages) {
    if (message.role === 'system') {
      const content = typeof message.content === 'string'
        ? message.content
        : (Array.isArray(message.content)
            ? message.content.filter(item => item.type === 'text').map(item => item.text).join('')
            : '');
      if (content.trim()) {
        systemTexts.push(content.trim());
      }
    } else {
      // 遇到非 system 消息就停止收集
      break;
    }
  }
  
  // 合并：基础 system + 用户的 system 消息
  const parts = [];
  if (baseSystem.trim()) {
    parts.push(baseSystem.trim());
  }
  if (systemTexts.length > 0) {
    parts.push(systemTexts.join('\n\n'));
  }
  
  return parts.join('\n\n');
}
// reasoning_effort 到 thinkingBudget 的映射
const REASONING_EFFORT_MAP = {
  'low': 1024,
  'medium': 16000,
  'high': 32000
};

function generateGenerationConfig(parameters, enableThinking, actualModelName){
  // 获取思考预算：
  // 1. 优先使用 thinking_budget（直接数值）
  // 2. 其次使用 reasoning_effort（OpenAI 格式：low/medium/high）
  // 3. 最后使用配置默认值或硬编码默认值
  const defaultThinkingBudget = config.defaults.thinking_budget ?? 1024;
  
  let thinkingBudget = 0;
  if (enableThinking) {
    if (parameters.thinking_budget !== undefined) {
      thinkingBudget = parameters.thinking_budget;
    } else if (parameters.reasoning_effort !== undefined) {
      thinkingBudget = REASONING_EFFORT_MAP[parameters.reasoning_effort] ?? defaultThinkingBudget;
    } else {
      thinkingBudget = defaultThinkingBudget;
    }
  }
  
  const generationConfig = {
    topP: parameters.top_p ?? config.defaults.top_p,
    topK: parameters.top_k ?? config.defaults.top_k,
    temperature: parameters.temperature ?? config.defaults.temperature,
    candidateCount: 1,
    maxOutputTokens: parameters.max_tokens ?? config.defaults.max_tokens,
    stopSequences: [
      "<|user|>",
      "<|bot|>",
      "<|context_request|>",
      "<|endoftext|>",
      "<|end_of_turn|>"
    ],
    thinkingConfig: {
      includeThoughts: enableThinking,
      thinkingBudget: thinkingBudget
    }
  }
  if (enableThinking && actualModelName.includes("claude")){
    delete generationConfig.topP;
  }
  return generationConfig
}
// 不被 Google 工具参数 Schema 支持的字段，在这里统一过滤掉
// 包括：
// - JSON Schema 的元信息字段：$schema, additionalProperties
// - 长度/数量约束：minLength, maxLength, minItems, maxItems, uniqueItems（不必传给后端）
// - 严格上下界 / 常量：exclusiveMaximum, exclusiveMinimum, const（Google Schema 不支持）
// - 组合约束：anyOf/oneOf/allOf 以及其非标准写法 any_of/one_of/all_of（为避免上游实现差异，这里一律去掉）
const EXCLUDED_KEYS = new Set([
  '$schema',
  'additionalProperties',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'any_of',
  'one_of',
  'all_of'
]);

function cleanParameters(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  
  const cleaned = Array.isArray(obj) ? [] : {};
  
  for (const [key, value] of Object.entries(obj)) {
    if (EXCLUDED_KEYS.has(key)) continue;
    const cleanedValue = (value && typeof value === 'object') ? cleanParameters(value) : value;
    cleaned[key] = cleanedValue;
  }
  
  return cleaned;
}

function convertOpenAIToolsToAntigravity(openaiTools){
  if (!openaiTools || openaiTools.length === 0) return [];
  return openaiTools.map((tool)=>{
    // 先清洗一遍参数，过滤/规范化不兼容字段
    const rawParams = tool.function?.parameters || {};
    const cleanedParams = cleanParameters(rawParams) || {};

    // 确保顶层是一个合法的 JSON Schema 对象
    // 如果用户没显式指定 type，则默认按 OpenAI 习惯设为 object
    if (cleanedParams.type === undefined) {
      cleanedParams.type = 'object';
    }
    // 对于 object 类型，至少保证有 properties 字段
    if (cleanedParams.type === 'object' && cleanedParams.properties === undefined) {
      cleanedParams.properties = {};
    }

    return {
      functionDeclarations: [
        {
          name: tool.function.name,
          description: tool.function.description,
          parameters: cleanedParams
        }
      ]
    }
  })
}

function modelMapping(modelName){
  if (modelName === "claude-sonnet-4-5-thinking"){
    return "claude-sonnet-4-5";
  } else if (modelName === "claude-opus-4-5"){
    return "claude-opus-4-5-thinking";
  } else if (modelName === "gemini-2.5-flash-thinking"){
    return "gemini-2.5-flash";
  }
  return modelName;
}

function isEnableThinking(modelName){
  // 只要模型名里包含 -thinking（例如 gemini-2.0-flash-thinking-exp），就认为支持思考配置
  return modelName.includes('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === "rev19-uic3-1p" ||
    modelName === "gpt-oss-120b-medium";
}

function generateRequestBody(openaiMessages,modelName,parameters,openaiTools,token){
  
  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);
  
  // 提取合并后的 system 指令
  const mergedSystemInstruction = extractSystemInstruction(openaiMessages);
  
  // 过滤掉开头连续的 system 消息，避免重复作为 user 发送
  let startIndex = 0;
  for (let i = 0; i < openaiMessages.length; i++) {
    if (openaiMessages[i].role === 'system') {
      startIndex = i + 1;
    } else {
      break;
    }
  }
  const filteredMessages = openaiMessages.slice(startIndex);
  
  const requestBody = {
    project: token.projectId,
    requestId: generateRequestId(),
    request: {
      contents: openaiMessageToAntigravity(filteredMessages),
      tools: convertOpenAIToolsToAntigravity(openaiTools),
      toolConfig: {
        functionCallingConfig: {
          mode: "VALIDATED"
        }
      },
      generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
      sessionId: token.sessionId
    },
    model: actualModelName,
    userAgent: "antigravity/1.11.3 windows/amd64"
  };
  
  // 只有当有 system 指令时才添加 systemInstruction 字段
  if (mergedSystemInstruction) {
    requestBody.request.systemInstruction = {
      role: "user",
      parts: [{ text: mergedSystemInstruction }]
    };
  }
  
  return requestBody;
}
/**
 * 将通用文本对话请求体转换为图片生成请求体
 * 统一配置 image_gen 所需字段，避免在各处手动删除/覆盖字段
 */
function prepareImageRequest(requestBody) {
  if (!requestBody || !requestBody.request) return requestBody;

  requestBody.request.generationConfig = { candidateCount: 1 };
  requestBody.requestType = 'image_gen';

  // image_gen 模式下不需要这些字段
  delete requestBody.request.systemInstruction;
  delete requestBody.request.tools;
  delete requestBody.request.toolConfig;

  return requestBody;
}

function getDefaultIp(){
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)){
    for (const inter of iface){
      if (inter.family === 'IPv4' && !inter.internal){
        return inter.address;
      }
    }
  }
  return '127.0.0.1';
}
export{
  generateRequestId,
  generateRequestBody,
  prepareImageRequest,
  getDefaultIp
}