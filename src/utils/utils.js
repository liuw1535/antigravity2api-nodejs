import log from './logger.js';
import config from '../config/config.js';
import tokenManager from '../auth/token_manager.js';
import { generateRequestId } from './idGenerator.js';
import os from 'os';


// Simple hash for correlation logging
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).substring(0, 8);
}

// Module-level map to track toolCallId -> functionName for matching responses
const toolCallIdToName = new Map();

async function extractImagesFromContent(content, modelName) {
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
        const imageUrl = item.image_url?.url || '';

        // Handle Public URLs for Claude (Async Fetch)
        if (modelName && modelName.includes('claude') && imageUrl.startsWith('http')) {
          try {
            const resp = await fetch(imageUrl);
            if (resp.ok) {
              const buf = await resp.arrayBuffer();
              const base64Data = Buffer.from(buf).toString('base64');
              const mimeType = resp.headers.get('content-type') || 'image/jpeg';
              result.images.push({
                inlineData: {
                  mimeType: mimeType,
                  data: base64Data
                }
              });
              continue; // Skip base64 check
            }
          } catch (e) {
            log.error('Failed to fetch image url:', imageUrl, e);
          }
        }

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
function handleUserMessage(extracted, antigravityMessages) {
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
function handleAssistantMessage(message, antigravityMessages, modelName) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const hasThinking = !!message.thinking;
  const hasContent = (message.content && message.content.trim() !== '') || hasThinking;

  // Get the signature from the FIRST tool call (if any) to share with all parallel calls
  const firstSignature = hasToolCalls && message.tool_calls[0]?.function?.thought_signature;

  const antigravityTools = hasToolCalls ? message.tool_calls.map((toolCall, idx) => {
    // Generate ID if missing, or use existing
    const toolCallId = toolCall.id || `call_${simpleHash(toolCall.function.name + (toolCall.function.arguments || ''))}`;

    // Store mapping for later response matching
    toolCallIdToName.set(toolCallId, toolCall.function.name);

    const part = {
      functionCall: {
        name: toolCall.function.name,
        args: JSON.parse(toolCall.function.arguments || '{}'),
        id: toolCallId // ALWAYS include ID
      }
    };
    // Apply thoughtSignature to ALL parallel function calls in the turn
    // Use the signature from the first call (Gemini only provides it on first)
    // Or use individual signature if available
    const sig = toolCall.function.thought_signature || firstSignature;
    if (sig) {
      part.thoughtSignature = sig;
    }
    const callHash = simpleHash(toolCall.function.name + (toolCall.function.arguments || ''));
    log.debug(`[DEBUG] hash=${callHash} id=${toolCall.id || 'N/A'} Generated Antigravity Tool Part:`, JSON.stringify(part, null, 2));
    return part;
  }) : [];

  if (lastMessage?.role === "model" && hasToolCalls && !hasContent) {
    // If we are merging into a previous model message, we assume the previous message
    // ALREADY has the thinking block if it was required.
    // However, if the previous message was ALSO missing it, we might be propagating the error.
    // But typically merging happens when Stream splits Thought and Tool.
    lastMessage.parts.push(...antigravityTools)
  } else {
    const parts = [];
    if (hasContent) {
      // 1. Structured Thinking (from Router)
      if (message.thinking) {
        log.info(`[THOUGHT-IN] structured thinking found: sig=${message.thinking.signature}`);
        parts.push({
          text: message.thinking.content,
          thought: true,
          thoughtSignature: message.thinking.signature
        });
      }

      const content = (message.content && typeof message.content === 'string') ? message.content.trimEnd() : '';

      // 2. Parse Content for Thinking (Fallback if no structured thinking)
      const thinkMatch = (!message.thinking && modelName && modelName.includes('claude') && content) ? content.match(/<think(?:[\s\S]*?)>([\s\S]*?)<\/think(?:[\s\S]*?)>/) : null;
      if (thinkMatch) {
        log.info(`[THOUGHT-IN] regex match found in content. len=${thinkMatch[0].length}`);
        // Check for signature in attribute (legacy/Gemini) OR markdown comment (hidden)
        let signatureMatch = thinkMatch[0].match(/signature="([^"]+)"/);
        let signature = signatureMatch ? signatureMatch[1] : null;

        let thoughtText = thinkMatch[1].trim();

        // Check for signature in markdown comment inside content: <!-- signature="sig" -->
        const commentMatch = thoughtText.match(/<!-- signature="([^"]+)" -->/);
        if (commentMatch) {
          if (!signature) signature = commentMatch[1];
          // Remove the comment from the visible thought text
          thoughtText = thoughtText.replace(commentMatch[0], '').trim();
        }
        if (thoughtText) {
          const part = { text: thoughtText, thought: true };
          if (!signature) {
            log.warn('[THOUGHT-IN] Regex passed thinking WITHOUT signature! Using fallback.');
            signature = 'redacted_thinking';
          }
          part.thoughtSignature = signature;
          parts.push(part);
        }
        const remainingText = content.replace(thinkMatch[0], "").trim();
        if (remainingText) {
          parts.push({ text: remainingText });
        }
      } else if (!message.thinking && content) {
        log.info(`[THOUGHT-IN] Treating content as text. (No regex match).\nContent Start: ${content.substring(0, 50)}\nFull Content Length: ${content.length}`);
        // Optional: Log full content if short enough, or to a separate debug line
        if (content.length < 500) log.info(`[THOUGHT-IN-FULL] ${content}`);
        parts.push({ text: content });
      }
    }

    // SAFETY FIX: Check if we are missing a required thinking block
    // This happens if the client sends tool_calls but lost the thought history.
    /* 
    if (isEnableThinking(modelName) && modelName.includes('claude') && hasToolCalls && !parts.some(p => p.thought === true)) {
      log.warn(`[ThoughtFix] Missing thinking block for ${modelName} with tool_calls. Injecting redacted_thinking.`);
      parts.unshift({
        text: "Thinking Process (automatically added for protocol compliance)",
        thought: true,
        thoughtSignature: "AAAA" // Base64 placeholder (e.g. 0x00 0x00 0x00)
      });
    } 
    */

    parts.push(...antigravityTools);

    antigravityMessages.push({
      role: "model",
      parts
    })
  }
}
function handleToolCall(message, antigravityMessages) {
  // Look up function name from our Map
  let functionName = toolCallIdToName.get(message.tool_call_id) || '';

  // Fallback: search in previous model messages if not in Map
  if (!functionName) {
    for (let i = antigravityMessages.length - 1; i >= 0; i--) {
      if (antigravityMessages[i].role === 'model') {
        const parts = antigravityMessages[i].parts;
        for (const part of parts) {
          if (part.functionCall) {
            // This is a fallback - may not be accurate for multiple calls
            functionName = part.functionCall.name;
            break;
          }
        }
        if (functionName) break;
      }
    }
  }

  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const functionResponse = {
    functionResponse: {
      name: functionName,
      id: message.tool_call_id, // Add ID here for Claude compatibility
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
async function openaiMessageToAntigravity(openaiMessages, modelName) {
  const antigravityMessages = [];
  let systemText = "";
  const extractSystem = modelName && modelName.includes('claude');

  for (const message of openaiMessages) {
    if (message.role === "system") {
      if (extractSystem) {
        systemText += (systemText ? "\n" : "") + message.content;
      } else {
        // Fallback for non-Claude (Gemini): Treat as user message
        const extracted = await extractImagesFromContent(message.content, modelName);
        handleUserMessage(extracted, antigravityMessages);
      }
    } else if (message.role === "user") {
      const extracted = await extractImagesFromContent(message.content, modelName);
      handleUserMessage(extracted, antigravityMessages);
    } else if (message.role === "assistant") {
      handleAssistantMessage(message, antigravityMessages, modelName);
    } else if (message.role === "tool") {
      handleToolCall(message, antigravityMessages);
    }
  }

  return { contents: antigravityMessages, systemInstruction: systemText };
}
function generateGenerationConfig(parameters, enableThinking, actualModelName) {
  const generationConfig = {
    topP: parameters.top_p ?? config.defaults.top_p,
    topK: parameters.top_k ?? config.defaults.top_k,
    temperature: parameters.temperature ?? config.defaults.temperature,
    candidateCount: 1,
    maxOutputTokens: Math.max(parameters.max_tokens ?? config.defaults.max_tokens, enableThinking ? 16384 : 512),
    stopSequences: [
      "<|user|>",
      "<|bot|>",
      "<|context_request|>",
      "<|endoftext|>",
      "<|end_of_turn|>"
    ],
    thinkingConfig: {
      includeThoughts: enableThinking,
      thinkingBudget: enableThinking ? 1024 : 0
    }
  }
  if (enableThinking && actualModelName.includes("claude")) {
    delete generationConfig.topP;
  }
  return generationConfig
}
// Recursively sanitize schema for Claude compatibility
function sanitizeSchemaForClaude(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const unsupportedKeys = ['default', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'format', 'examples', 'const'];
  for (const key of unsupportedKeys) { delete schema[key]; }
  if (schema.properties) { for (const prop in schema.properties) { sanitizeSchemaForClaude(schema.properties[prop]); } }
  if (schema.items) { sanitizeSchemaForClaude(schema.items); }
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') { sanitizeSchemaForClaude(schema.additionalProperties); }
  return schema;
}

function convertOpenAIToolsToAntigravity(openaiTools, modelName) {
  if (!openaiTools || openaiTools.length === 0) return [];
  return openaiTools.map((tool) => {
    delete tool.function.parameters.$schema;
    if (modelName && modelName.includes("claude")) { sanitizeSchemaForClaude(tool.function.parameters); }
    return {
      functionDeclarations: [
        {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters
        }
      ]
    }
  })
}

function modelMapping(modelName) {
  if (modelName === "claude-sonnet-4-5-thinking") {
    return "claude-sonnet-4-5";
  } else if (modelName === "claude-opus-4-5") {
    return "claude-opus-4-5-thinking";
  } else if (modelName === "gemini-2.5-flash-thinking") {
    return "gemini-2.5-flash";
  }
  return modelName;
}

function isEnableThinking(modelName) {
  return modelName.endsWith('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === "rev19-uic3-1p" ||
    modelName === "gpt-oss-120b-medium"
}

async function generateRequestBody(openaiMessages, modelName, parameters, openaiTools, token) {

  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);

  const conversion = await openaiMessageToAntigravity(openaiMessages, actualModelName);
  const combinedSystem = (config.systemInstruction ? config.systemInstruction + "\n" : "") + conversion.systemInstruction;

  return {
    project: token.projectId,
    requestId: generateRequestId(),
    request: {
      contents: conversion.contents,
      systemInstruction: {
        role: "user",
        parts: [{ text: combinedSystem }]
      },
      tools: convertOpenAIToolsToAntigravity(openaiTools, actualModelName),
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
  }
}
function getDefaultIp() {
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
export {
  generateRequestId,
  generateRequestBody,
  getDefaultIp
}
