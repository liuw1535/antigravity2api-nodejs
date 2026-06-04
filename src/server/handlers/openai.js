/**
 * OpenAI 格式处理器
 * 处理 /v1/chat/completions 请求，支持流式和非流式响应
 */

import { generateAssistantResponse, generateAssistantResponseNoStream, getModelsWithQuotas } from '../../api/client.js';
import { generateRequestBody, prepareImageRequest } from '../../utils/utils.js';
import { buildOpenAIErrorPayload } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';
import tokenManager from '../../auth/token_manager.js';
import quotaManager from '../../auth/quota_manager.js';
import { recordUsageAttemptFailure, setUsageMetrics } from '../../utils/usageStats.js';
import {
  createOpenAIStreamChunk as createStreamChunk,
  createOpenAIChatCompletionResponse
} from '../formatters/openai.js';
import { validateIncomingChatRequest } from '../validators/chat.js';
import { getSafeRetries } from './common/retry.js';
import {
  createResponseMeta,
  setStreamHeaders,
  createHeartbeat,
  writeStreamData,
  endStream,
  with429Retry
} from '../stream.js';

/**
 * 处理 OpenAI 格式的聊天请求
 * @param {Request} req - Express请求对象
 * @param {Response} res - Express响应对象
 */
export const handleOpenAIRequest = async (req, res) => {
  const body = req.body || {};
  const { messages, model, stream = false, tools, ...params } = body;

  try {
    const validation = validateIncomingChatRequest('openai', body);
    if (!validation.ok) {
      return res.status(validation.status).json({ error: validation.message });
    }
    if (typeof model !== 'string' || !model) {
      return res.status(400).json({ error: 'model is required' });
    }

    const isImageModel = model.includes('-image');
    let token = null;
    let tokenId = null;
    let requestBody = null;

    const applyTokenState = async (nextToken) => {
      if (!nextToken) return false;

      token = nextToken;
      tokenId = await tokenManager.getTokenId(token);
      requestBody = generateRequestBody(messages, model, params, tools, token);
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
    //console.log(JSON.stringify(requestBody,null,2));
    const { id, created } = createResponseMeta();
    const safeRetries = getSafeRetries(config.retryTimes);

    if (stream) {
      setStreamHeaders(res);

      // 启动心跳，防止 Cloudflare 超时断连
      const heartbeatTimer = createHeartbeat(res);

      try {
        if (isImageModel) {
          const { content, usage, reasoningSignature } = await with429Retry(
            (attempt, shouldUseCredits) => {
              const actualRequestBody = shouldUseCredits 
                ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
                : requestBody;
              return generateAssistantResponseNoStream(actualRequestBody, token);
            },
            safeRetries,
            createRetryOptions('chat.stream.image ')
          );
          const delta = { content };
          if (reasoningSignature && config.passSignatureToClient) {
            delta.thoughtSignature = reasoningSignature;
          }
          writeStreamData(res, createStreamChunk(id, created, model, delta));
          setUsageMetrics(req, { model, usage });
          writeStreamData(res, { ...createStreamChunk(id, created, model, {}, 'stop'), usage });
        } else {
          let hasToolCall = false;
          let usageData = null;

          await with429Retry(
            (attempt, shouldUseCredits) => {
              const actualRequestBody = shouldUseCredits 
                ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
                : requestBody;
              return generateAssistantResponse(actualRequestBody, token, (data) => {
                if (data.type === 'usage') {
                  usageData = data.usage;
                } else if (data.type === 'reasoning') {
                  const delta = { reasoning_content: data.reasoning_content };
                  if (data.thoughtSignature && config.passSignatureToClient) {
                    delta.thoughtSignature = data.thoughtSignature;
                  }
                  writeStreamData(res, createStreamChunk(id, created, model, delta));
                } else if (data.type === 'tool_calls') {
                  hasToolCall = true;
                  // 根据配置决定是否透传工具调用中的签名
                  const toolCallsWithIndex = data.tool_calls.map((toolCall, index) => {
                    if (config.passSignatureToClient) {
                      return { index, ...toolCall };
                    } else {
                      const { thoughtSignature, ...rest } = toolCall;
                      return { index, ...rest };
                    }
                  });
                  const delta = { tool_calls: toolCallsWithIndex };
                  writeStreamData(res, createStreamChunk(id, created, model, delta));
                } else {
                  const delta = { content: data.content };
                  writeStreamData(res, createStreamChunk(id, created, model, delta));
                }
              });
            },
            safeRetries,
            createRetryOptions('chat.stream ')
          );

          setUsageMetrics(req, { model, usage: usageData });
          writeStreamData(res, { ...createStreamChunk(id, created, model, {}, hasToolCall ? 'tool_calls' : 'stop'), usage: usageData });
        }

        clearInterval(heartbeatTimer);
        endStream(res);
      } catch (error) {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          const statusCode = error.statusCode || error.status || 500;
          writeStreamData(res, buildOpenAIErrorPayload(error, statusCode));
          endStream(res);
        }
        logger.error('生成响应失败:', error.message);
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
          createRetryOptions('chat.fake_no_stream ')
        );

        // 构建非流式响应
        const message = { role: 'assistant' };
        if (reasoningContent) message.reasoning_content = reasoningContent;
        if (reasoningSignature && config.passSignatureToClient) message.thoughtSignature = reasoningSignature;
        message.content = content;

        if (toolCalls.length > 0) {
          if (config.passSignatureToClient) {
            message.tool_calls = toolCalls;
          } else {
            message.tool_calls = toolCalls.map(({ thoughtSignature, ...rest }) => rest);
          }
        }

        setUsageMetrics(req, { model, usage: usageData });
        res.json(createOpenAIChatCompletionResponse({
          id,
          created,
          model,
          content,
          reasoningContent,
          reasoningSignature,
          toolCalls,
          usage: usageData,
          passSignatureToClient: config.passSignatureToClient,
          stripToolCallSignature: !config.passSignatureToClient
        }));
      } catch (error) {
        logger.error('假非流生成响应失败:', error.message);
        if (res.headersSent) return;
        const statusCode = error.statusCode || error.status || 500;
        return res.status(statusCode).json(buildOpenAIErrorPayload(error, statusCode));
      }
    } else {
      // 非流式请求：设置较长超时，避免大模型响应超时
      req.setTimeout(0); // 禁用请求超时
      res.setTimeout(0); // 禁用响应超时

      const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        (attempt, shouldUseCredits) => {
          const actualRequestBody = shouldUseCredits 
            ? { ...requestBody, enabledCreditTypes: ["GOOGLE_ONE_AI"] }
            : requestBody;
          return generateAssistantResponseNoStream(actualRequestBody, token);
        },
        safeRetries,
        createRetryOptions('chat.no_stream ')
      );

      // DeepSeek 格式：reasoning_content 在 content 之前
      const message = { role: 'assistant' };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      if (reasoningSignature && config.passSignatureToClient) message.thoughtSignature = reasoningSignature;
      message.content = content;

      if (toolCalls.length > 0) {
        // 根据配置决定是否透传工具调用中的签名
        if (config.passSignatureToClient) {
          message.tool_calls = toolCalls;
        } else {
          message.tool_calls = toolCalls.map(({ thoughtSignature, ...rest }) => rest);
        }
      }

      // 使用预构建的响应对象，减少内存分配
      setUsageMetrics(req, { model, usage });
      res.json(createOpenAIChatCompletionResponse({
        id,
        created,
        model,
        content,
        reasoningContent,
        reasoningSignature,
        toolCalls,
        usage,
        passSignatureToClient: config.passSignatureToClient,
        stripToolCallSignature: !config.passSignatureToClient
      }));
    }
  } catch (error) {
    logger.error('生成响应失败:', error.message);
    if (res.headersSent) return;
    const statusCode = error.statusCode || error.status || 500;
    return res.status(statusCode).json(buildOpenAIErrorPayload(error, statusCode));
  }
};
