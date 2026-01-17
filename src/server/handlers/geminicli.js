/**
 * Gemini CLI 格式处理器
 * 处理 /cli/v1/chat/completions 请求，支持流式和非流式响应
 */

import {
  generateStreamResponse,
  generateNoStreamResponse,
  getToken,
  recordRequest
} from '../../api/geminicli_client.js';
import {
  convertToGeminiCli,
  isFakeStreamingModel
} from '../../utils/converters/geminicli.js';
import { buildOpenAIErrorPayload } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';
import geminicliTokenManager from '../../auth/geminicli_token_manager.js';
import { createGeminiCliStreamWriter, writeGeminiCliFakeStreamResponse } from './geminicli/writers.js';
import { normalizeGeminiCliRequest } from './geminicli/normalizeRequest.js';
import { createGeminiResponse } from '../formatters/gemini.js';
import { createClaudeResponse } from '../formatters/claude.js';
import { createOpenAIChatCompletionResponse } from '../formatters/openai.js';
import {
  createResponseMeta,
  setStreamHeaders,
  createHeartbeat,
  writeStreamData,
  endStream,
  with429Retry
} from '../stream.js';
import { setSignature, getSignature, shouldCacheSignature, isImageModel } from '../../utils/thoughtSignatureCache.js';
import { getSafeRetries } from './common/retry.js';
import { disableTimeouts } from './common/timeouts.js';

/**
 * 处理 Gemini CLI 格式的聊天请求（支持 OpenAI/Gemini/Claude 格式）
 * @param {Request} req - Express请求对象
 * @param {Response} res - Express响应对象
 * @param {string} forceFormat - 强制指定格式（可选）：'openai' | 'gemini' | 'claude'
 */
export const handleGeminiCliRequest = async (req, res, forceFormat = null) => {
  const requestBody = req.body;

  const normalized = normalizeGeminiCliRequest(requestBody, forceFormat);
  if (!normalized.ok) {
    return res.status(normalized.status).json({ error: normalized.message });
  }

  const { format, stream, cleanedBody } = normalized;

  try {
    const token = await getToken();
    if (!token) {
      throw new Error('没有可用的 Gemini CLI token，请在管理页面添加账号');
    }
    const { geminiRequest, model: actualModel, features, sourceFormat } = convertToGeminiCli(cleanedBody);


    // 保存原始请求的模型名称用于响应
    const responseModel = requestBody.model || actualModel;

    const { id, created } = createResponseMeta();
    const safeRetries = getSafeRetries(config.retryTimes);

    // 假流式模式：使用非流式 API 获取数据，然后模拟流式输出
    const useFakeStreaming = features.fakeStreaming && stream;

    if (stream && !useFakeStreaming) {
      setStreamHeaders(res);

      // 启动心跳，防止超时断连
      const heartbeatTimer = createHeartbeat(res);

      try {
        const writer = createGeminiCliStreamWriter({
          format,
          res,
          id,
          created,
          responseModel
        });

        await with429Retry(
          () => generateStreamResponse(geminiRequest, token, actualModel, (data) => writer.onEvent(data)),
          safeRetries,
          '[GeminiCLI] chat.stream ',
          () => recordRequest(token)
        );

        writer.finalize();

        clearInterval(heartbeatTimer);
        endStream(res, false);
      } catch (error) {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          const statusCode = error.statusCode || error.status || 500;
          writeStreamData(res, buildOpenAIErrorPayload(error, statusCode));
          endStream(res, false);
        }
        logger.error('[GeminiCLI] 生成响应失败:', error.message);
        return;
      }
    } else if (useFakeStreaming) {
      // 假流式模式：使用非流式 API 获取数据，然后模拟流式输出
      setStreamHeaders(res);
      const heartbeatTimer = createHeartbeat(res);

      try {
        const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
          () => generateNoStreamResponse(geminiRequest, token, actualModel),
          safeRetries,
          '[GeminiCLI] chat.fake_stream ',
          () => recordRequest(token)
        );

        // 缓存签名（假流式响应）
        if (reasoningSignature && actualModel) {
          const hasTools = toolCalls && toolCalls.length > 0;
          const isImage = isImageModel(actualModel);
          if (shouldCacheSignature({ hasTools, isImageModel: isImage })) {
            setSignature(null, actualModel, reasoningSignature, reasoningContent || ' ', { hasTools, isImageModel: isImage });
          }
        }

        writeGeminiCliFakeStreamResponse({
          format,
          res,
          id,
          created,
          responseModel,
          content,
          reasoningContent,
          reasoningSignature,
          toolCalls,
          usage
        });

        clearInterval(heartbeatTimer);
        endStream(res, false);
      } catch (error) {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          const statusCode = error.statusCode || error.status || 500;
          writeStreamData(res, buildOpenAIErrorPayload(error, statusCode));
          endStream(res, false);
        }
        logger.error('[GeminiCLI] 假流式生成响应失败:', error.message);
        return;
      }
    } else {
      // 非流式请求
      disableTimeouts(req, res);

      const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        () => generateNoStreamResponse(geminiRequest, token, actualModel),
        safeRetries,
        '[GeminiCLI] chat.no_stream ',
        () => recordRequest(token)
      );

      // 处理签名：优先使用 API 返回的签名，否则使用缓存的签名
      const hasTools = toolCalls && toolCalls.length > 0;
      const isImage = isImageModel(actualModel);
      let finalReasoningSignature = reasoningSignature;
      let finalReasoningContent = reasoningContent;

      if (!finalReasoningSignature && actualModel) {
        // 尝试从缓存获取签名
        const cached = getSignature(null, actualModel, { hasTools });
        if (cached) {
          finalReasoningSignature = cached.signature;
          // 如果 API 没有返回思考内容，使用缓存的思考内容
          if (!finalReasoningContent && cached.content && cached.content !== ' ') {
            finalReasoningContent = cached.content;
          }
        }
      }

      // 缓存签名（非流式响应）
      if (finalReasoningSignature && actualModel) {
        if (shouldCacheSignature({ hasTools, isImageModel: isImage })) {
          setSignature(null, actualModel, finalReasoningSignature, finalReasoningContent || ' ', { hasTools, isImageModel: isImage });
        }
      }

      // 根据请求格式返回相应格式的响应
      if (format === 'gemini') {
        res.json(createGeminiResponse(
          content,
          finalReasoningContent || null,
          finalReasoningSignature || null,
          toolCalls,
          'STOP',
          usage,
          {
            passSignatureToClient: true,
            fallbackThoughtSignature: finalReasoningSignature || null
          }
        ));
      } else if (format === 'claude') {
        const claudeId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
        res.json(createClaudeResponse(
          claudeId,
          responseModel,
          content,
          finalReasoningContent || null,
          finalReasoningSignature || null,
          toolCalls,
          (toolCalls && toolCalls.length > 0) ? 'tool_use' : 'end_turn',
          usage,
          { passSignatureToClient: true }
        ));
      } else {
        res.json(createOpenAIChatCompletionResponse({
          id,
          created,
          model: responseModel,
          content,
          reasoningContent: finalReasoningContent || null,
          reasoningSignature: null,
          toolCalls,
          usage,
          passSignatureToClient: false,
          stripToolCallSignature: true
        }));
      }
    }
  } catch (error) {
    logger.error('[GeminiCLI] 生成响应失败:', error.message);
    if (res.headersSent) return;
    const statusCode = error.statusCode || error.status || 500;
    return res.status(statusCode).json(buildOpenAIErrorPayload(error, statusCode));
  }
};
