// 通用工具函数
import config from '../config/config.js';
import os from 'os';
import { REASONING_EFFORT_MAP, DEFAULT_STOP_SEQUENCES } from '../constants/index.js';
import { toGenerationConfig } from './parameterNormalizer.js';

// ==================== 签名常量 ====================
const CLAUDE_THOUGHT_SIGNATURE = null;
const GEMINI_THOUGHT_SIGNATURE = null;
const CLAUDE_TOOL_SIGNATURE = null;
const GEMINI_TOOL_SIGNATURE = null;

export function getThoughtSignatureForModel(actualModelName) {
  if (!actualModelName) return CLAUDE_THOUGHT_SIGNATURE;
  const lower = actualModelName.toLowerCase();
  if (lower.includes('claude')) return CLAUDE_THOUGHT_SIGNATURE;
  if (lower.includes('gemini')) return GEMINI_THOUGHT_SIGNATURE;
  return CLAUDE_THOUGHT_SIGNATURE;
}

export function getToolSignatureForModel(actualModelName) {
  if (!actualModelName) return CLAUDE_TOOL_SIGNATURE;
  const lower = actualModelName.toLowerCase();
  if (lower.includes('claude')) return CLAUDE_TOOL_SIGNATURE;
  if (lower.includes('gemini')) return GEMINI_TOOL_SIGNATURE;
  return CLAUDE_TOOL_SIGNATURE;
}

// ==================== 工具名称规范化 ====================
export function sanitizeToolName(name) {
  if (!name || typeof name !== 'string') return 'tool';
  let cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  cleaned = cleaned.replace(/^_+|_+$/g, '');
  if (!cleaned) cleaned = 'tool';
  if (cleaned.length > 128) cleaned = cleaned.slice(0, 128);
  return cleaned;
}

// ==================== 参数清理 ====================
const EXCLUDED_KEYS = new Set([
  '$schema', 'additionalProperties', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'uniqueItems', 'exclusiveMaximum',
  'exclusiveMinimum', 'const', 'anyOf', 'oneOf', 'allOf',
  'any_of', 'one_of', 'all_of', 'multipleOf'
]);

export function cleanParameters(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const cleaned = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (EXCLUDED_KEYS.has(key)) continue;
    cleaned[key] = (value && typeof value === 'object') ? cleanParameters(value) : value;
  }
  return cleaned;
}

// ==================== Model Mapping ====================
// Map Anthropic official model names to Antigravity model names
// Supports Claude Code and other clients that use official Anthropic model naming
export function modelMapping(modelName) {
  // Dynamic matching for Anthropic official model name formats:
  // - claude-{type}-{major}-{minor}-{date} (e.g., claude-sonnet-4-5-20250929)
  // - claude-{type}-{major}-{date} (e.g., claude-sonnet-4-20250514)
  // - claude-{major}-{minor}-{type}-{date} (e.g., claude-3-5-sonnet-20241022)
  // - claude-{major}-{type}-{date} (e.g., claude-3-opus-20240229)
  // - claude-{version}-{type}-latest (e.g., claude-3-5-sonnet-latest)

  // Pattern 1: claude-{type}-{version}-{date} (Claude 4+ format)
  // e.g., claude-sonnet-4-5-20250929, claude-opus-4-20250514
  const pattern1 = modelName.match(/^claude-(sonnet|opus|haiku)-\d+(-\d+)?-\d{8}$/);
  if (pattern1) {
    const type = pattern1[1];
    if (type === 'opus') return 'claude-opus-4-5-thinking';
    return 'claude-sonnet-4-5';
  }

  // Pattern 2: claude-{major}-{minor}-{type}-{date} (Claude 3.x format)
  // e.g., claude-3-5-sonnet-20241022, claude-3-5-haiku-20241022
  const pattern2 = modelName.match(/^claude-\d+-\d+-(sonnet|opus|haiku)-\d{8}$/);
  if (pattern2) {
    const type = pattern2[1];
    if (type === 'opus') return 'claude-opus-4-5-thinking';
    return 'claude-sonnet-4-5';
  }

  // Pattern 3: claude-{major}-{type}-{date} (Claude 3 format)
  // e.g., claude-3-opus-20240229, claude-3-sonnet-20240229
  const pattern3 = modelName.match(/^claude-\d+-(sonnet|opus|haiku)-\d{8}$/);
  if (pattern3) {
    const type = pattern3[1];
    if (type === 'opus') return 'claude-opus-4-5-thinking';
    return 'claude-sonnet-4-5';
  }

  // Pattern 4: claude-{version}-{type}-latest
  // e.g., claude-3-5-sonnet-latest, claude-3-opus-latest
  const pattern4 = modelName.match(/^claude-(\d+-)?(.+)-latest$/);
  if (pattern4) {
    const remainder = pattern4[2];
    if (remainder.includes('opus')) return 'claude-opus-4-5-thinking';
    return 'claude-sonnet-4-5';
  }

  // Original logic (kept for backward compatibility)
  if (modelName === 'claude-sonnet-4-5-thinking') return 'claude-sonnet-4-5';
  if (modelName === 'claude-opus-4-5') return 'claude-opus-4-5-thinking';
  if (modelName === 'gemini-2.5-flash-thinking') return 'gemini-2.5-flash';
  return modelName;
}

export function isEnableThinking(modelName) {
  return modelName.includes('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName === 'gemini-3-flash' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === 'rev19-uic3-1p' ||
    modelName === 'gpt-oss-120b-medium';
}

// ==================== 生成配置 ====================
export function generateGenerationConfig(parameters, enableThinking, actualModelName) {
  // 使用 config.defaults 兜底
  const normalizedParams = {
    temperature: parameters.temperature ?? config.defaults.temperature,
    top_p: parameters.top_p ?? config.defaults.top_p,
    top_k: parameters.top_k ?? config.defaults.top_k,
    max_tokens: parameters.max_tokens ?? config.defaults.max_tokens,
    thinking_budget: parameters.thinking_budget,
  };

  // 处理 reasoning_effort 到 thinking_budget 的转换
  if (normalizedParams.thinking_budget === undefined && parameters.reasoning_effort !== undefined) {
    const defaultThinkingBudget = config.defaults.thinking_budget ?? 1024;
    normalizedParams.thinking_budget = REASONING_EFFORT_MAP[parameters.reasoning_effort] ?? defaultThinkingBudget;
  }

  // 使用统一的参数转换函数
  const generationConfig = toGenerationConfig(normalizedParams, enableThinking, actualModelName);
  
  // 添加 stopSequences
  generationConfig.stopSequences = DEFAULT_STOP_SEQUENCES;
  
  return generationConfig;
}

// ==================== System 指令提取 ====================
export function extractSystemInstruction(openaiMessages) {
  const baseSystem = config.systemInstruction || '';
  if (!config.useContextSystemPrompt) return baseSystem;

  const systemTexts = [];
  for (const message of openaiMessages) {
    if (message.role === 'system') {
      const content = typeof message.content === 'string'
        ? message.content
        : (Array.isArray(message.content)
            ? message.content.filter(item => item.type === 'text').map(item => item.text).join('')
            : '');
      if (content.trim()) systemTexts.push(content.trim());
    } else {
      break;
    }
  }

  const parts = [];
  if (baseSystem.trim()) parts.push(baseSystem.trim());
  if (systemTexts.length > 0) parts.push(systemTexts.join('\n\n'));
  return parts.join('\n\n');
}

// ==================== 图片请求准备 ====================
export function prepareImageRequest(requestBody) {
  if (!requestBody || !requestBody.request) return requestBody;
  let imageSize = "1K";
  if (requestBody.model.includes('4K')){
    imageSize = "4K";
  } else if (requestBody.model.includes('2K')){
    imageSize = "2K";
  } else {
    imageSize = "1K";
  }
  if (imageSize !== "1K"){
    requestBody.model = requestBody.model.slice(0, -3);
  }
  requestBody.request.generationConfig = { 
    candidateCount: 1,
    imageConfig: {
      imageSize: imageSize
    }
  };
  requestBody.requestType = 'image_gen';
  delete requestBody.request.systemInstruction;
  delete requestBody.request.tools;
  delete requestBody.request.toolConfig;
  return requestBody;
}

// ==================== 其他工具 ====================
export function getDefaultIp() {
  const interfaces = os.networkInterfaces();
  if (interfaces.WLAN) {
    for (const inter of interfaces.WLAN) {
      if (inter.family === 'IPv4' && !inter.internal) {
        return inter.address;
      }
    }
  } else if (interfaces.wlan2) {
    for (const inter of interfaces.wlan2) {
      if (inter.family === 'IPv4' && !inter.internal) {
        return inter.address;
      }
    }
  }
  return '127.0.0.1';
}

// 重导出主要函数
export { generateRequestId } from './idGenerator.js';
export { generateRequestBody } from './converters/openai.js';
export { generateClaudeRequestBody } from './converters/claude.js';
export { generateGeminiRequestBody } from './converters/gemini.js';
