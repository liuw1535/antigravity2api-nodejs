import { setToolNameMapping } from './toolNameCache.js';

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

function sanitizeToolName(name) {
  if (!name || typeof name !== 'string') {
    return 'tool';
  }
  let cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  cleaned = cleaned.replace(/^_+|_+$/g, '');
  if (!cleaned) {
    cleaned = 'tool';
  }
  if (cleaned.length > 128) {
    cleaned = cleaned.slice(0, 128);
  }
  return cleaned;
}

function convertOpenAIToolsToAntigravity(openaiTools, sessionId, actualModelName) {
  if (!openaiTools || openaiTools.length === 0) return [];
  return openaiTools.map((tool) => {
    const rawParams = tool.function?.parameters || {};
    const cleanedParams = cleanParameters(rawParams) || {};
    if (cleanedParams.type === undefined) {
      cleanedParams.type = 'object';
    }
    if (cleanedParams.type === 'object' && cleanedParams.properties === undefined) {
      cleanedParams.properties = {};
    }

    const originalName = tool.function?.name;
    const safeName = sanitizeToolName(originalName);

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
    };
  });
}

export {
  cleanParameters,
  sanitizeToolName,
  convertOpenAIToolsToAntigravity
};
