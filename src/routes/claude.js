/**
 * Claude API 路由
 * 处理 /v1/messages 和 /v1/models 端点（Claude 格式）
 */

import { Router } from 'express';
import { handleClaudeRequest, handleClaudeModelsList, handleClaudeModelDetail } from '../server/handlers/claude.js';

const router = Router();

/**
 * GET /v1/models (Claude 格式)
 * 获取可用模型列表
 * 注意：需要通过 x-api-key header 认证
 */
router.get('/models', (req, res, next) => {
  // 检查是否为 Claude 格式请求（通过 x-api-key 或 anthropic-version header）
  if (req.headers['x-api-key'] || req.headers['anthropic-version']) {
    return handleClaudeModelsList(req, res);
  }
  // 否则跳过，让 OpenAI 路由处理
  next('route');
});

/**
 * GET /v1/models/:model_id (Claude 格式)
 * 获取单个模型详情
 */
router.get('/models/:model_id', (req, res, next) => {
  // 检查是否为 Claude 格式请求
  if (req.headers['x-api-key'] || req.headers['anthropic-version']) {
    return handleClaudeModelDetail(req, res);
  }
  next('route');
});

/**
 * POST /v1/messages
 * 处理 Claude 消息请求
 */
router.post('/messages', (req, res) => {
  const isStream = req.body.stream === true;
  handleClaudeRequest(req, res, isStream);
});

export default router;