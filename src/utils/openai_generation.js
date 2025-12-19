import config from '../config/config.js';
import { REASONING_EFFORT_MAP, DEFAULT_STOP_SEQUENCES } from '../constants/index.js';

function modelMapping(modelName) {
  if (modelName === 'claude-sonnet-4-5-thinking') {
    return 'claude-sonnet-4-5';
  } else if (modelName === 'claude-opus-4-5') {
    return 'claude-opus-4-5-thinking';
  } else if (modelName === 'gemini-2.5-flash-thinking') {
    return 'gemini-2.5-flash';
  }
  return modelName;
}

function isEnableThinking(modelName) {
  return modelName.includes('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === 'rev19-uic3-1p' ||
    modelName === 'gpt-oss-120b-medium';
}

function generateGenerationConfig(parameters, enableThinking, actualModelName) {
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
    stopSequences: DEFAULT_STOP_SEQUENCES,
    thinkingConfig: {
      includeThoughts: enableThinking,
      thinkingBudget: thinkingBudget
    }
  };
  if (enableThinking && actualModelName.includes('claude')) {
    delete generationConfig.topP;
  }
  return generationConfig;
}

export {
  modelMapping,
  isEnableThinking,
  generateGenerationConfig
};
