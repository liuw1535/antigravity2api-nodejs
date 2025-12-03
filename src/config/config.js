import dotenv from 'dotenv';
import fs from 'fs';
import log from '../utils/logger.js';

const envPath = '.env';
const defaultEnv = `# 服务器配置
PORT=8045
HOST=0.0.0.0

# API 配置
API_URL=https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse
API_MODELS_URL=https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels
API_NO_STREAM_URL=https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent
API_HOST=daily-cloudcode-pa.sandbox.googleapis.com
API_USER_AGENT=antigravity/1.11.3 windows/amd64

# 默认参数
DEFAULT_TEMPERATURE=1
DEFAULT_TOP_P=0.85
DEFAULT_TOP_K=50
DEFAULT_MAX_TOKENS=8096

# 安全配置
MAX_REQUEST_SIZE=50mb
API_KEY=sk-text

# 其他配置
USE_NATIVE_AXIOS=false
TIMEOUT=180000
# PROXY=http://127.0.0.1:7897
MAX_IMAGES=10 # 最多保存的图片个数，超过就会删除时间最旧的
# IMAGE_BASE_URL=http://your-domain.com  # 可选：自定义图片访问基础 URL，默认使用 局域网ip或者本地回环


# 系统提示词
SYSTEM_INSTRUCTION=你是聊天机器人，名字叫萌萌，如同名字这般，你的性格是软软糯糯萌萌哒的，专门为用户提供聊天和情绪价值，协助进行小说创作或者角色扮演
`;

if (!fs.existsSync(envPath)) {
  fs.writeFileSync(envPath, defaultEnv, 'utf8');
  log.info('✓ 已创建默认 .env 文件');
}

dotenv.config();

const config = {
  server: {
    port: parseInt(process.env.PORT) || 8045,
    host: process.env.HOST || '127.0.0.1'
  },
  imageBaseUrl: process.env.IMAGE_BASE_URL || null,
  maxImages: parseInt(process.env.MAX_IMAGES) || 10,
  api: {
    url: process.env.API_URL || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    modelsUrl: process.env.API_MODELS_URL || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
    noStreamUrl: process.env.API_NO_STREAM_URL || 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent',
    host: process.env.API_HOST || 'daily-cloudcode-pa.sandbox.googleapis.com',
    userAgent: process.env.API_USER_AGENT || 'antigravity/1.11.3 windows/amd64'
  },
  defaults: {
    temperature: parseFloat(process.env.DEFAULT_TEMPERATURE) || 1,
    top_p: parseFloat(process.env.DEFAULT_TOP_P) || 0.85,
    top_k: parseInt(process.env.DEFAULT_TOP_K) || 50,
    max_tokens: parseInt(process.env.DEFAULT_MAX_TOKENS) || 8096
  },
  security: {
    maxRequestSize: process.env.MAX_REQUEST_SIZE || '50mb',
    apiKey: process.env.API_KEY || null
  },
  useNativeAxios: process.env.USE_NATIVE_AXIOS !== 'false',
  timeout: parseInt(process.env.TIMEOUT) || 30000,
  proxy: process.env.PROXY || null,
  tokenReuse: {
    retryCount: parseInt(process.env.RETRY_COUNT) || 3,
    retryDelay: parseInt(process.env.RETRY_DELAY) || 3000,
    singleTokenUseCount: parseInt(process.env.SINGLE_TOKEN_USE_COUNT) || 10
  },
  systemInstruction: process.env.SYSTEM_INSTRUCTION || '你是聊天机器人，名字叫萌萌，如同名字这般，你的性格是软软糯糯萌萌哒的，专门为用户提供聊天和情绪价值，协助进行小说创作或者角色扮演'
};

log.info('✓ 配置加载成功');

export default config;
