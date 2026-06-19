/**
 * 日志工具模块
 * 支持控制台输出、WebSocket 实时推送、文件持久化
 */
import logWsServer from './logWsServer.js';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  blue: '\x1b[34m'
};

/**
 * 格式化日志参数为字符串
 */
function formatArgs(args) {
  return args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');
}

function logMessage(level, ...args) {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const color = { info: colors.green, warn: colors.yellow, error: colors.red, debug: colors.blue }[level];
  const message = formatArgs(args);

  // 输出到控制台
  console.log(`${colors.gray}${timestamp}${colors.reset} ${color}[${level}]${colors.reset}`, ...args);

  // 存储日志并推送 WebSocket
  logWsServer.storeLog(level, message);
}

function logRequest(method, path, status, duration, model, tokens) {
  const statusColor = status >= 500 ? colors.red : status >= 400 ? colors.yellow : colors.green;
  const modelInfo = model ? ` [${model}]` : '';
  const tokensInfo = tokens ? ` tokens:${tokens}` : '';
  const message = `[${method}] - ${path}${modelInfo} ${status} ${duration}ms${tokensInfo}`;

  // 输出到控制台
  console.log(`${colors.cyan}[${method}]${colors.reset} - ${path}${colors.cyan}${modelInfo}${colors.reset} ${statusColor}${status}${colors.reset} ${colors.gray}${duration}ms${colors.reset}${colors.yellow}${tokensInfo}${colors.reset}`);

  // 存储日志（根据状态码决定级别）
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'request';
  logWsServer.storeLog(level, message);
}

export const log = {
  info: (...args) => logMessage('info', ...args),
  warn: (...args) => logMessage('warn', ...args),
  error: (...args) => logMessage('error', ...args),
  debug: (...args) => logMessage('debug', ...args),
  request: logRequest,
  // API 方法（委托给 logWsServer）
  getLogs: (options) => logWsServer.getLogs(options),
  clearLogs: () => logWsServer.clearLogs(),
  getLogStats: () => logWsServer.getLogStats()
};

export default log;
