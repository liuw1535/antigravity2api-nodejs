import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import log from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, '../../.env');
const configJsonPath = path.join(__dirname, '../../config.json');

// 确保 .env 存在
if (!fs.existsSync(envPath)) {
  const examplePath = path.join(__dirname, '../../.env.example');
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

// 加载 .env
dotenv.config();

const config = {
  server: {
    port: jsonConfig.server?.port || 8045,
    host: jsonConfig.server?.host || '0.0.0.0'
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
    max_tokens: jsonConfig.defaults?.maxTokens || 8096
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
  timeout: jsonConfig.other?.timeout || 180000,
  proxy: process.env.PROXY || null,
  systemInstruction: process.env.SYSTEM_INSTRUCTION || '',
  skipProjectIdFetch: jsonConfig.other?.skipProjectIdFetch === true,
  imageOutputFormat: jsonConfig.other?.imageOutputFormat || 'url',  // 'url' 或 'base64'
  redis: {
    url: process.env.REDIS_URL || jsonConfig.redis?.url || null,
    keyPrefix: jsonConfig.redis?.keyPrefix || 'ag2api:'
  }
};

log.info('✓ 配置加载成功');

export default config;

export function getConfigJson() {
  if (fs.existsSync(configJsonPath)) {
    return JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
  }
  return {};
}

export function saveConfigJson(data) {
  fs.writeFileSync(configJsonPath, JSON.stringify(data, null, 2), 'utf8');
}
