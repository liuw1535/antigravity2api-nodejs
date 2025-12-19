/**
 * 统一错误处理模块
 * @module utils/errors
 */

/**
 * 应用错误基类
 */
export class AppError extends Error {
  /**
   * @param {string} message - 错误消息
   * @param {number} statusCode - HTTP 状态码
   * @param {string} type - 错误类型
   */
  constructor(message, statusCode = 500, type = 'server_error') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.type = type;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 上游 API 错误
 */
export class UpstreamApiError extends AppError {
  /**
   * @param {string} message - 错误消息
   * @param {number} statusCode - HTTP 状态码
   * @param {string|Object} rawBody - 原始响应体
   */
  constructor(message, statusCode, rawBody = null) {
    super(message, statusCode, 'upstream_api_error');
    this.name = 'UpstreamApiError';
    this.rawBody = rawBody;
    this.isUpstreamApiError = true;
  }
}

/**
 * 认证错误
 */
export class AuthenticationError extends AppError {
  /**
   * @param {string} message - 错误消息
   */
  constructor(message = '认证失败') {
    super(message, 401, 'authentication_error');
    this.name = 'AuthenticationError';
  }
}

/**
 * 授权错误
 */
export class AuthorizationError extends AppError {
  /**
   * @param {string} message - 错误消息
   */
  constructor(message = '无权限访问') {
    super(message, 403, 'authorization_error');
    this.name = 'AuthorizationError';
  }
}

/**
 * 验证错误
 */
export class ValidationError extends AppError {
  /**
   * @param {string} message - 错误消息
   * @param {Object} details - 验证详情
   */
  constructor(message = '请求参数无效', details = null) {
    super(message, 400, 'validation_error');
    this.name = 'ValidationError';
    this.details = details;
  }
}

/**
 * 资源未找到错误
 */
export class NotFoundError extends AppError {
  /**
   * @param {string} message - 错误消息
   */
  constructor(message = '资源未找到') {
    super(message, 404, 'not_found');
    this.name = 'NotFoundError';
  }
}

/**
 * 速率限制错误
 */
export class RateLimitError extends AppError {
  /**
   * @param {string} message - 错误消息
   * @param {number} retryAfter - 重试等待时间（秒）
   */
  constructor(message = '请求过于频繁', retryAfter = null) {
    super(message, 429, 'rate_limit_error');
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Token 相关错误
 */
export class TokenError extends AppError {
  /**
   * @param {string} message - 错误消息
   * @param {string} tokenSuffix - Token 后缀（用于日志）
   * @param {number} statusCode - HTTP 状态码
   */
  constructor(message, tokenSuffix = null, statusCode = 500) {
    super(message, statusCode, 'token_error');
    this.name = 'TokenError';
    this.tokenSuffix = tokenSuffix;
  }
}

/**
 * 创建上游 API 错误（工厂函数）
 * @param {string} message - 错误消息
 * @param {number} status - HTTP 状态码
 * @param {string|Object} rawBody - 原始响应体
 * @returns {UpstreamApiError}
 */
export function createApiError(message, status, rawBody) {
  return new UpstreamApiError(message, status, rawBody);
}

/**
 * 构建 OpenAI 兼容的错误响应
 * @param {Error} error - 错误对象
 * @param {number} statusCode - HTTP 状态码
 * @returns {{error: {message: string, type: string, code: number}}}
 */
export function buildOpenAIErrorPayload(error, statusCode) {
  // 处理上游 API 错误
  if (error.isUpstreamApiError && error.rawBody) {
    try {
      const raw = typeof error.rawBody === 'string' ? JSON.parse(error.rawBody) : error.rawBody;
      const inner = raw.error || raw;
      return {
        error: {
          message: inner.message || error.message || 'Upstream API error',
          type: inner.type || 'upstream_api_error',
          code: inner.code ?? statusCode
        }
      };
    } catch {
      return {
        error: {
          message: error.rawBody || error.message || 'Upstream API error',
          type: 'upstream_api_error',
          code: statusCode
        }
      };
    }
  }

  // 处理应用错误
  if (error instanceof AppError) {
    return {
      error: {
        message: error.message,
        type: error.type,
        code: error.statusCode
      }
    };
  }

  // 处理通用错误
  return {
    error: {
      message: error.message || 'Internal server error',
      type: 'server_error',
      code: statusCode
    }
  };
}

/**
 * Express 错误处理中间件
 * @param {Error} err - 错误对象
 * @param {import('express').Request} req - 请求对象
 * @param {import('express').Response} res - 响应对象
 * @param {import('express').NextFunction} next - 下一个中间件
 */
export function errorHandler(err, req, res, next) {
  // 如果响应已发送，交给默认处理
  if (res.headersSent) {
    return next(err);
  }

  // 处理请求体过大错误
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: {
        message: '请求体过大',
        type: 'payload_too_large',
        code: 413
      }
    });
  }

  // 确定状态码
  const statusCode = err.statusCode || err.status || 500;
  
  // 构建错误响应
  const errorPayload = buildOpenAIErrorPayload(err, statusCode);
  
  return res.status(statusCode).json(errorPayload);
}

/**
 * 异步路由包装器（自动捕获异步错误）
 * @param {Function} fn - 异步路由处理函数
 * @returns {Function} 包装后的路由处理函数
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}