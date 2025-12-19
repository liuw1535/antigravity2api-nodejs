import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { log } from '../utils/logger.js';
import { generateSessionId, generateProjectId } from '../utils/idGenerator.js';
import config, { getConfigJson } from '../config/config.js';
import { OAUTH_CONFIG } from '../constants/oauth.js';
import { buildAxiosRequestConfig } from '../utils/httpClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 检测是否在 pkg 打包环境中运行
const isPkg = typeof process.pkg !== 'undefined';

// 获取数据目录路径
// pkg 环境下使用可执行文件所在目录或当前工作目录
function getDataDir() {
  if (isPkg) {
    // pkg 环境：优先使用可执行文件旁边的 data 目录
    const exeDir = path.dirname(process.execPath);
    const exeDataDir = path.join(exeDir, 'data');
    // 检查是否可以在该目录创建文件
    try {
      if (!fs.existsSync(exeDataDir)) {
        fs.mkdirSync(exeDataDir, { recursive: true });
      }
      return exeDataDir;
    } catch (e) {
      // 如果无法创建，尝试当前工作目录
      const cwdDataDir = path.join(process.cwd(), 'data');
      try {
        if (!fs.existsSync(cwdDataDir)) {
          fs.mkdirSync(cwdDataDir, { recursive: true });
        }
        return cwdDataDir;
      } catch (e2) {
        // 最后使用用户主目录
        const homeDataDir = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.antigravity', 'data');
        if (!fs.existsSync(homeDataDir)) {
          fs.mkdirSync(homeDataDir, { recursive: true });
        }
        return homeDataDir;
      }
    }
  }
  // 开发环境
  return path.join(__dirname, '..', '..', 'data');
}

// 轮询策略枚举
const RotationStrategy = {
  ROUND_ROBIN: 'round_robin',           // 均衡负载：每次请求切换
  QUOTA_EXHAUSTED: 'quota_exhausted',   // 额度耗尽才切换
  REQUEST_COUNT: 'request_count'        // 自定义次数后切换
};

class TokenManager {
  constructor(filePath = path.join(getDataDir(), 'accounts.json')) {
    this.filePath = filePath;
    this.tokens = [];
    this.currentIndex = 0;
    
    // 轮询策略相关 - 使用原子操作避免锁
    this.rotationStrategy = RotationStrategy.ROUND_ROBIN;
    this.requestCountPerToken = 50;  // request_count 策略下每个token请求次数后切换
    this.tokenRequestCounts = new Map();  // 记录每个token的请求次数
    
    this.ensureFileExists();
    this.initialize();
  }

  ensureFileExists() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '[]', 'utf8');
      log.info('✓ 已创建账号配置文件');
    }
  }

  async initialize() {
    try {
      log.info('正在初始化token管理器...');
      const data = fs.readFileSync(this.filePath, 'utf8');
      let tokenArray = JSON.parse(data);
      
      this.tokens = tokenArray.filter(token => token.enable !== false).map(token => ({
        ...token,
        sessionId: generateSessionId()
      }));
      
      this.currentIndex = 0;
      this.tokenRequestCounts.clear();
      
      // 加载轮询策略配置
      this.loadRotationConfig();
      
      if (this.tokens.length === 0) {
        log.warn('⚠ 暂无可用账号，请使用以下方式添加：');
        log.warn('  方式1: 运行 npm run login 命令登录');
        log.warn('  方式2: 访问前端管理页面添加账号');
      } else {
        log.info(`成功加载 ${this.tokens.length} 个可用token`);
        if (this.rotationStrategy === RotationStrategy.REQUEST_COUNT) {
          log.info(`轮询策略: ${this.rotationStrategy}, 每token请求 ${this.requestCountPerToken} 次后切换`);
        } else {
          log.info(`轮询策略: ${this.rotationStrategy}`);
        }
      }
    } catch (error) {
      log.error('初始化token失败:', error.message);
      this.tokens = [];
    }
  }

  // 加载轮询策略配置
  loadRotationConfig() {
    try {
      const jsonConfig = getConfigJson();
      if (jsonConfig.rotation) {
        this.rotationStrategy = jsonConfig.rotation.strategy || RotationStrategy.ROUND_ROBIN;
        this.requestCountPerToken = jsonConfig.rotation.requestCount || 10;
      }
    } catch (error) {
      log.warn('加载轮询配置失败，使用默认值:', error.message);
    }
  }

  // 更新轮询策略（热更新）
  updateRotationConfig(strategy, requestCount) {
    if (strategy && Object.values(RotationStrategy).includes(strategy)) {
      this.rotationStrategy = strategy;
    }
    if (requestCount && requestCount > 0) {
      this.requestCountPerToken = requestCount;
    }
    // 重置计数器
    this.tokenRequestCounts.clear();
    if (this.rotationStrategy === RotationStrategy.REQUEST_COUNT) {
      log.info(`轮询策略已更新: ${this.rotationStrategy}, 每token请求 ${this.requestCountPerToken} 次后切换`);
    } else {
      log.info(`轮询策略已更新: ${this.rotationStrategy}`);
    }
  }

  async fetchProjectId(token) {
    const response = await axios(buildAxiosRequestConfig({
      method: 'POST',
      url: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
      headers: {
        'Host': 'daily-cloudcode-pa.sandbox.googleapis.com',
        'User-Agent': 'antigravity/1.11.9 windows/amd64',
        'Authorization': `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      data: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } })
    }));
    return response.data?.cloudaicompanionProject;
  }

  isExpired(token) {
    if (!token.timestamp || !token.expires_in) return true;
    const expiresAt = token.timestamp + (token.expires_in * 1000);
    return Date.now() >= expiresAt - 300000;
  }

  async refreshToken(token) {
    log.info('正在刷新token...');
    const body = new URLSearchParams({
      client_id: OAUTH_CONFIG.CLIENT_ID,
      client_secret: OAUTH_CONFIG.CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token
    });

    try {
      const response = await axios(buildAxiosRequestConfig({
        method: 'POST',
        url: OAUTH_CONFIG.TOKEN_URL,
        headers: {
          'Host': 'oauth2.googleapis.com',
          'User-Agent': 'Go-http-client/1.1',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept-Encoding': 'gzip'
        },
        data: body.toString()
      }));

      token.access_token = response.data.access_token;
      token.expires_in = response.data.expires_in;
      token.timestamp = Date.now();
      this.saveToFile(token);
      return token;
    } catch (error) {
      throw { statusCode: error.response?.status, message: error.response?.data || error.message };
    }
  }

  saveToFile(tokenToUpdate = null) {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const allTokens = JSON.parse(data);
      
      // 如果指定了要更新的token，直接更新它
      if (tokenToUpdate) {
        const index = allTokens.findIndex(t => t.refresh_token === tokenToUpdate.refresh_token);
        if (index !== -1) {
          const { sessionId, ...tokenToSave } = tokenToUpdate;
          allTokens[index] = tokenToSave;
        }
      } else {
        // 否则更新内存中的所有token
        this.tokens.forEach(memToken => {
          const index = allTokens.findIndex(t => t.refresh_token === memToken.refresh_token);
          if (index !== -1) {
            const { sessionId, ...tokenToSave } = memToken;
            allTokens[index] = tokenToSave;
          }
        });
      }
      
      fs.writeFileSync(this.filePath, JSON.stringify(allTokens, null, 2), 'utf8');
    } catch (error) {
      log.error('保存文件失败:', error.message);
    }
  }

  disableToken(token) {
    log.warn(`禁用token ...${token.access_token.slice(-8)}`)
    token.enable = false;
    this.saveToFile();
    this.tokens = this.tokens.filter(t => t.refresh_token !== token.refresh_token);
    this.currentIndex = this.currentIndex % Math.max(this.tokens.length, 1);
  }

  // 原子操作：获取并递增请求计数
  incrementRequestCount(tokenKey) {
    const current = this.tokenRequestCounts.get(tokenKey) || 0;
    const newCount = current + 1;
    this.tokenRequestCounts.set(tokenKey, newCount);
    return newCount;
  }

  // 原子操作：重置请求计数
  resetRequestCount(tokenKey) {
    this.tokenRequestCounts.set(tokenKey, 0);
  }

  // 判断是否应该切换到下一个token
  shouldRotate(token) {
    switch (this.rotationStrategy) {
      case RotationStrategy.ROUND_ROBIN:
        // 均衡负载：每次请求后都切换
        return true;
        
      case RotationStrategy.QUOTA_EXHAUSTED:
        // 额度耗尽才切换：检查token的hasQuota标记
        // 如果hasQuota为false，说明额度已耗尽，需要切换
        return token.hasQuota === false;
        
      case RotationStrategy.REQUEST_COUNT:
        // 自定义次数后切换
        const tokenKey = token.refresh_token;
        const count = this.incrementRequestCount(tokenKey);
        if (count >= this.requestCountPerToken) {
          this.resetRequestCount(tokenKey);
          return true;
        }
        return false;
        
      default:
        return true;
    }
  }

  // 标记token额度耗尽
  markQuotaExhausted(token) {
    token.hasQuota = false;
    this.saveToFile(token);
    log.warn(`...${token.access_token.slice(-8)}: 额度已耗尽，标记为无额度`);
    
    // 如果是额度耗尽策略，立即切换到下一个token
    if (this.rotationStrategy === RotationStrategy.QUOTA_EXHAUSTED) {
      this.currentIndex = (this.currentIndex + 1) % Math.max(this.tokens.length, 1);
    }
  }

  // 恢复token额度（用于额度重置后）
  restoreQuota(token) {
    token.hasQuota = true;
    this.saveToFile(token);
    log.info(`...${token.access_token.slice(-8)}: 额度已恢复`);
  }

  async getToken() {
    if (this.tokens.length === 0) return null;

    const totalTokens = this.tokens.length;
    const startIndex = this.currentIndex;

    for (let i = 0; i < totalTokens; i++) {
      const index = (startIndex + i) % totalTokens;
      const token = this.tokens[index];
      
      // 额度耗尽策略：跳过无额度的token
      if (this.rotationStrategy === RotationStrategy.QUOTA_EXHAUSTED && token.hasQuota === false) {
        continue;
      }
      
      try {
        if (this.isExpired(token)) {
          await this.refreshToken(token);
        }
        if (!token.projectId) {
          if (config.skipProjectIdFetch) {
            token.projectId = generateProjectId();
            this.saveToFile(token);
            log.info(`...${token.access_token.slice(-8)}: 使用随机生成的projectId: ${token.projectId}`);
          } else {
            try {
              const projectId = await this.fetchProjectId(token);
              if (projectId === undefined) {
                log.warn(`...${token.access_token.slice(-8)}: 无资格获取projectId，跳过保存`);
                this.disableToken(token);
                if (this.tokens.length === 0) return null;
                continue;
              }
              token.projectId = projectId;
              this.saveToFile(token);
            } catch (error) {
              log.error(`...${token.access_token.slice(-8)}: 获取projectId失败:`, error.message);
              continue;
            }
          }
        }
        
        // 更新当前索引
        this.currentIndex = index;
        
        // 根据策略决定是否切换
        if (this.shouldRotate(token)) {
          this.currentIndex = (this.currentIndex + 1) % totalTokens;
        }
        
        return token;
      } catch (error) {
        if (error.statusCode === 403 || error.statusCode === 400) {
          log.warn(`...${token.access_token.slice(-8)}: Token 已失效或错误，已自动禁用该账号`);
          this.disableToken(token);
          if (this.tokens.length === 0) return null;
        } else {
          log.error(`...${token.access_token.slice(-8)} 刷新失败:`, error.message);
        }
      }
    }

    // 如果所有token都无额度，重置所有token的额度状态并重试
    if (this.rotationStrategy === RotationStrategy.QUOTA_EXHAUSTED) {
      log.warn('所有token额度已耗尽，重置额度状态');
      this.tokens.forEach(t => {
        t.hasQuota = true;
      });
      this.saveToFile();
      // 返回第一个可用token
      return this.tokens[0] || null;
    }

    return null;
  }

  disableCurrentToken(token) {
    const found = this.tokens.find(t => t.access_token === token.access_token);
    if (found) {
      this.disableToken(found);
    }
  }

  // API管理方法
  async reload() {
    await this.initialize();
    log.info('Token已热重载');
  }

  addToken(tokenData) {
    try {
      this.ensureFileExists();
      const data = fs.readFileSync(this.filePath, 'utf8');
      const allTokens = JSON.parse(data);
      
      const newToken = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in || 3599,
        timestamp: tokenData.timestamp || Date.now(),
        enable: tokenData.enable !== undefined ? tokenData.enable : true
      };
      
      if (tokenData.projectId) {
        newToken.projectId = tokenData.projectId;
      }
      if (tokenData.email) {
        newToken.email = tokenData.email;
      }
      if (tokenData.hasQuota !== undefined) {
        newToken.hasQuota = tokenData.hasQuota;
      }
      
      allTokens.push(newToken);
      fs.writeFileSync(this.filePath, JSON.stringify(allTokens, null, 2), 'utf8');
      
      this.reload();
      return { success: true, message: 'Token添加成功' };
    } catch (error) {
      log.error('添加Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  updateToken(refreshToken, updates) {
    try {
      this.ensureFileExists();
      const data = fs.readFileSync(this.filePath, 'utf8');
      const allTokens = JSON.parse(data);
      
      const index = allTokens.findIndex(t => t.refresh_token === refreshToken);
      if (index === -1) {
        return { success: false, message: 'Token不存在' };
      }
      
      allTokens[index] = { ...allTokens[index], ...updates };
      fs.writeFileSync(this.filePath, JSON.stringify(allTokens, null, 2), 'utf8');
      
      this.reload();
      return { success: true, message: 'Token更新成功' };
    } catch (error) {
      log.error('更新Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  deleteToken(refreshToken) {
    try {
      this.ensureFileExists();
      const data = fs.readFileSync(this.filePath, 'utf8');
      const allTokens = JSON.parse(data);
      
      const filteredTokens = allTokens.filter(t => t.refresh_token !== refreshToken);
      if (filteredTokens.length === allTokens.length) {
        return { success: false, message: 'Token不存在' };
      }
      
      fs.writeFileSync(this.filePath, JSON.stringify(filteredTokens, null, 2), 'utf8');
      
      this.reload();
      return { success: true, message: 'Token删除成功' };
    } catch (error) {
      log.error('删除Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  getTokenList() {
    try {
      this.ensureFileExists();
      const data = fs.readFileSync(this.filePath, 'utf8');
      const allTokens = JSON.parse(data);
      
      return allTokens.map(token => ({
        refresh_token: token.refresh_token,
        access_token: token.access_token,
        access_token_suffix: token.access_token ? `...${token.access_token.slice(-8)}` : 'N/A',
        expires_in: token.expires_in,
        timestamp: token.timestamp,
        enable: token.enable !== false,
        projectId: token.projectId || null,
        email: token.email || null,
        hasQuota: token.hasQuota !== false
      }));
    } catch (error) {
      log.error('获取Token列表失败:', error.message);
      return [];
    }
  }

  // 获取当前轮询配置
  getRotationConfig() {
    return {
      strategy: this.rotationStrategy,
      requestCount: this.requestCountPerToken,
      currentIndex: this.currentIndex,
      tokenCounts: Object.fromEntries(this.tokenRequestCounts)
    };
  }
}

// 导出策略枚举
export { RotationStrategy };

const tokenManager = new TokenManager();
export default tokenManager;
