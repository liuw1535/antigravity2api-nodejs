import dotenv from 'dotenv';
import fs from 'fs';
import crypto from 'crypto';
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
  DEFAULT_GENERATION_PARAMS
} from '../constants/index.js';

// 生成随机凭据的缓存
let generatedCredentials = null;

/**
 * 生成或获取管理员凭据
 * 如果用户未配置，自动生成随机凭据
 */
function getAdminCredentials() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const jwtSecret = process.env.JWT_SECRET;
  
  // 如果全部配置了，直接返回
  if (username && password && jwtSecret) {
    return { username, password, jwtSecret };
  }
  
  // 生成随机凭据（只生成一次）
  if (!generatedCredentials) {
    generatedCredentials = {
      username: username || crypto.randomBytes(8).toString('hex'),
      password: password || crypto.randomBytes(16).toString('base64').replace(/[+/=]/g, ''),
      jwtSecret: jwtSecret || crypto.randomBytes(32).toString('hex')
    };
    
    // 显示生成的凭据
    if (!username || !password) {
      log.warn('═══════════════════════════════════════════════════════════');
      log.warn('⚠️  未配置管理员账号密码，已自动生成随机凭据：');
      log.warn(`    用户名: ${generatedCredentials.username}`);
      log.warn(`    密码:   ${generatedCredentials.password}`);
      log.warn('═══════════════════════════════════════════════════════════');
      log.warn('⚠️  重启后凭据将重新生成！建议在 .env 文件中配置：');
      log.warn('    ADMIN_USERNAME=你的用户名');
      log.warn('    ADMIN_PASSWORD=你的密码');
      log.warn('    JWT_SECRET=你的密钥');
      log.warn('═══════════════════════════════════════════════════════════');
    } else if (!jwtSecret) {
      log.warn('⚠️ 未配置 JWT_SECRET，已生成随机密钥（重启后登录会话将失效）');
    }
  }
  
  return generatedCredentials;
}

const { envPath, configJsonPath } = getConfigPaths();

// 默认系统提示词
const DEFAULT_SYSTEM_INSTRUCTION = '你是聊天机器人，名字叫萌萌，如同名字这般，你的性格是软软糯糯萌萌哒的，专门为用户提供聊天和情绪价值，协助进行小说创作或者角色扮演';

// 确保 .env 存在（如果缺失则创建带默认配置的文件）
if (!fs.existsSync(envPath)) {
  const defaultEnvContent = `# 敏感配置（只在 .env 中配置）
# 如果不配置以下三项，系统会自动生成随机凭据并在启动时显示
# API_KEY=your-api-key
# ADMIN_USERNAME=your-username
# ADMIN_PASSWORD=your-password
# JWT_SECRET=your-jwt-secret

# 可选配置
# PROXY=http://127.0.0.1:7890
SYSTEM_INSTRUCTION=${DEFAULT_SYSTEM_INSTRUCTION}
# IMAGE_BASE_URL=http://your-domain.com
`;
  fs.writeFileSync(envPath, defaultEnvContent, 'utf8');
  log.info('✓ 已创建 .env 文件，包含默认萌萌系统提示词');
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
      memoryThreshold: jsonConfig.server?.memoryThreshold || 100
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
    admin: getAdminCredentials(),
    useNativeAxios: jsonConfig.other?.useNativeAxios !== false,
    timeout: jsonConfig.other?.timeout || DEFAULT_TIMEOUT,
    retryTimes: Number.isFinite(jsonConfig.other?.retryTimes) ? jsonConfig.other.retryTimes : DEFAULT_RETRY_TIMES,
    proxy: getProxyConfig(),
    systemInstruction: process.env.SYSTEM_INSTRUCTION || '',
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