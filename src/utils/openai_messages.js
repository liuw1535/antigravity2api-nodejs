import { getReasoningSignature, getToolSignature } from './thoughtSignatureCache.js';
import { setToolNameMapping } from './toolNameCache.js';
import { getThoughtSignatureForModel, getToolSignatureForModel } from './openai_signatures.js';

function extractImagesFromContent(content) {
  const result = { text: '', images: [] };
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        const imageUrl = item.image_url?.url || '';
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const format = match[1];
          const base64Data = match[2];
          result.images.push({
            inlineData: {
              mimeType: `image/${format}`,
              data: base64Data
            }
          });
        }
      }
    }
  }
  return result;
}

function handleUserMessage(extracted, antigravityMessages) {
  antigravityMessages.push({
    role: 'user',
    parts: [
      { text: extracted.text },
      ...extracted.images
    ]
  });
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

function handleAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const hasContent = message.content && message.content.trim() !== '';

  const antigravityTools = hasToolCalls
    ? message.tool_calls.map(toolCall => {
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

        if (sessionId && actualModelName && safeName !== originalName) {
          setToolNameMapping(sessionId, actualModelName, safeName, originalName);
        }

        if (enableThinking) {
          const cachedToolSig = getToolSignature(sessionId, actualModelName);
          part.thoughtSignature = toolCall.thoughtSignature || cachedToolSig || getToolSignatureForModel(actualModelName);
        }

        return part;
      })
    : [];

  if (lastMessage?.role === 'model' && hasToolCalls && !hasContent) {
    lastMessage.parts.push(...antigravityTools);
  } else {
    const parts = [];

    if (enableThinking) {
      const cachedSig = getReasoningSignature(sessionId, actualModelName);
      const thoughtSignature = message.thoughtSignature || cachedSig || getThoughtSignatureForModel(actualModelName);
      let reasoningText = '';
      if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
        reasoningText = message.reasoning_content;
      } else {
        reasoningText = ' ';
      }
      parts.push({ text: reasoningText, thought: true });
      parts.push({ text: ' ', thoughtSignature });
    }

    if (hasContent) parts.push({ text: message.content.trimEnd() });
    parts.push(...antigravityTools);

    antigravityMessages.push({
      role: 'model',
      parts
    });
  }
}

function handleToolCall(message, antigravityMessages) {
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

  if (lastMessage?.role === 'user' && lastMessage.parts.some(p => p.functionResponse)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({
      role: 'user',
      parts: [functionResponse]
    });
  }
}

function openaiMessageToAntigravity(openaiMessages, enableThinking, actualModelName, sessionId) {
  const antigravityMessages = [];
  for (const message of openaiMessages) {
    if (message.role === 'user' || message.role === 'system') {
      const extracted = extractImagesFromContent(message.content);
      handleUserMessage(extracted, antigravityMessages);
    } else if (message.role === 'assistant') {
      handleAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId);
    } else if (message.role === 'tool') {
      handleToolCall(message, antigravityMessages);
    }
  }
  return antigravityMessages;
}

export {
  extractImagesFromContent,
  handleUserMessage,
  sanitizeToolName,
  handleAssistantMessage,
  handleToolCall,
  openaiMessageToAntigravity
};
