import dotenv from 'dotenv';
import fs from 'fs';
import log from '../utils/logger.js';
import { deepMerge } from '../utils/deepMerge.js';
import { getConfigPaths } from '../utils/paths.js';
import {
  DEFAULT_SERVER_PORT,
  DEFAULT_SERVER_HOST,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_TIMEOUT,
  DEFAULT_RETRY_TIMES,
  DEFAULT_MAX_REQUEST_SIZE,
  DEFAULT_MAX_IMAGES,
  MODEL_LIST_CACHE_TTL,
  DEFAULT_GENERATION_PARAMS,
  DEFAULT_ADMIN_USERNAME,
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_JWT_SECRET
} from '../constants/index.js';

const { envPath, configJsonPath, examplePath } = getConfigPaths();

// 确保 .env 存在（如果缺失则从 .env.example 复制一份）
if (!fs.existsSync(envPath)) {
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    log.info('✓ 已从 .env.example 创建 .env 文件');
  }
}

// 加载 config.json
let jsonConfig = {};
if (fs.existsSync(configJsonPath)) {
  jsonConfig = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
}

// 加载 .env（指定路径）
dotenv.config({ path: envPath });

// 获取代理配置：优先使用 PROXY，其次使用系统代理环境变量
export function getProxyConfig() {
  // 优先使用显式配置的 PROXY
  if (process.env.PROXY) {
    return process.env.PROXY;
  }
  
  // 检查系统代理环境变量（按优先级）
  const systemProxy = process.env.HTTPS_PROXY ||
                      process.env.https_proxy ||
                      process.env.HTTP_PROXY ||
                      process.env.http_proxy ||
                      process.env.ALL_PROXY ||
                      process.env.all_proxy;
  
  if (systemProxy) {
    log.info(`使用系统代理: ${systemProxy}`);
  }
  
  return systemProxy || null;
}

/**
 * 从 JSON 和环境变量构建配置对象
 * @param {Object} jsonConfig - JSON 配置对象
 * @returns {Object} 完整配置对象
 */
export function buildConfig(jsonConfig) {
  return {
    server: {
      port: jsonConfig.server?.port || DEFAULT_SERVER_PORT,
      host: jsonConfig.server?.host || DEFAULT_SERVER_HOST,
      heartbeatInterval: jsonConfig.server?.heartbeatInterval || DEFAULT_HEARTBEAT_INTERVAL,
      memoryThreshold: jsonConfig.server?.memoryThreshold || 500
    },
    cache: {
      modelListTTL: jsonConfig.cache?.modelListTTL || MODEL_LIST_CACHE_TTL
    },
    rotation: {
      strategy: jsonConfig.rotation?.strategy || 'round_robin',
      requestCount: jsonConfig.rotation?.requestCount || 10
    },
    imageBaseUrl: process.env.IMAGE_BASE_URL || null,
    maxImages: jsonConfig.other?.maxImages || DEFAULT_MAX_IMAGES,
    api: {
      url: jsonConfig.api?.url || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
      modelsUrl: jsonConfig.api?.modelsUrl || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
      noStreamUrl: jsonConfig.api?.noStreamUrl || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent',
      host: jsonConfig.api?.host || 'daily-cloudcode-pa.sandbox.googleapis.com',
      userAgent: jsonConfig.api?.userAgent || 'antigravity/1.11.3 windows/amd64'
    },
    defaults: {
      temperature: jsonConfig.defaults?.temperature ?? DEFAULT_GENERATION_PARAMS.temperature,
      top_p: jsonConfig.defaults?.topP ?? DEFAULT_GENERATION_PARAMS.top_p,
      top_k: jsonConfig.defaults?.topK ?? DEFAULT_GENERATION_PARAMS.top_k,
      max_tokens: jsonConfig.defaults?.maxTokens ?? DEFAULT_GENERATION_PARAMS.max_tokens,
      thinking_budget: jsonConfig.defaults?.thinkingBudget ?? DEFAULT_GENERATION_PARAMS.thinking_budget
    },
    security: {
      maxRequestSize: jsonConfig.server?.maxRequestSize || DEFAULT_MAX_REQUEST_SIZE,
      apiKey: process.env.API_KEY || null
    },
    admin: {
      username: process.env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
      jwtSecret: process.env.JWT_SECRET || DEFAULT_JWT_SECRET
    },
    useNativeAxios: jsonConfig.other?.useNativeAxios !== false,
    timeout: jsonConfig.other?.timeout || DEFAULT_TIMEOUT,
    retryTimes: Number.isFinite(jsonConfig.other?.retryTimes) ? jsonConfig.other.retryTimes : DEFAULT_RETRY_TIMES,
    proxy: getProxyConfig(),
    systemInstruction: process.env.SYSTEM_INSTRUCTION || '',
    skipProjectIdFetch: jsonConfig.other?.skipProjectIdFetch === true,
    useContextSystemPrompt: jsonConfig.other?.useContextSystemPrompt === true,
    passSignatureToClient: jsonConfig.other?.passSignatureToClient === true
  };
}

const config = buildConfig(jsonConfig);

log.info('✓ 配置加载成功');

export default config;

export function getConfigJson() {
  if (fs.existsSync(configJsonPath)) {
    return JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
  }
  return {};
}

export function saveConfigJson(data) {
  const existing = getConfigJson();
  const merged = deepMerge(existing, data);
  fs.writeFileSync(configJsonPath, JSON.stringify(merged, null, 2), 'utf8');
}