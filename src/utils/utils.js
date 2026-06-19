// 通用工具函数
import config from '../config/config.js';
import os from 'os';
import { REASONING_EFFORT_MAP, DEFAULT_STOP_SEQUENCES } from '../constants/index.js';
import { toGenerationConfig } from './parameterNormalizer.js';

// ==================== 签名常量 ====================
const CLAUDE_THOUGHT_SIGNATURE = 'RXNZRENrZ0lDaEFDR0FJcVFMZzVPTmZsd1ZHNmZKK3labDJ0TkNlRzc5QUpzUHV2OW9UZG1yc0JUUGNsUjFBQWhKNWlYcXhlU0dTaEtxeWJ1NUdaM2YvMXByaHJCSnk3OEhsWkxOd1NEREI5Mi8zQXFlYkUvY3RISEJvTXlGVHNzdzRJZXkxUTFkUURJakE3R3AwSXJQeW0xdWxLMVBXcFhuRElPdmJFRFd4LzV2cUZaQTg2NWU1SkM3QnY2dkxwZE43M2dLYkljaThobGR3cXF3S1VMbHE5b3NMdjc3QnNhZm5mbDhlbUd5NmJ6WVRpUnRWcXA0MDJabmZ2Tnl3T2hJd1BBV0l1SUNTdjFTemswZlNmemR0Z2R5eGgxaUJOZHhHNXVhZWhKdWhlUUwza3RDZWVxa2dMNFE0ZjRKWkFnR3pKOHNvaStjZ1pqRXJHT1lyNjJkdkxnUUVoT1E5MjN6bEUwRFd4aXdPU1JOK3VSRWdHZ0FKVkhZcjBKVzhrVTZvaEVaYk1IVkE4aG14ZElGMm9YK1ZxRnFUSGFDZWZEYWNQNTJVOW94VmJ0cFhrNnJUanQ2ZHpadEFMWThXQWs5RFI3bTJTbGova2VraXFzVVBRbFdIaFNUN3diZGpuVkYvdUVoODRWbXQ5WjdtaThtR2JEcTdaTHVOalF0T3hHMVpXbXJmeUpCMExwa0R1SnZDV01qZ3BqTHdsU0R4SUpmeEFoT2JzQlVpRzdLTDYwcUluanZaK1VTcXdjZGhmN0U3ZjgrN0l2ZXczRC9DZUYvdlptQ0JqU2JTcUdYYmFIQmdC';
const GEMINI_THOUGHT_SIGNATURE = 'EqAHCp0HAXLI2nygRbdzD4Vgzxxi7tbM87zIRkNgPLqTj+Jxv9mY8Q0G87DzbTtvsIFhWB0RZMoEK6ntm5GmUe6ADtxHk4zgHUs/FKqTu8tzUdPRDrKn3KCAtFW4LJqijZoFxNKMyQRmlgPUX4tGYE7pllD77UK6SjCwKhKZoSVZLMiPXP9YFktbida1Q5upXMrzG1t8abPmpFo983T/rgWlNqJp+Fb+bsoH0zuSpmU4cPKO3LIGsxBhvRhM/xydahZD+VpEX7TEJAN58z1RomFyx9u0IR7ukwZr2UyoNA+uj8OChUDFupQsVwbm3XE1UAt22BGvfYIyyZ42fxgOgsFFY+AZ72AOufcmZb/8vIw3uEUgxHczdl+NGLuS4Hsy/AAntdcH9sojSMF3qTf+ZK1FMav23SPxUBtU5T9HCEkKqQWRnMsVGYV1pupFisWo85hRLDTUipxVy9ug1hN8JBYBNmGLf8KtWLhVp7Z11PIAZj3C6HzoVyiVeuiorwNrn0ZaaXNe+y5LHuDF0DNZhrIfnXByq6grLLSAv4fTLeCJvfGzTWWyZDMbVXNx1HgumKq8calP9wv33t0hfEaOlcmfGIyh1J/N+rOGR0WXcuZZP5/VsFR44S2ncpwTPT+MmR0PsjocDenRY5m/X4EXbGGkZ+cfPnWoA64bn3eLeJTwxl9W1ZbmYS6kjpRGUMxExgRNOzWoGISddHCLcQvN7o50K8SF5k97rxiS5q4rqDmqgRPXzQTQnZyoL3dCxScX9cvLSjNCZDcotonDBAWHfkXZ0/EmFiONQcLJdANtAjwoA44Mbn50gubrTsNd7d0Rm/hbNEh/ZceUalV5MMcl6tJtahCJoybQMsnjWuBXl7cXiKmqAvxTDxIaBgQBYAo4FrbV4zQv35zlol+O3YiyjJn/U0oBeO5pEcH1d0vnLgYP71jZVY2FjWRKnDR9aw4JhiuqAa+i0tupkBy+H4/SVwHADFQq6wcsL8qvXlwktJL9MIAoaXDkIssw6gKE9EuGd7bSO9f+sA8CZ0I8LfJ3jcHUsE/3qd4pFrn5RaET56+1p8ZHZDDUQ0p1okApUCCYsC2WuL6O9P4fcg3yitAA/AfUUNjHKANE+ANneQ0efMG7fx9bvI+iLbXgPupApoov24JRkmhHsrJiu9bp+G/pImd2PNv7ArunJ6upl0VAUWtRyLWyGfdl6etGuY8vVJ7JdWEQ8aWzRK3g6e+8YmDtP5DAfw==';
const CLAUDE_TOOL_SIGNATURE = 'RXVNQkNrZ0lDaEFDR0FJcVFLZGsvMnlyR0VTbmNKMXEyTFIrcWwyY2ozeHhoZHRPb0VOYWJ2VjZMSnE2MlBhcEQrUWdIM3ZWeHBBUG9rbGN1aXhEbXprZTcvcGlkbWRDQWs5MWcrTVNERnRhbWJFOU1vZWZGc1pWSGhvTUxsMXVLUzRoT3BIaWwyeXBJakNYa05EVElMWS9talprdUxvRjFtMmw5dnkrbENhSDNNM3BYNTM0K1lRZ0NaWTQvSUNmOXo4SkhZVzU2Sm1WcTZBcVNRUURBRGVMV1BQRXk1Q0JsS0dCZXlNdHp2NGRJQVlGbDFSMDBXNGhqNHNiSWNKeGY0UGZVQTBIeE1mZjJEYU5BRXdrWUJ4MmNzRFMrZGM1N1hnUlVNblpkZ0hTVHVNaGdod1lBUT09';
const GEMINI_TOOL_SIGNATURE = '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';

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
  'any_of', 'one_of', 'all_of', 'multipleOf',
  // Gemini API 不支持的高级 JSON Schema 字段
  'propertyNames', 'patternProperties', 'dependencies',
  'if', 'then', 'else', 'not', 'contentMediaType', 'contentEncoding',
  'definitions', '$defs', '$ref', '$id', '$comment', 'undefined'
]);

// 需要转换为大写的 type 值映射
const TYPE_UPPERCASE_MAP = {
  'object': 'OBJECT',
  'string': 'STRING',
  'number': 'NUMBER',
  'integer': 'INTEGER',
  'boolean': 'BOOLEAN',
  'array': 'ARRAY'
};

export function cleanParameters(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const cleaned = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (EXCLUDED_KEYS.has(key)) continue;
    if (key === 'type') {
      // 处理 type 字段
      if (typeof value === 'string') {
        // 字符串类型：转换为大写
        cleaned[key] = TYPE_UPPERCASE_MAP[value.toLowerCase()] || value.toUpperCase();
      } else if (Array.isArray(value)) {
        // 数组类型（如 ["string", "null"]）：取第一个非 null 的类型
        // Gemini API 不支持联合类型，需要转换为单一类型
        const nonNullType = value.find(t => t !== 'null' && t !== null);
        if (nonNullType && typeof nonNullType === 'string') {
          cleaned[key] = TYPE_UPPERCASE_MAP[nonNullType.toLowerCase()] || nonNullType.toUpperCase();
        } else {
          // 如果都是 null 或找不到有效类型，默认为 STRING
          cleaned[key] = 'STRING';
        }
      } else {
        // 其他情况，保持原值
        cleaned[key] = value;
      }
    } else {
      cleaned[key] = (value && typeof value === 'object') ? cleanParameters(value) : value;
    }
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
  if (modelName === 'claude-sonnet-4-6-thinking') return 'claude-sonnet-4-6';
  // if (modelName === 'claude-opus-4-5') return 'claude-opus-4-5-thinking';
  if (modelName === 'claude-opus-4-5') return 'claude-opus-4-6-thinking';
  if (modelName === 'claude-opus-4-5-thinking') return 'claude-opus-4-6-thinking';
  if (modelName === 'claude-opus-4-6') return 'claude-opus-4-6-thinking';
  if (modelName === 'gemini-2.5-flash-thinking') return 'gemini-2.5-flash';
  return modelName;
}

export function isEnableThinking(modelName) {
  return modelName.includes('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3.1') ||
    modelName.startsWith('gemini-3') ||
    modelName.startsWith('gemini-pro') ||
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
    response_format: parameters.response_format,
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
/**
 * 从 OpenAI 消息中提取系统指令
 * @param {Array} openaiMessages - OpenAI 格式的消息数组
 * @returns {string} 用户请求中的系统提示词（不包含萌萌和反重力官方提示词）
 */
export function extractSystemInstruction(openaiMessages) {
  if (!config.useContextSystemPrompt) return '';

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

  // 只返回用户请求中的系统提示词，萌萌和反重力官方提示词由 buildSystemInstruction 处理
  return systemTexts.join('\n\n');
}

// ==================== 图片请求准备 ====================
export function prepareImageRequest(requestBody) {
  if (!requestBody || !requestBody.request) return requestBody;
  let imageSize = "1K";
  if (requestBody.model.includes('4K')) {
    imageSize = "4K";
  } else if (requestBody.model.includes('2K')) {
    imageSize = "2K";
  } else {
    imageSize = "1K";
  }
  if (imageSize !== "1K") {
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

export function generateCreatedAt() {
  const now = new Date();
  const isoString = now.toISOString();
  const nanos = String(now.getMilliseconds()).padStart(3, '0') + '000000';
  return isoString.replace(/\.\d{3}Z$/, `.${nanos}Z`);
}

// 重导出主要函数
export { generateRequestId } from './idGenerator.js';
export { generateRequestBody } from './converters/openai.js';
export { generateClaudeRequestBody } from './converters/claude.js';
export { generateGeminiRequestBody } from './converters/gemini.js';
