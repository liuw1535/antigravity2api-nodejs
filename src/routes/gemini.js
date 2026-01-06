/**
 * Gemini API 路由
 * 同时支持 /v1/models/* 和 /v1beta/models/* 端点
 * Google 官方 API 已有 v1 稳定版，但 v1beta 仍然广泛使用
 */

import { Router } from 'express';
import { handleGeminiModelsList, handleGeminiModelDetail, handleGeminiRequest } from '../server/handlers/gemini.js';

const router = Router();

/**
 * GET /v1beta/models
 * 获取模型列表（Gemini格式）
 */
router.get('/models', handleGeminiModelsList);

/**
 * GET /v1beta/models/:model
 * 获取单个模型详情（Gemini格式）
 */
router.get('/models/:model', handleGeminiModelDetail);

/**
 * POST /v1beta/models/:model:streamGenerateContent
 * 流式生成内容
 */
router.post('/models/:model\\:streamGenerateContent', (req, res) => {
  const modelName = req.params.model;
  handleGeminiRequest(req, res, modelName, true);
});

/**
 * POST /v1beta/models/:model:generateContent
 * 生成内容（支持通过 alt=sse 参数启用流式）
 */
router.post('/models/:model\\:generateContent', (req, res) => {
  const modelName = req.params.model;
  const isStream = req.query.alt === 'sse';
  handleGeminiRequest(req, res, modelName, isStream);
});

export default router;