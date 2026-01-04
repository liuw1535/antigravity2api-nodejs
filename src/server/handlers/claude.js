/**
 * Claude 格式处理器
 * 处理 /v1/messages 请求，支持流式和非流式响应
 */

import { generateAssistantResponse, generateAssistantResponseNoStream } from '../../api/client.js';
import { generateClaudeRequestBody, prepareImageRequest } from '../../utils/utils.js';
import { normalizeClaudeParameters } from '../../utils/parameterNormalizer.js';
import { buildClaudeErrorPayload } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';
import tokenManager from '../../auth/token_manager.js';
import {
  setStreamHeaders,
  createHeartbeat,
  with429Retry
} from '../stream.js';

/**
 * 创建 Claude 流式事件
 * @param {string} eventType - 事件类型
 * @param {Object} data - 事件数据
 * @returns {string}
 */
export const createClaudeStreamEvent = (eventType, data) => {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
};

/**
 * 创建 Claude 非流式响应
 * @param {string} id - 消息ID
 * @param {string} model - 模型名称
 * @param {string|null} content - 文本内容
 * @param {string|null} reasoning - 思维链内容
 * @param {string|null} reasoningSignature - 思维链签名
 * @param {Array|null} toolCalls - 工具调用
 * @param {string} stopReason - 停止原因
 * @param {Object|null} usage - 使用量统计
 * @returns {Object}
 */
export const createClaudeResponse = (id, model, content, reasoning, reasoningSignature, toolCalls, stopReason, usage) => {
  const contentBlocks = [];
  
  // 思维链内容（如果有）- Claude 格式用 thinking 类型
  if (reasoning) {
    const thinkingBlock = {
      type: "thinking",
      thinking: reasoning
    };
    if (reasoningSignature && config.passSignatureToClient) {
      thinkingBlock.signature = reasoningSignature;
    }
    contentBlocks.push(thinkingBlock);
  }
  
  // 文本内容
  if (content) {
    contentBlocks.push({
      type: "text",
      text: content
    });
  }
  
  // 工具调用
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      try {
        const toolBlock = {
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments)
        };
        if (tc.thoughtSignature && config.passSignatureToClient) {
          toolBlock.signature = tc.thoughtSignature;
        }
        contentBlocks.push(toolBlock);
      } catch (e) {
        // 解析失败时传入空对象
        contentBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: {}
        });
      }
    }
  }

  return {
    id: id,
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model: model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usage ? {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0
    } : { input_tokens: 0, output_tokens: 0 }
  };
};

/**
 * 处理 Claude 格式的聊天请求
 * @param {Request} req - Express请求对象
 * @param {Response} res - Express响应对象
 * @param {boolean} isStream - 是否流式响应
 */
export const handleClaudeRequest = async (req, res, isStream) => {
  const { messages, model, system, tools, ...rawParams } = req.body;

  try {
    if (!messages) {
      return res.status(400).json(buildClaudeErrorPayload({ message: 'messages is required' }, 400));
    }

    const token = await tokenManager.getToken();
    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }

    // 使用统一参数规范化模块处理 Claude 格式参数
    const parameters = normalizeClaudeParameters(rawParams);

    const isImageModel = model.includes('-image');
    const requestBody = generateClaudeRequestBody(messages, model, parameters, tools, system, token);

    if (isImageModel) {
      prepareImageRequest(requestBody);
    }
    
    const msgId = `msg_${Date.now()}`;
    const maxRetries = Number(config.retryTimes || 0);
    const safeRetries = maxRetries > 0 ? Math.floor(maxRetries) : 0;
    
    if (isStream) {
      setStreamHeaders(res);
      const heartbeatTimer = createHeartbeat(res);
      
      try {
        let contentIndex = 0;
        let usageData = null;
        let hasToolCall = false;
        let currentBlockType = null;
        let reasoningSent = false;
        
        // 发送 message_start
        res.write(createClaudeStreamEvent('message_start', {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            content: [],
            model: model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        }));
        
        if (isImageModel) {
          // 生图模型：使用非流式获取结果后以流式格式返回
          const { content, usage } = await with429Retry(
            () => generateAssistantResponseNoStream(requestBody, token),
            safeRetries,
            'claude.stream.image '
          );
          
          // 发送文本块
          res.write(createClaudeStreamEvent('content_block_start', {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" }
          }));
          res.write(createClaudeStreamEvent('content_block_delta', {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: content || '' }
          }));
          res.write(createClaudeStreamEvent('content_block_stop', {
            type: "content_block_stop",
            index: 0
          }));
          
          // 发送 message_delta 和 message_stop
          res.write(createClaudeStreamEvent('message_delta', {
            type: "message_delta",
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: usage ? { output_tokens: usage.completion_tokens || 0 } : { output_tokens: 0 }
          }));
          res.write(createClaudeStreamEvent('message_stop', {
            type: "message_stop"
          }));
          
          clearInterval(heartbeatTimer);
          res.end();
          return;
        }
        
        await with429Retry(
          () => generateAssistantResponse(requestBody, token, (data) => {
            if (data.type === 'usage') {
              usageData = data.usage;
            } else if (data.type === 'reasoning') {
              // 思维链内容 - 使用 thinking 类型
              if (!reasoningSent) {
                // 开始思维块
                const contentBlock = { type: "thinking", thinking: "" };
                if (data.thoughtSignature && config.passSignatureToClient) {
                  contentBlock.signature = data.thoughtSignature;
                }
                res.write(createClaudeStreamEvent('content_block_start', {
                  type: "content_block_start",
                  index: contentIndex,
                  content_block: contentBlock
                }));
                currentBlockType = 'thinking';
                reasoningSent = true;
              }
              // 发送思维增量
              const delta = { type: "thinking_delta", thinking: data.reasoning_content || '' };
              if (data.thoughtSignature && config.passSignatureToClient) {
                delta.signature = data.thoughtSignature;
              }
              res.write(createClaudeStreamEvent('content_block_delta', {
                type: "content_block_delta",
                index: contentIndex,
                delta: delta
              }));
            } else if (data.type === 'tool_calls') {
              hasToolCall = true;
              // 结束之前的块（如果有）
              if (currentBlockType) {
                res.write(createClaudeStreamEvent('content_block_stop', {
                  type: "content_block_stop",
                  index: contentIndex
                }));
                contentIndex++;
              }
              // 工具调用
              for (const tc of data.tool_calls) {
                try {
                  const inputObj = JSON.parse(tc.function.arguments);
                  const toolContentBlock = { type: "tool_use", id: tc.id, name: tc.function.name, input: {} };
                  if (tc.thoughtSignature && config.passSignatureToClient) {
                    toolContentBlock.signature = tc.thoughtSignature;
                  }
                  res.write(createClaudeStreamEvent('content_block_start', {
                    type: "content_block_start",
                    index: contentIndex,
                    content_block: toolContentBlock
                  }));
                  // 发送 input 增量
                  res.write(createClaudeStreamEvent('content_block_delta', {
                    type: "content_block_delta",
                    index: contentIndex,
                    delta: { type: "input_json_delta", partial_json: JSON.stringify(inputObj) }
                  }));
                  res.write(createClaudeStreamEvent('content_block_stop', {
                    type: "content_block_stop",
                    index: contentIndex
                  }));
                  contentIndex++;
                } catch (e) {
                  // 解析失败，跳过
                }
              }
              currentBlockType = null;
            } else {
              // 普通文本内容
              if (currentBlockType === 'thinking') {
                // 结束思维块
                res.write(createClaudeStreamEvent('content_block_stop', {
                  type: "content_block_stop",
                  index: contentIndex
                }));
                contentIndex++;
                currentBlockType = null;
              }
              if (currentBlockType !== 'text') {
                // 开始文本块
                res.write(createClaudeStreamEvent('content_block_start', {
                  type: "content_block_start",
                  index: contentIndex,
                  content_block: { type: "text", text: "" }
                }));
                currentBlockType = 'text';
              }
              // 发送文本增量
              res.write(createClaudeStreamEvent('content_block_delta', {
                type: "content_block_delta",
                index: contentIndex,
                delta: { type: "text_delta", text: data.content || '' }
              }));
            }
          }),
          safeRetries,
          'claude.stream '
        );
        
        // 结束最后一个内容块
        if (currentBlockType) {
          res.write(createClaudeStreamEvent('content_block_stop', {
            type: "content_block_stop",
            index: contentIndex
          }));
        }
        
        // 发送 message_delta
        const stopReason = hasToolCall ? 'tool_use' : 'end_turn';
        res.write(createClaudeStreamEvent('message_delta', {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: usageData ? { output_tokens: usageData.completion_tokens || 0 } : { output_tokens: 0 }
        }));
        
        // 发送 message_stop
        res.write(createClaudeStreamEvent('message_stop', {
          type: "message_stop"
        }));
        
        clearInterval(heartbeatTimer);
        res.end();
      } catch (error) {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          const statusCode = error.statusCode || error.status || 500;
          res.write(createClaudeStreamEvent('error', buildClaudeErrorPayload(error, statusCode)));
          res.end();
        }
        logger.error('Claude 流式请求失败:', error.message);
        return;
      }
    } else {
      // 非流式请求
      req.setTimeout(0);
      res.setTimeout(0);
      
      const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        () => generateAssistantResponseNoStream(requestBody, token),
        safeRetries,
        'claude.no_stream '
      );
      
      const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
      const response = createClaudeResponse(
        msgId,
        model,
        content,
        reasoningContent,
        reasoningSignature,
        toolCalls,
        stopReason,
        usage
      );
      
      res.json(response);
    }
  } catch (error) {
    logger.error('Claude 请求失败:', error.message);
    if (res.headersSent) return;
    const statusCode = error.statusCode || error.status || 500;
    res.status(statusCode).json(buildClaudeErrorPayload(error, statusCode));
  }
};