/**
 * Gemini 格式处理器
 * 处理 /v1beta/models/* 请求，支持流式和非流式响应
 */

import { generateAssistantResponse, generateAssistantResponseNoStream, getAvailableModels } from '../../api/client.js';
import { generateGeminiRequestBody, prepareImageRequest } from '../../utils/utils.js';
import { buildGeminiErrorPayload } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';
import tokenManager from '../../auth/token_manager.js';
import { createGeminiResponse } from '../formatters/gemini.js';
import { validateIncomingChatRequest } from '../validators/chat.js';
import { getSafeRetries } from './common/retry.js';
import {
  setStreamHeaders,
  createHeartbeat,
  writeStreamData,
  endStream,
  with429Retry
} from '../stream.js';

/**
 * 将 OpenAI 模型列表转换为 Gemini 格式
 * @param {Object} openaiModels - OpenAI格式模型列表
 * @returns {Object}
 */
export const convertToGeminiModelList = (openaiModels) => {
  const models = openaiModels.data.map(model => ({
    name: `models/${model.id}`,
    version: "001",
    displayName: model.id,
    description: "Imported model",
    inputTokenLimit: 32768, // 默认值
    outputTokenLimit: 8192, // 默认值
    supportedGenerationMethods: ["generateContent", "countTokens"],
    temperature: 0.9,
    topP: 1.0,
    topK: 40
  }));
  return { models };
};

/**
 * 获取 Gemini 格式模型列表
 * @param {Request} req - Express请求对象
 * @param {Response} res - Express响应对象
 */
export const handleGeminiModelsList = async (req, res) => {
  try {
    const openaiModels = await getAvailableModels();
    const geminiModels = convertToGeminiModelList(openaiModels);
    res.json(geminiModels);
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    res.status(500).json({ error: { code: 500, message: error.message, status: "INTERNAL" } });
  }
};

/**
 * 获取单个模型详情（Gemini格式）
 * @param {Request} req - Express请求对象
 * @param {Response} res - Express响应对象
 */
export const handleGeminiModelDetail = async (req, res) => {
  try {
    const modelId = req.params.model.replace(/^models\//, '');
    const openaiModels = await getAvailableModels();
    const model = openaiModels.data.find(m => m.id === modelId);

    if (model) {
      const geminiModel = {
        name: `models/${model.id}`,
        version: "001",
        displayName: model.id,
        description: "Imported model",
        inputTokenLimit: 32768,
        outputTokenLimit: 8192,
        supportedGenerationMethods: ["generateContent", "countTokens"],
        temperature: 0.9,
        topP: 1.0,
        topK: 40
      };
      res.json(geminiModel);
    } else {
      res.status(404).json({ error: { code: 404, message: `Model ${modelId} not found`, status: "NOT_FOUND" } });
    }
  } catch (error) {
    logger.error('获取模型详情失败:', error.message);
    res.status(500).json({ error: { code: 500, message: error.message, status: "INTERNAL" } });
  }
};

/**
 * 处理 Gemini 格式的聊天请求
 * @param {Request} req - Express请求对象
 * @param {Response} res - Express响应对象
 * @param {string} modelName - 模型名称
 * @param {boolean} isStream - 是否流式响应
 */
export const handleGeminiRequest = async (req, res, modelName, isStream) => {
  const safeRetries = getSafeRetries(config.retryTimes);

  try {
    const body = req.body || {};
    const validation = validateIncomingChatRequest('gemini', body);
    if (!validation.ok) {
      return res.status(validation.status).json(buildGeminiErrorPayload({ message: validation.message }, validation.status));
    }

    const token = await tokenManager.getToken();
    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }

    const isImageModel = modelName.includes('-image');
    const requestBody = generateGeminiRequestBody(body, modelName, token);

    if (isImageModel) {
      prepareImageRequest(requestBody);
    }

    if (isStream) {
      setStreamHeaders(res);
      const heartbeatTimer = createHeartbeat(res);

      try {
        if (isImageModel) {
          // 生图模型：使用非流式获取结果后一次性返回
          const { content, usage, reasoningSignature } = await with429Retry(
            () => generateAssistantResponseNoStream(requestBody, token),
            safeRetries,
            'gemini.stream.image '
          );
          const chunk = createGeminiResponse(content, null, reasoningSignature, null, 'STOP', usage, { passSignatureToClient: config.passSignatureToClient });
          writeStreamData(res, chunk);
          clearInterval(heartbeatTimer);
          endStream(res, false);
          return;
        }

        let usageData = null;
        let hasToolCall = false;

        await with429Retry(
          () => generateAssistantResponse(requestBody, token, (data) => {
            if (data.type === 'usage') {
              usageData = data.usage;
            } else if (data.type === 'reasoning') {
              // Gemini 思考内容
              const chunk = createGeminiResponse(null, data.reasoning_content, data.thoughtSignature, null, null, null, { passSignatureToClient: config.passSignatureToClient });
              writeStreamData(res, chunk);
            } else if (data.type === 'tool_calls') {
              hasToolCall = true;
              // Gemini 工具调用
              const chunk = createGeminiResponse(null, null, null, data.tool_calls, null, null, { passSignatureToClient: config.passSignatureToClient });
              writeStreamData(res, chunk);
            } else {
              // 普通文本
              const chunk = createGeminiResponse(data.content, null, null, null, null, null, { passSignatureToClient: config.passSignatureToClient });
              writeStreamData(res, chunk);
            }
          }),
          safeRetries,
          'gemini.stream '
        );

        // 发送结束块和 usage
        const finishReason = hasToolCall ? "STOP" : "STOP"; // Gemini 工具调用也是 STOP
        const finalChunk = createGeminiResponse(null, null, null, null, finishReason, usageData, { passSignatureToClient: config.passSignatureToClient });
        writeStreamData(res, finalChunk);

        clearInterval(heartbeatTimer);
        endStream(res, false);
      } catch (error) {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          const statusCode = error.statusCode || error.status || 500;
          writeStreamData(res, buildGeminiErrorPayload(error, statusCode));
          endStream(res, false);
        }
        logger.error('Gemini 流式请求失败:', error.message);
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
          () => generateAssistantResponse(requestBody, token, (data) => {
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
          }),
          safeRetries,
          'gemini.fake_no_stream '
        );

        const finishReason = "STOP";
        const response = createGeminiResponse(content, reasoningContent || null, reasoningSignature, toolCalls, finishReason, usageData, { passSignatureToClient: config.passSignatureToClient });
        res.json(response);
      } catch (error) {
        logger.error('Gemini 假非流请求失败:', error.message);
        if (res.headersSent) return;
        const statusCode = error.statusCode || error.status || 500;
        res.status(statusCode).json(buildGeminiErrorPayload(error, statusCode));
      }
    } else {
      // 非流式
      req.setTimeout(0);
      res.setTimeout(0);

      const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        () => generateAssistantResponseNoStream(requestBody, token),
        safeRetries,
        'gemini.no_stream '
      );

      const finishReason = toolCalls.length > 0 ? "STOP" : "STOP";
      const response = createGeminiResponse(content, reasoningContent, reasoningSignature, toolCalls, finishReason, usage, { passSignatureToClient: config.passSignatureToClient });
      res.json(response);
    }
  } catch (error) {
    logger.error('Gemini 请求失败:', error.message);
    if (res.headersSent) return;
    const statusCode = error.statusCode || error.status || 500;
    res.status(statusCode).json(buildGeminiErrorPayload(error, statusCode));
  }
};
