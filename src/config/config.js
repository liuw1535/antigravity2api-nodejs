import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import log from '../utils/logger.js';
import { deepMerge } from '../utils/deepMerge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 检测是否在 pkg 打包环境中运行
const isPkg = typeof process.pkg !== 'undefined';

// 获取配置文件路径
// pkg 环境下使用可执行文件所在目录或当前工作目录
function getConfigPaths() {
  if (isPkg) {
    // pkg 环境：优先使用可执行文件旁边的配置文件
    const exeDir = path.dirname(process.execPath);
    const cwdDir = process.cwd();
    
    // 查找 .env 文件
    let envPath = path.join(exeDir, '.env');
    if (!fs.existsSync(envPath)) {
      const cwdEnvPath = path.join(cwdDir, '.env');
      if (fs.existsSync(cwdEnvPath)) {
        envPath = cwdEnvPath;
      }
    }
    
    // 查找 config.json 文件
    let configJsonPath = path.join(exeDir, 'config.json');
    if (!fs.existsSync(configJsonPath)) {
      const cwdConfigPath = path.join(cwdDir, 'config.json');
      if (fs.existsSync(cwdConfigPath)) {
        configJsonPath = cwdConfigPath;
      }
    }
    
    // 查找 .env.example 文件
    let examplePath = path.join(exeDir, '.env.example');
    if (!fs.existsSync(examplePath)) {
      const cwdExamplePath = path.join(cwdDir, '.env.example');
      if (fs.existsSync(cwdExamplePath)) {
        examplePath = cwdExamplePath;
      }
    }
    
    return { envPath, configJsonPath, examplePath };
  }
  
  // 开发环境
  return {
    envPath: path.join(__dirname, '../../.env'),
    configJsonPath: path.join(__dirname, '../../config.json'),
    examplePath: path.join(__dirname, '../../.env.example')
  };
}

const { envPath, configJsonPath, examplePath } = getConfigPaths();

// 确保 .env 存在
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
 */
export function buildConfig(jsonConfig) {
  return {
    server: {
      port: jsonConfig.server?.port || 8045,
      host: jsonConfig.server?.host || '0.0.0.0',
      heartbeatInterval: jsonConfig.server?.heartbeatInterval || 15000,
      memoryThreshold: jsonConfig.server?.memoryThreshold || 500
    },
    cache: {
      modelListTTL: jsonConfig.cache?.modelListTTL || 60 * 60 * 1000
    },
    rotation: {
      strategy: jsonConfig.rotation?.strategy || 'round_robin',
      requestCount: jsonConfig.rotation?.requestCount || 10
    },
    imageBaseUrl: process.env.IMAGE_BASE_URL || null,
    maxImages: jsonConfig.other?.maxImages || 10,
    api: {
      url: jsonConfig.api?.url || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
      modelsUrl: jsonConfig.api?.modelsUrl || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
      noStreamUrl: jsonConfig.api?.noStreamUrl || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent',
      host: jsonConfig.api?.host || 'daily-cloudcode-pa.sandbox.googleapis.com',
      userAgent: jsonConfig.api?.userAgent || 'antigravity/1.11.3 windows/amd64'
    },
    defaults: {
      temperature: jsonConfig.defaults?.temperature || 1,
      top_p: jsonConfig.defaults?.topP || 0.85,
      top_k: jsonConfig.defaults?.topK || 50,
      max_tokens: jsonConfig.defaults?.maxTokens || 32000,
      thinking_budget: jsonConfig.defaults?.thinkingBudget ?? 1024
    },
    security: {
      maxRequestSize: jsonConfig.server?.maxRequestSize || '50mb',
      apiKey: process.env.API_KEY || null
    },
    admin: {
      username: process.env.ADMIN_USERNAME || 'admin',
      password: process.env.ADMIN_PASSWORD || 'admin123',
      jwtSecret: process.env.JWT_SECRET || 'your-jwt-secret-key-change-this-in-production'
    },
    useNativeAxios: jsonConfig.other?.useNativeAxios !== false,
    timeout: jsonConfig.other?.timeout || 300000,
    retryTimes: Number.isFinite(jsonConfig.other?.retryTimes) ? jsonConfig.other.retryTimes : 3,
    proxy: getProxyConfig(),
    systemInstruction: process.env.SYSTEM_INSTRUCTION || '',
    skipProjectIdFetch: jsonConfig.other?.skipProjectIdFetch === true,
    useContextSystemPrompt: jsonConfig.other?.useContextSystemPrompt === true
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