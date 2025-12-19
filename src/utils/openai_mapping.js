import config from '../config/config.js';
import { generateRequestId } from './idGenerator.js';
import { openaiMessageToAntigravity } from './openai_messages.js';
import { extractSystemInstruction } from './openai_system.js';
import { convertOpenAIToolsToAntigravity } from './openai_tools.js';
import { modelMapping, isEnableThinking, generateGenerationConfig } from './openai_generation.js';
import os from 'os';

function generateRequestBody(openaiMessages, modelName, parameters, openaiTools, token) {
  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);
  const mergedSystemInstruction = extractSystemInstruction(openaiMessages);

  let startIndex = 0;
  if (config.useContextSystemPrompt) {
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
          mode: 'VALIDATED'
        }
      },
      generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
      sessionId: token.sessionId
    },
    model: actualModelName,
    userAgent: 'antigravity'
  };

  if (mergedSystemInstruction) {
    requestBody.request.systemInstruction = {
      role: 'user',
      parts: [{ text: mergedSystemInstruction }]
    };
  }

  return requestBody;
}

function prepareImageRequest(requestBody) {
  if (!requestBody || !requestBody.request) return requestBody;
  requestBody.request.generationConfig = { candidateCount: 1 };
  requestBody.requestType = 'image_gen';
  delete requestBody.request.systemInstruction;
  delete requestBody.request.tools;
  delete requestBody.request.toolConfig;
  return requestBody;
}

function getDefaultIp() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const inter of iface) {
      if (inter.family === 'IPv4' && !inter.internal) {
        return inter.address;
      }
    }
  }
  return '127.0.0.1';
}

export {
  generateRequestId,
  generateRequestBody,
  prepareImageRequest,
  getDefaultIp
};
