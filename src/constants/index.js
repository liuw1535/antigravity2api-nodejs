/**
 * 应用常量定义
 * @module constants
 */

// ==================== 缓存相关常量 ====================

/**
 * 文件缓存有效期（毫秒）
 * @type {number}
 */
export const FILE_CACHE_TTL = 5000;

/**
 * 文件保存延迟（毫秒）- 用于 debounce
 * @type {number}
 */
export const FILE_SAVE_DELAY = 1000;

/**
 * 额度缓存有效期（毫秒）- 5分钟
 * @type {number}
 */
export const QUOTA_CACHE_TTL = 5 * 60 * 1000;

/**
 * 额度清理间隔（毫秒）- 1小时
 * @type {number}
 */
export const QUOTA_CLEANUP_INTERVAL = 60 * 60 * 1000;

/**
 * 模型列表缓存默认有效期（毫秒）- 1小时
 * @type {number}
 */
export const MODEL_LIST_CACHE_TTL = 60 * 60 * 1000;

// ==================== 内存管理常量 ====================

/**
 * 内存压力阈值（字节）
 */
export const MEMORY_THRESHOLDS = {
  /** 低压力阈值 - 15MB */
  LOW: 15 * 1024 * 1024,
  /** 中等压力阈值 - 25MB */
  MEDIUM: 25 * 1024 * 1024,
  /** 高压力阈值 - 35MB */
  HIGH: 35 * 1024 * 1024,
  /** 目标内存 - 20MB */
  TARGET: 20 * 1024 * 1024
};

/**
 * GC 冷却时间（毫秒）
 * @type {number}
 */
export const GC_COOLDOWN = 10000;

/**
 * 默认内存检查间隔（毫秒）
 * @type {number}
 */
export const MEMORY_CHECK_INTERVAL = 30000;

// ==================== 服务器相关常量 ====================

/**
 * 默认心跳间隔（毫秒）
 * @type {number}
 */
export const DEFAULT_HEARTBEAT_INTERVAL = 15000;

/**
 * 默认服务器端口
 * @type {number}
 */
export const DEFAULT_SERVER_PORT = 8045;

/**
 * 默认服务器主机
 * @type {string}
 */
export const DEFAULT_SERVER_HOST = '0.0.0.0';

/**
 * 默认请求超时（毫秒）
 * @type {number}
 */
export const DEFAULT_TIMEOUT = 300000;

/**
 * 默认重试次数
 * @type {number}
 */
export const DEFAULT_RETRY_TIMES = 3;

/**
 * 默认最大请求体大小
 * @type {string}
 */
export const DEFAULT_MAX_REQUEST_SIZE = '50mb';

// ==================== Token 轮询相关常量 ====================

/**
 * 默认每个 Token 请求次数后切换
 * @type {number}
 */
export const DEFAULT_REQUEST_COUNT_PER_TOKEN = 50;

/**
 * Token 过期提前刷新时间（毫秒）- 5分钟
 * @type {number}
 */
export const TOKEN_REFRESH_BUFFER = 300000;

// ==================== 生成参数默认值 ====================

/**
 * 默认生成参数
 */
export const DEFAULT_GENERATION_PARAMS = {
  temperature: 1,
  top_p: 0.85,
  top_k: 50,
  max_tokens: 32000,
  thinking_budget: 1024
};

/**
 * reasoning_effort 到 thinkingBudget 的映射
 */
export const REASONING_EFFORT_MAP = {
  low: 1024,
  medium: 16000,
  high: 32000
};

// ==================== 图片相关常量 ====================

/**
 * 默认最大保留图片数量
 * @type {number}
 */
export const DEFAULT_MAX_IMAGES = 10;

/**
 * MIME 类型到文件扩展名映射
 */
export const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

// ==================== 停止序列 ====================

/**
 * 默认停止序列
 * @type {string[]}
 */
export const DEFAULT_STOP_SEQUENCES = [
  '<|user|>',
  '<|bot|>',
  '<|context_request|>',
  '<|endoftext|>',
  '<|end_of_turn|>'
];

// ==================== 管理员默认配置 ====================

/**
 * 默认管理员用户名
 * @type {string}
 */
export const DEFAULT_ADMIN_USERNAME = 'admin';

/**
 * 默认管理员密码
 * @type {string}
 */
export const DEFAULT_ADMIN_PASSWORD = 'admin123';

/**
 * 默认 JWT 密钥（生产环境应更改）
 * @type {string}
 */
export const DEFAULT_JWT_SECRET = 'your-jwt-secret-key-change-this-in-production';