/**
 * Claude 格式处理器
 * 处理 /v1/messages 请求，支持流式和非流式响应
 */

import { generateAssistantResponse, generateAssistantResponseNoStream, getModelsWithQuotas } from '../../api/client.js';
import { generateClaudeRequestBody, prepareImageRequest } from '../../utils/utils.js';
import { normalizeClaudeParameters } from '../../utils/parameterNormalizer.js';
import { buildClaudeErrorPayload } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';
import tokenManager from '../../auth/token_manager.js';
import quotaManager from '../../auth/quota_manager.js';
import { recordUsageAttemptFailure, setUsageMetrics } from '../../utils/usageStats.js';
import { createClaudeResponse } from '../formatters/claude.js';
import { validateIncomingChatRequest } from '../validators/chat.js';
import { getSafeRetries } from './common/retry.js';
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

/**
 * 处理 Claude 格式的聊天请求
 * @param {Request} req - Express请求对象
 * @param {Response} res - Express响应对象
 * @param {boolean} isStream - 是否流式响应
 */
export const handleClaudeRequest = async (req, res, isStream) => {
  const body = req.body || {};
  const { messages, model, system, tools, ...rawParams } = body;
  //console.log(JSON.stringify(body, null, 2))
  try {
    const validation = validateIncomingChatRequest('claude', body);
    if (!validation.ok) {
      return res.status(validation.status).json(buildClaudeErrorPayload({ message: validation.message }, validation.status));
    }
    if (typeof model !== 'string' || !model) {
      return res.status(400).json(buildClaudeErrorPayload({ message: 'model is required' }, 400));
    }

    // 使用统一参数规范化模块处理 Claude 格式参数
    const parameters = normalizeClaudeParameters(rawParams);

    const isImageModel = model.includes('-image');
    let token = null;
    let tokenId = null;
    let requestBody = null;

    const applyTokenState = async (nextToken) => {
      if (!nextToken) return false;

      token = nextToken;
      tokenId = await tokenManager.getTokenId(token);
      requestBody = generateClaudeRequestBody(messages, model, parameters, tools, system, token);
      if (isImageModel) {
        prepareImageRequest(requestBody);
      }
      return true;
    };

    if (!await applyTokenState(await tokenManager.getToken(model))) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }

    const refreshQuota = async () => {
      if (!tokenId || !token) return;
      const quotas = await getModelsWithQuotas(token);
      quotaManager.updateQuota(tokenId, quotas);
    };

    // 创建 with429Retry 选项
    const createRetryOptions = (prefix) => ({
      loggerPrefix: prefix,
      onAttempt: () => tokenManager.recordRequest(token, model),
      onAttemptFailure: () => recordUsageAttemptFailure(req, { model: model }),
      getTokenId: () => tokenId,
      modelId: model,
      refreshQuota,
      tokenManager,
      getToken: () => token,
      onBeforeRetry: async ({ previousTokenId }) => {
        const nextToken = await tokenManager.getTokenForRetry(model, previousTokenId);
        return applyTokenState(nextToken);
      }
    });

    const msgId = `msg_${Date.now()}`;
    const safeRetries = getSafeRetries(config.retryTimes);

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
            (attempt, shouldUseCredits) => {
              const actualRequestBody = shouldUseCredits
                ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
                : requestBody;
              return generateAssistantResponseNoStream(actualRequestBody, token);
            },
            safeRetries,
            createRetryOptions('claude.stream.image ')
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
          setUsageMetrics(req, { model, usage });
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
          (attempt, shouldUseCredits) => {
            const actualRequestBody = shouldUseCredits
              ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
              : requestBody;
            return generateAssistantResponse(actualRequestBody, token, (data) => {
              if (data.type === 'usage') {
                usageData = data.usage;
              } else if (data.type === 'reasoning') {
                // 思维链内容 - 使用 thinking 类型
                if (!reasoningSent) {
                  // 如果之前已经发送了 text block，先关闭它
                  if (currentBlockType === 'text') {
                    res.write(createClaudeStreamEvent('content_block_stop', {
                      type: "content_block_stop",
                      index: contentIndex
                    }));
                    contentIndex++;
                    currentBlockType = null;
                  }
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
                const textContent = data.content || '';

                // 如果 thinking 还没发送且内容是空的，跳过（避免在 thinking 之前创建空的 text block）
                if (!reasoningSent && !textContent) {
                  return;
                }

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
                  delta: { type: "text_delta", text: textContent }
                }));
              }
            });
          },
          safeRetries,
          createRetryOptions('claude.stream ')
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
        setUsageMetrics(req, { model, usage: usageData });
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
    } else if (config.fakeNonStream && !isImageModel) {
      // 假非流模式：使用流式API获取数据，组装成非流式响应
      req.setTimeout(0);
      res.setTimeout(0);

      let content = '';
      let reasoningContent = '';
      let reasoningSignature = null;
      const toolCalls = [];
      let usageData = null;

      try {
        await with429Retry(
          (attempt, shouldUseCredits) => {
            const actualRequestBody = shouldUseCredits
              ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
              : requestBody;
            return generateAssistantResponse(actualRequestBody, token, (data) => {
              if (data.type === 'usage') {
                usageData = data.usage;
              } else if (data.type === 'reasoning') {
                reasoningContent += data.reasoning_content || '';
                if (data.thoughtSignature) {
                  reasoningSignature = data.thoughtSignature;
                }
              } else if (data.type === 'tool_calls') {
                toolCalls.push(...data.tool_calls);
              } else if (data.type === 'text') {
                content += data.content || '';
              }
            });
          },
          safeRetries,
          createRetryOptions('claude.fake_no_stream ')
        );

        const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
        setUsageMetrics(req, { model, usage: usageData });
        const response = createClaudeResponse(
          msgId,
          model,
          content,
          reasoningContent || null,
          reasoningSignature,
          toolCalls,
          stopReason,
          usageData,
          { passSignatureToClient: config.passSignatureToClient }
        );

        res.json(response);
      } catch (error) {
        logger.error('Claude 假非流请求失败:', error.message);
        if (res.headersSent) return;
        const statusCode = error.statusCode || error.status || 500;
        res.status(statusCode).json(buildClaudeErrorPayload(error, statusCode));
      }
    } else {
      // 非流式请求
      req.setTimeout(0);
      res.setTimeout(0);

      const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        (attempt, shouldUseCredits) => {
          const actualRequestBody = shouldUseCredits
            ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
            : requestBody;
          return generateAssistantResponseNoStream(actualRequestBody, token);
        },
        safeRetries,
        createRetryOptions('claude.no_stream ')
      );

      const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
      setUsageMetrics(req, { model, usage });
      const response = createClaudeResponse(
        msgId,
        model,
        content,
        reasoningContent,
        reasoningSignature,
        toolCalls,
        stopReason,
        usage,
        { passSignatureToClient: config.passSignatureToClient }
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
