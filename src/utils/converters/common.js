// 转换器公共模块
import config from '../../config/config.js';
import { generateRequestId } from '../idGenerator.js';
import { getReasoningSignature, getToolSignature } from '../thoughtSignatureCache.js';
import { setToolNameMapping } from '../toolNameCache.js';
import { getThoughtSignatureForModel, getToolSignatureForModel, sanitizeToolName, modelMapping, isEnableThinking, generateGenerationConfig } from '../utils.js';

/**
 * 获取签名上下文
 * @param {string} sessionId - 会话 ID
 * @param {string} actualModelName - 实际模型名称
 * @returns {Object} 包含思维签名和工具签名的对象
 */
export function getSignatureContext(sessionId, actualModelName) {
  const cachedReasoningSig = getReasoningSignature(sessionId, actualModelName);
  const cachedToolSig = getToolSignature(sessionId, actualModelName);

  return {
    reasoningSignature: cachedReasoningSig || getThoughtSignatureForModel(actualModelName),
    toolSignature: cachedToolSig || getToolSignatureForModel(actualModelName)
  };
}

/**
 * 添加用户消息到 antigravityMessages
 * @param {Object} extracted - 提取的内容 { text, images }
 * @param {Array} antigravityMessages - 目标消息数组
 */
export function pushUserMessage(extracted, antigravityMessages) {
  antigravityMessages.push({
    role: 'user',
    parts: [{ text: extracted.text }, ...extracted.images]
  });
}

/**
 * 根据工具调用 ID 查找函数名
 * @param {string} toolCallId - 工具调用 ID
 * @param {Array} antigravityMessages - 消息数组
 * @returns {string} 函数名
 */
export function findFunctionNameById(toolCallId, antigravityMessages) {
  for (let i = antigravityMessages.length - 1; i >= 0; i--) {
    if (antigravityMessages[i].role === 'model') {
      const parts = antigravityMessages[i].parts;
      for (const part of parts) {
        if (part.functionCall && part.functionCall.id === toolCallId) {
          return part.functionCall.name;
        }
      }
    }
  }
  return '';
}

/**
 * 添加函数响应到 antigravityMessages
 * @param {string} toolCallId - 工具调用 ID
 * @param {string} functionName - 函数名
 * @param {string} resultContent - 响应内容
 * @param {Array} antigravityMessages - 目标消息数组
 */
export function pushFunctionResponse(toolCallId, functionName, resultContent, antigravityMessages) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const functionResponse = {
    functionResponse: {
      id: toolCallId,
      name: functionName,
      response: { output: resultContent }
    }
  };

  if (lastMessage?.role === 'user' && lastMessage.parts.some(p => p.functionResponse)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({ role: 'user', parts: [functionResponse] });
  }
}

/**
 * 创建带签名的思维 part
 * @param {string} text - 思维文本
 * @param {string} signature - 签名
 * @returns {Object} 思维 part
 */
export function createThoughtPart(text) {
  return { text: text || ' ', thought: true }
}

/**
 * 创建带签名的函数调用 part
 * @param {string} id - 调用 ID
 * @param {string} name - 函数名（已清理）
 * @param {Object|string} args - 参数
 * @param {string} signature - 签名（可选）
 * @returns {Object} 函数调用 part
 */
export function createFunctionCallPart(id, name, args, signature = null) {
  let parsedArgs = args;
  if (typeof args === 'string') {
    try {
      parsedArgs = JSON.parse(args);
    } catch {
      parsedArgs = { query: args };
    }
  }
  const part = {
    functionCall: {
      id,
      name,
      args: parsedArgs
    }
  };
  if (signature) {
    part.thoughtSignature = signature;
  }
  return part;
}

/**
 * 处理工具名称映射
 * @param {string} originalName - 原始名称
 * @param {string} sessionId - 会话 ID
 * @param {string} actualModelName - 实际模型名称
 * @returns {string} 清理后的安全名称
 */
export function processToolName(originalName, sessionId, actualModelName) {
  const safeName = sanitizeToolName(originalName);
  if (sessionId && actualModelName && safeName !== originalName) {
    setToolNameMapping(sessionId, actualModelName, safeName, originalName);
  }
  return safeName;
}

/**
 * 添加模型消息到 antigravityMessages
 * @param {Object} options - 选项
 * @param {Array} options.parts - 消息 parts
 * @param {Array} options.toolCalls - 工具调用 parts
 * @param {boolean} options.hasContent - 是否有文本内容
 * @param {Array} antigravityMessages - 目标消息数组
 */
export function pushModelMessage({ parts, toolCalls, hasContent }, antigravityMessages) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = toolCalls && toolCalls.length > 0;

  if (lastMessage?.role === 'model' && hasToolCalls && !hasContent) {
    lastMessage.parts.push(...toolCalls);
  } else {
    const allParts = [...parts, ...(toolCalls || [])];
    antigravityMessages.push({ role: 'model', parts: allParts });
  }
  //console.log(JSON.stringify(antigravityMessages,null,2));
}

/**
 * 构建基础请求体
 * @param {Object} options - 选项
 * @param {Array} options.contents - 消息内容
 * @param {Array} options.tools - 工具列表
 * @param {Object} options.generationConfig - 生成配置
 * @param {string} options.sessionId - 会话 ID
 * @param {string} options.systemInstruction - 系统指令
 * @param {Object} token - Token 对象
 * @param {string} actualModelName - 实际模型名称
 * @returns {Object} 请求体
 */
export function buildRequestBody({ contents, tools, generationConfig, sessionId, systemInstruction }, token, actualModelName) {
  const requestBody = {
    project: token.projectId,
    requestId: generateRequestId(),
    request: {
      contents,
      tools: tools || [],
      toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
      generationConfig,
      sessionId
    },
    model: actualModelName,
    userAgent: 'antigravity'
  };

  if (systemInstruction) {
    requestBody.request.systemInstruction = {
      role: 'user',
      parts: [{ text: systemInstruction }]
    };
  }

  return requestBody;
}

/**
 * 合并系统指令
 * @param {string} baseSystem - 基础系统指令
 * @param {string} contextSystem - 上下文系统指令
 * @returns {string} 合并后的系统指令
 */
export function mergeSystemInstruction(baseSystem, contextSystem) {
  if (!config.useContextSystemPrompt || !contextSystem) {
    return baseSystem || '';
  }

  const parts = [];
  if (baseSystem && typeof baseSystem === 'string' && baseSystem.trim()) parts.push(baseSystem.trim());
  if (contextSystem && typeof contextSystem === 'string' && contextSystem.trim()) parts.push(contextSystem.trim());
  return parts.join('\n\n');
}

// 重导出常用函数
export { sanitizeToolName, modelMapping, isEnableThinking, generateGenerationConfig };

// 重导出参数规范化函数
export {
  normalizeOpenAIParameters,
  normalizeClaudeParameters,
  normalizeGeminiParameters,
  normalizeParameters,
  toGenerationConfig
} from '../parameterNormalizer.js';
