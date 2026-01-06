/**
 * 服务器主入口
 * Express 应用配置、中间件、路由挂载、服务器启动和关闭
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { closeRequester } from '../api/client.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import memoryManager from '../utils/memoryManager.js';
import { getPublicDir, getRelativePath } from '../utils/paths.js';
import { errorHandler } from '../utils/errors.js';
import { getChunkPoolSize, clearChunkPool } from './stream.js';

// 路由模块
import adminRouter from '../routes/admin.js';
import sdRouter from '../routes/sd.js';
import openaiRouter from '../routes/openai.js';
import geminiRouter from '../routes/gemini.js';
import claudeRouter from '../routes/claude.js';

const publicDir = getPublicDir();

logger.info(`静态文件目录: ${getRelativePath(publicDir)}`);

const app = express();

// ==================== 内存管理 ====================
memoryManager.start(config.server.memoryCleanupInterval);

// ==================== 基础中间件 ====================
app.use(cors());
app.use(express.json({ limit: config.security.maxRequestSize }));

// 静态文件服务
app.use('/images', express.static(path.join(publicDir, 'images')));
app.use(express.static(publicDir));

// 管理路由
app.use('/admin', adminRouter);

// 使用统一错误处理中间件
app.use(errorHandler);

// ==================== 请求日志中间件 ====================
app.use((req, res, next) => {
  const ignorePaths = [
    '/images', '/favicon.ico', '/.well-known',
    '/sdapi/v1/options', '/sdapi/v1/samplers', '/sdapi/v1/schedulers',
    '/sdapi/v1/upscalers', '/sdapi/v1/latent-upscale-modes',
    '/sdapi/v1/sd-vae', '/sdapi/v1/sd-modules'
  ];
  // 提前获取完整路径，避免在路由处理后 req.path 被修改为相对路径
  const fullPath = req.originalUrl.split('?')[0];
  if (!ignorePaths.some(p => fullPath.startsWith(p))) {
    const start = Date.now();
    res.on('finish', () => {
      logger.request(req.method, fullPath, res.statusCode, Date.now() - start);
    });
  }
  next();
});

// SD API 路由
app.use('/sdapi/v1', sdRouter);

// ==================== API Key 验证中间件 ====================
app.use((req, res, next) => {
  if (req.path.startsWith('/v1/')) {
    const apiKey = config.security?.apiKey;
    if (apiKey) {
      const authHeader = req.headers.authorization || req.headers['x-api-key'];
      const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      if (providedKey !== apiKey) {
        logger.warn(`API Key 验证失败: ${req.method} ${req.path} (提供的Key: ${providedKey ? providedKey.substring(0, 10) + '...' : '无'})`);
        return res.status(401).json({ error: 'Invalid API Key' });
      }
    }
  } else if (req.path.startsWith('/v1beta/')) {
    const apiKey = config.security?.apiKey;
    if (apiKey) {
      const providedKey = req.query.key || req.headers['x-goog-api-key'];
      if (providedKey !== apiKey) {
        logger.warn(`API Key 验证失败: ${req.method} ${req.path} (提供的Key: ${providedKey ? providedKey.substring(0, 10) + '...' : '无'})`);
        return res.status(401).json({ error: 'Invalid API Key' });
      }
    }
  }
  next();
});

// ==================== API 路由 ====================

// Claude 兼容 API（先检查 Claude 格式，因为它有特殊的 header 判断）
app.use('/v1', claudeRouter);

// OpenAI 兼容 API
app.use('/v1', openaiRouter);

// Gemini 兼容 API（同时支持 v1 和 v1beta）
app.use('/v1beta', geminiRouter);
app.use('/v1', geminiRouter);

// ==================== 系统端点 ====================

// 内存监控端点
app.get('/v1/memory', (req, res) => {
  const usage = process.memoryUsage();
  res.json({
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    rss: usage.rss,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    poolSizes: memoryManager.getPoolSizes(),
    chunkPoolSize: getChunkPoolSize()
  });
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ==================== 服务器启动 ====================
const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`服务器已启动: ${config.server.host}:${config.server.port}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    logger.error(`端口 ${config.server.port} 无权限访问`);
    process.exit(1);
  } else {
    logger.error('服务器启动失败:', error.message);
    process.exit(1);
  }
});

// ==================== 优雅关闭 ====================
const shutdown = () => {
  logger.info('正在关闭服务器...');
  
  // 停止内存管理器
  memoryManager.stop();
  logger.info('已停止内存管理器');
  
  // 关闭子进程请求器
  closeRequester();
  logger.info('已关闭子进程请求器');
  
  // 清理对象池
  clearChunkPool();
  logger.info('已清理对象池');
  
  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
  
  // 5秒超时强制退出
  setTimeout(() => {
    logger.warn('服务器关闭超时，强制退出');
    process.exit(0);
  }, 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ==================== 异常处理 ====================
process.on('uncaughtException', (error) => {
  logger.error('未捕获异常:', error.message);
  // 不立即退出，让当前请求完成
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的 Promise 拒绝:', reason);
});
