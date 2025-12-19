import config from '../config/config.js';
import tokenManager from '../auth/token_manager.js';
import { generateRequestId } from './idGenerator.js';
import os from 'os';
import { getReasoningSignature, getToolSignature } from './thoughtSignatureCache.js';
import { setToolNameMapping } from './toolNameCache.js';

// 思维链签名常量 - 暂时123占位
// Claude 模型签名
const CLAUDE_THOUGHT_SIGNATURE = 'RXFRRENrZ0lDaEFDR0FJcVFKV1Bvcy9GV20wSmtMV2FmWkFEbGF1ZTZzQTdRcFlTc1NvbklmemtSNFo4c1dqeitIRHBOYW9hS2NYTE1TeTF3bjh2T1RHdE1KVjVuYUNQclZ5cm9DMFNETHk4M0hOSWsrTG1aRUhNZ3hvTTl0ZEpXUDl6UUMzOExxc2ZJakI0UkkxWE1mdWJ1VDQrZnY0Znp0VEoyTlhtMjZKL2daYi9HL1gwcmR4b2x0VE54empLemtLcEp0ZXRia2plb3NBcWlRSWlXUHloMGhVVTk1dHNha1dyNDVWNUo3MTJjZDNxdHQ5Z0dkbjdFaFk4dUllUC9CcThVY2VZZC9YbFpYbDc2bHpEbmdzL2lDZXlNY3NuZXdQMjZBTDRaQzJReXdibVQzbXlSZmpld3ZSaUxxOWR1TVNidHIxYXRtYTJ0U1JIRjI0Z0JwUnpadE1RTmoyMjR4bTZVNUdRNXlOSWVzUXNFNmJzRGNSV0RTMGFVOEZERExybmhVQWZQT2JYMG5lTGR1QnU1VGZOWW9NZGlRbTgyUHVqVE1xaTlmN0t2QmJEUUdCeXdyVXR2eUNnTEFHNHNqeWluZDRCOEg3N2ZJamt5blI3Q3ZpQzlIOTVxSENVTCt3K3JzMmsvV0sxNlVsbGlTK0pET3UxWXpPMWRPOUp3V3hEMHd5ZVU0a0Y5MjIxaUE5Z2lUd2djZXhSU2c4TWJVMm1NSjJlaGdlY3g0YjJ3QloxR0FFPQ==';
// Gemini 思维链签名
const GEMINI_THOUGHT_SIGNATURE = 'EqAHCp0HAXLI2nygRbdzD4Vgzxxi7tbM87zIRkNgPLqTj+Jxv9mY8Q0G87DzbTtvsIFhWB0RZMoEK6ntm5GmUe6ADtxHk4zgHUs/FKqTu8tzUdPRDrKn3KCAtFW4LJqijZoFxNKMyQRmlgPUX4tGYE7pllD77UK6SjCwKhKZoSVZLMiPXP9YFktbida1Q5upXMrzG1t8abPmpFo983T/rgWlNqJp+Fb+bsoH0zuSpmU4cPKO3LIGsxBhvRhM/xydahZD+VpEX7TEJAN58z1RomFyx9u0IR7ukwZr2UyoNA+uj8OChUDFupQsVwbm3XE1UAt22BGvfYIyyZ42fxgOgsFFY+AZ72AOufcmZb/8vIw3uEUgxHczdl+NGLuS4Hsy/AAntdcH9sojSMF3qTf+ZK1FMav23SPxUBtU5T9HCEkKqQWRnMsVGYV1pupFisWo85hRLDTUipxVy9ug1hN8JBYBNmGLf8KtWLhVp7Z11PIAZj3C6HzoVyiVeuiorwNrn0ZaaXNe+y5LHuDF0DNZhrIfnXByq6grLLSAv4fTLeCJvfGzTWWyZDMbVXNx1HgumKq8calP9wv33t0hfEaOlcmfGIyh1J/N+rOGR0WXcuZZP5/VsFR44S2ncpwTPT+MmR0PsjocDenRY5m/X4EXbGGkZ+cfPnWoA64bn3eLeJTwxl9W1ZbmYS6kjpRGUMxExgRNOzWoGISddHCLcQvN7o50K8SF5k97rxiS5q4rqDmqgRPXzQTQnZyoL3dCxScX9cvLSjNCZDcotonDBAWHfkXZ0/EmFiONQcLJdANtAjwoA44Mbn50gubrTsNd7d0Rm/hbNEh/ZceUalV5MMcl6tJtahCJoybQMsnjWuBXl7cXiKmqAvxTDxIaBgQBYAo4FrbV4zQv35zlol+O3YiyjJn/U0oBeO5pEcH1d0vnLgYP71jZVY2FjWRKnDR9aw4JhiuqAa+i0tupkBy+H4/SVwHADFQq6wcsL8qvXlwktJL9MIAoaXDkIssw6gKE9EuGd7bSO9f+sA8CZ0I8LfJ3jcHUsE/3qd4pFrn5RaET56+1p8ZHZDDUQ0p1okApUCCYsC2WuL6O9P4fcg3yitAA/AfUUNjHKANE+ANneQ0efMG7fx9bvI+iLbXgPupApoov24JRkmhHsrJiu9bp+G/pImd2PNv7ArunJ6upl0VAUWtRyLWyGfdl6etGuY8vVJ7JdWEQ8aWzRK3g6e+8YmDtP5DAfw==';
// 工具调用思维链签名
const TOOL_THOUGHT_SIGNATURE = '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';
// 兜底签名（非 Claude/Gemini 时）
const DEFAULT_THOUGHT_SIGNATURE = CLAUDE_THOUGHT_SIGNATURE;

function getThoughtSignatureForModel(actualModelName) {
  if (!actualModelName) return DEFAULT_THOUGHT_SIGNATURE;
  const lower = actualModelName.toLowerCase();
  if (lower.includes('claude')) return CLAUDE_THOUGHT_SIGNATURE;
  if (lower.includes('gemini')) return GEMINI_THOUGHT_SIGNATURE;
  return DEFAULT_THOUGHT_SIGNATURE;
}

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
// 将工具名称规范为 Vertex 要求的格式：^[a-zA-Z0-9_-]{1,128}$
function sanitizeToolName(name) {
  if (!name || typeof name !== 'string') {
    return 'tool';
  }
  // 替换非法字符为下划线
  let cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  // 去掉首尾多余下划线
  cleaned = cleaned.replace(/^_+|_+$/g, '');
  if (!cleaned) {
    cleaned = 'tool';
  }
  // 限制最大长度 128
  if (cleaned.length > 128) {
    cleaned = cleaned.slice(0, 128);
  }
  return cleaned;
}
function handleAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId){
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const hasContent = message.content && message.content.trim() !== '';
  
  const antigravityTools = hasToolCalls ? message.tool_calls.map(toolCall => {
    const originalName = toolCall.function.name;
    const safeName = sanitizeToolName(originalName);

    const part = {
      functionCall: {
        id: toolCall.id,
        name: safeName,
        args: {
          query: toolCall.function.arguments
        }
      }
    };

    // 记录原始工具名到安全名的映射（仅当确实发生了变化时）
    if (sessionId && actualModelName && safeName !== originalName) {
      setToolNameMapping(sessionId, actualModelName, safeName, originalName);
    }

    // 启用思考模型时，工具调用优先使用实时签名（如果上游带了），否则兜底用常量
    if (enableThinking) {
      const cachedToolSig = getToolSignature(sessionId, actualModelName);
      part.thoughtSignature = toolCall.thoughtSignature || cachedToolSig || TOOL_THOUGHT_SIGNATURE;
    }

    return part;
  }) : [];

  if (lastMessage?.role === "model" && hasToolCalls && !hasContent){
    lastMessage.parts.push(...antigravityTools)
  }else{
    const parts = [];

    // 对于启用思考的模型，在历史 assistant 消息中补一个思考块 + 签名块
    // 结构示例：
    // {
    //   "role": "model",
    //   "parts": [
    //     { "text": "␈", "thought": true },
    //     { "text": "␈", "thoughtSignature": "..." },
    //     { "text": "正常回复..." }
    //   ]
    // }
    if (enableThinking) {
      // 普通思维链签名：
      // 1. 优先使用消息自身携带的 thoughtSignature
      // 2. 其次使用缓存中的最新签名（同 session + model）
      // 3. 最后按模型类型选择内置兜底签名
      const cachedSig = getReasoningSignature(sessionId, actualModelName);
      const thoughtSignature = message.thoughtSignature || cachedSig || getThoughtSignatureForModel(actualModelName);
      // 默认思考内容不能是完全空字符串，否则上游会要求 thinking 字段
      // 这里用一个不可见的退格符作为占位，实际展示时等价于“空思考块”
      let reasoningText = '';
      if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
        reasoningText = message.reasoning_content;
      } else {
        reasoningText = ' '; // 退格符占位
      }
      parts.push({ text: reasoningText, thought: true });
      // 思维链签名占位，避免上游校验缺少签名字段
      parts.push({ text: ' ', thoughtSignature });
    }

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
function openaiMessageToAntigravity(openaiMessages, enableThinking, actualModelName, sessionId){
  const antigravityMessages = [];
  for (const message of openaiMessages) {
    if (message.role === "user" || message.role === "system") {
      // system 消息作为 user 处理（开头的 system 已在 generateRequestBody 中过滤）
      const extracted = extractImagesFromContent(message.content);
      handleUserMessage(extracted, antigravityMessages);
    } else if (message.role === "assistant") {
      handleAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId);
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
 * 2. 根据 useContextSystemPrompt 配置决定是否收集请求中的 system 消息
 * 3. 如果 useContextSystemPrompt=true，收集开头连续的 system 消息并合并
 * 4. 如果 useContextSystemPrompt=false，只使用基础 SYSTEM_INSTRUCTION
 */
function extractSystemInstruction(openaiMessages) {
  const baseSystem = config.systemInstruction || '';
  
  // 如果不使用上下文 system，只返回基础 system
  if (!config.useContextSystemPrompt) {
    return baseSystem;
  }
  
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

function convertOpenAIToolsToAntigravity(openaiTools, sessionId, actualModelName){
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

    const originalName = tool.function?.name;
    const safeName = sanitizeToolName(originalName);

    // 仅当发生转换时才缓存映射
    if (sessionId && actualModelName && safeName !== originalName) {
      setToolNameMapping(sessionId, actualModelName, safeName, originalName);
    }

    return {
      functionDeclarations: [
        {
          name: safeName,
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
  
  // 根据 useContextSystemPrompt 配置决定如何处理 system 消息
  let startIndex = 0;
  if (config.useContextSystemPrompt) {
    // 过滤掉开头连续的 system 消息，避免重复作为 user 发送
    for (let i = 0; i < openaiMessages.length; i++) {
      if (openaiMessages[i].role === 'system') {
        startIndex = i + 1;
      } else {
        break;
      }
    }
  }
  const filteredMessages = openaiMessages.slice(startIndex);
  
  const requestBody = {
    project: token.projectId,
    requestId: generateRequestId(),
    request: {
      contents: openaiMessageToAntigravity(filteredMessages, enableThinking, actualModelName, token.sessionId),
      tools: convertOpenAIToolsToAntigravity(openaiTools, token.sessionId, actualModelName),
      toolConfig: {
        functionCallingConfig: {
          mode: "VALIDATED"
        }
      },
      generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
      sessionId: token.sessionId
    },
    model: actualModelName,
    userAgent: "antigravity"
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

function generateGeminiRequestBody(geminiBody, modelName, token){
  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);
  
  // 深拷贝 body，避免修改原始对象
  const request = JSON.parse(JSON.stringify(geminiBody));
  //console.log(JSON.stringify(request,null,2));
  
  // 处理 contents 中的 functionCall 和 functionResponse，确保有 id 字段
  if (request.contents && Array.isArray(request.contents)) {
    // 第一遍：收集所有 functionCall 的 name -> id 映射
    const functionCallIds = new Map();
    request.contents.forEach(content => {
      if (content.role === 'model' && content.parts && Array.isArray(content.parts)) {
        content.parts.forEach(part => {
          if (part.functionCall) {
            if (!part.functionCall.id) {
              part.functionCall.id = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            }
            // 记录 name -> id 映射
            functionCallIds.set(part.functionCall.name, part.functionCall.id);
          }
        });
      }
    });
    
    // 第二遍：为 functionResponse 匹配对应的 id
    request.contents.forEach(content => {
      if (content.role === 'user' && content.parts && Array.isArray(content.parts)) {
        content.parts.forEach(part => {
          if (part.functionResponse && !part.functionResponse.id) {
            // 尝试从映射中找到对应的 id
            const matchedId = functionCallIds.get(part.functionResponse.name);
            part.functionResponse.id = matchedId || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          }
        });
      }
    });
  }
  
  // 确保 generationConfig 存在
  if (!request.generationConfig) {
    request.generationConfig = {};
  }
  
  // 处理思考模型配置
  if (enableThinking) {
    const defaultThinkingBudget = config.defaults.thinking_budget ?? 1024;
    // 如果没有 thinkingConfig，尝试注入
    if (!request.generationConfig.thinkingConfig) {
      request.generationConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: defaultThinkingBudget
      };
    }
  }
  
  // 强制 candidateCount 为 1
  request.generationConfig.candidateCount = 1;
  
  // 注入 sessionId
  request.sessionId = token.sessionId;
  delete request.safetySettings;
  
  // 构造 Antigravity 请求体
  const requestBody = {
    project: token.projectId,
    requestId: generateRequestId(),
    request: request,
    model: actualModelName,
    userAgent: "antigravity"
  };
  
  return requestBody;
}

// ==================== Claude API 转换函数 ====================

/**
 * 从 Claude 消息内容中提取图片
 * Claude 格式: { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
 */
function extractImagesFromClaudeContent(content) {
  const result = { text: '', images: [] };

  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text || '';
      } else if (item.type === 'image') {
        // Claude 格式的图片
        const source = item.source;
        if (source && source.type === 'base64' && source.data) {
          result.images.push({
            inlineData: {
              mimeType: source.media_type || 'image/png',
              data: source.data
            }
          });
        }
      }
    }
  }

  return result;
}

/**
 * 处理 Claude 用户消息
 */
function handleClaudeUserMessage(extracted, antigravityMessages) {
  antigravityMessages.push({
    role: "user",
    parts: [
      { text: extracted.text },
      ...extracted.images
    ]
  });
}

/**
 * 处理 Claude 助手消息（包含 tool_use）
 */
function handleClaudeAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const content = message.content;
  
  // 解析 content 数组
  let textContent = '';
  const toolCalls = [];
  
  if (typeof content === 'string') {
    textContent = content;
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        textContent += item.text || '';
      } else if (item.type === 'tool_use') {
        // Claude 的 tool_use 格式
        const originalName = item.name;
        const safeName = sanitizeToolName(originalName);
        
        const part = {
          functionCall: {
            id: item.id,
            name: safeName,
            args: {
              query: JSON.stringify(item.input || {})
            }
          }
        };
        
        // 记录工具名映射
        if (sessionId && actualModelName && safeName !== originalName) {
          setToolNameMapping(sessionId, actualModelName, safeName, originalName);
        }
        
        toolCalls.push(part);
      }
    }
  }
  
  const hasToolCalls = toolCalls.length > 0;
  const hasContent = textContent && textContent.trim() !== '';
  
  if (lastMessage?.role === "model" && hasToolCalls && !hasContent) {
    lastMessage.parts.push(...toolCalls);
  } else {
    const parts = [];
    
    // 思维链处理（与 OpenAI 相同）
    if (enableThinking) {
      const cachedSig = getReasoningSignature(sessionId, actualModelName);
      const thoughtSignature = cachedSig || getThoughtSignatureForModel(actualModelName);
      parts.push({ text: ' ', thought: true });
      parts.push({ text: ' ', thoughtSignature });
    }
    
    if (hasContent) parts.push({ text: textContent.trimEnd() });
    parts.push(...toolCalls);
    
    antigravityMessages.push({
      role: "model",
      parts
    });
  }
}

/**
 * 处理 Claude tool_result 消息
 */
function handleClaudeToolResult(message, antigravityMessages) {
  const content = message.content;
  
  if (!Array.isArray(content)) return;
  
  for (const item of content) {
    if (item.type !== 'tool_result') continue;
    
    const toolUseId = item.tool_use_id;
    
    // 从之前的 model 消息中找到对应的 functionCall name
    let functionName = '';
    for (let i = antigravityMessages.length - 1; i >= 0; i--) {
      if (antigravityMessages[i].role === 'model') {
        const parts = antigravityMessages[i].parts;
        for (const part of parts) {
          if (part.functionCall && part.functionCall.id === toolUseId) {
            functionName = part.functionCall.name;
            break;
          }
        }
        if (functionName) break;
      }
    }
    
    const lastMessage = antigravityMessages[antigravityMessages.length - 1];
    
    // 提取工具结果内容
    let resultContent = '';
    if (typeof item.content === 'string') {
      resultContent = item.content;
    } else if (Array.isArray(item.content)) {
      resultContent = item.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('');
    }
    
    const functionResponse = {
      functionResponse: {
        id: toolUseId,
        name: functionName,
        response: {
          output: resultContent
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
}

/**
 * 将 Claude 消息转换为 Antigravity 格式
 */
function claudeMessageToAntigravity(claudeMessages, enableThinking, actualModelName, sessionId) {
  const antigravityMessages = [];
  
  for (const message of claudeMessages) {
    if (message.role === "user") {
      // 检查是否包含 tool_result
      const content = message.content;
      if (Array.isArray(content) && content.some(item => item.type === 'tool_result')) {
        handleClaudeToolResult(message, antigravityMessages);
      } else {
        const extracted = extractImagesFromClaudeContent(content);
        handleClaudeUserMessage(extracted, antigravityMessages);
      }
    } else if (message.role === "assistant") {
      handleClaudeAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId);
    }
  }
  
  return antigravityMessages;
}

/**
 * 将 Claude 工具格式转换为 Antigravity 格式
 * Claude: { name, description, input_schema: {...} }
 * Antigravity/Gemini: { functionDeclarations: [{ name, description, parameters: {...} }] }
 */
function convertClaudeToolsToAntigravity(claudeTools, sessionId, actualModelName) {
  if (!claudeTools || claudeTools.length === 0) return [];
  
  return claudeTools.map((tool) => {
    // 清洗参数
    const rawParams = tool.input_schema || {};
    const cleanedParams = cleanParameters(rawParams) || {};
    
    // 确保顶层是合法的 JSON Schema 对象
    if (cleanedParams.type === undefined) {
      cleanedParams.type = 'object';
    }
    if (cleanedParams.type === 'object' && cleanedParams.properties === undefined) {
      cleanedParams.properties = {};
    }
    
    const originalName = tool.name;
    const safeName = sanitizeToolName(originalName);
    
    // 缓存映射
    if (sessionId && actualModelName && safeName !== originalName) {
      setToolNameMapping(sessionId, actualModelName, safeName, originalName);
    }
    
    return {
      functionDeclarations: [
        {
          name: safeName,
          description: tool.description || '',
          parameters: cleanedParams
        }
      ]
    };
  });
}

/**
 * 生成 Claude 请求体并转换为 Antigravity 格式
 */
function generateClaudeRequestBody(claudeMessages, modelName, parameters, claudeTools, systemPrompt, token) {
  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);
  
  // 合并 system 指令
  const baseSystem = config.systemInstruction || '';
  let mergedSystem = '';
  
  if (config.useContextSystemPrompt && systemPrompt) {
    const parts = [];
    if (baseSystem.trim()) parts.push(baseSystem.trim());
    if (systemPrompt.trim()) parts.push(systemPrompt.trim());
    mergedSystem = parts.join('\n\n');
  } else {
    mergedSystem = baseSystem;
  }
  
  const requestBody = {
    project: token.projectId,
    requestId: generateRequestId(),
    request: {
      contents: claudeMessageToAntigravity(claudeMessages, enableThinking, actualModelName, token.sessionId),
      tools: convertClaudeToolsToAntigravity(claudeTools, token.sessionId, actualModelName),
      toolConfig: {
        functionCallingConfig: {
          mode: "VALIDATED"
        }
      },
      generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
      sessionId: token.sessionId
    },
    model: actualModelName,
    userAgent: "antigravity"
  };
  
  // 只有当有 system 指令时才添加
  if (mergedSystem) {
    requestBody.request.systemInstruction = {
      role: "user",
      parts: [{ text: mergedSystem }]
    };
  }
  
  return requestBody;
}

export{
  generateRequestId,
  generateRequestBody,
  generateGeminiRequestBody,
  generateClaudeRequestBody,
  prepareImageRequest,
  getDefaultIp
}
