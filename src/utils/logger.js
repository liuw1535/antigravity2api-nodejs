const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

// Log level: 'debug' | 'info' | 'warn' | 'error'
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[LOG_LEVEL];
}

function logMessage(level, ...args) {
  if (!shouldLog(level)) return;
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const color = { debug: colors.gray, info: colors.green, warn: colors.yellow, error: colors.red }[level];
  console.log(`${colors.gray}${timestamp}${colors.reset} ${color}[${level}]${colors.reset}`, ...args);
}

function logRequest(method, path, status, duration) {
  if (!shouldLog('info')) return;
  const statusColor = status >= 500 ? colors.red : status >= 400 ? colors.yellow : colors.green;
  console.log(`${colors.cyan}[${method}]${colors.reset} - ${path} ${statusColor}${status}${colors.reset} ${colors.gray}${duration}ms${colors.reset}`);
}

export const log = {
  debug: (...args) => logMessage('debug', ...args),
  info: (...args) => logMessage('info', ...args),
  warn: (...args) => logMessage('warn', ...args),
  error: (...args) => logMessage('error', ...args),
  request: logRequest
};

export default log;
