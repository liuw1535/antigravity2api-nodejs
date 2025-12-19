import config from '../config/config.js';

function extractSystemInstruction(openaiMessages) {
  const baseSystem = config.systemInstruction || '';
  if (!config.useContextSystemPrompt) {
    return baseSystem;
  }
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
      break;
    }
  }
  const parts = [];
  if (baseSystem.trim()) {
    parts.push(baseSystem.trim());
  }
  if (systemTexts.length > 0) {
    parts.push(systemTexts.join('\n\n'));
  }
  return parts.join('\n\n');
}

export { extractSystemInstruction };
