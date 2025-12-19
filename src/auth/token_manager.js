import axios from 'axios';
import { log } from '../utils/logger.js';
import { generateSessionId, generateProjectId } from '../utils/idGenerator.js';
import config, { getConfigJson } from '../config/config.js';
import { OAUTH_CONFIG } from '../constants/oauth.js';
import { buildAxiosRequestConfig } from '../utils/httpClient.js';
import {
  DEFAULT_REQUEST_COUNT_PER_TOKEN,
  TOKEN_REFRESH_BUFFER
} from '../constants/index.js';
import TokenStore from './token_store.js';
import { TokenError } from '../utils/errors.js';

// 轮询策略枚举
const RotationStrategy = {
  ROUND_ROBIN: 'round_robin',           // 均衡负载：每次请求切换
  QUOTA_EXHAUSTED: 'quota_exhausted',   // 额度耗尽才切换
  REQUEST_COUNT: 'request_count'        // 自定义次数后切换
};

/**
 * Token 管理器
 * 负责 Token 的存储、轮询、刷新等功能
 */
class TokenManager {
  /**
   * @param {string} filePath - Token 数据文件路径
   */
  constructor(filePath) {
    this.store = new TokenStore(filePath);
    /** @type {Array<Object>} */
    this.tokens = [];
    /** @type {number} */
    this.currentIndex = 0;
    
    // 轮询策略相关 - 使用原子操作避免锁
    /** @type {string} */
    this.rotationStrategy = RotationStrategy.ROUND_ROBIN;
    /** @type {number} */
    this.requestCountPerToken = DEFAULT_REQUEST_COUNT_PER_TOKEN;
    /** @type {Map<string, number>} */
    this.tokenRequestCounts = new Map();
    
    // 针对额度耗尽策略的可用 token 索引缓存（优化大规模账号场景）
    /** @type {number[]} */
    this.availableQuotaTokenIndices = [];
    /** @type {number} */
    this.currentQuotaIndex = 0;

    /** @type {Promise<void>|null} */
    this._initPromise = null;
  }

  async _initialize() {
    try {
      log.info('正在初始化token管理器...');
      const tokenArray = await this.store.readAll();
      
      this.tokens = tokenArray.filter(token => token.enable !== false).map(token => ({
        ...token,
        sessionId: generateSessionId()
      }));
      
      this.currentIndex = 0;
      this.tokenRequestCounts.clear();
      this._rebuildAvailableQuotaTokens();
      
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
        
        // 并发刷新所有过期的 token
        await this._refreshExpiredTokensConcurrently();
      }
    } catch (error) {
      log.error('初始化token失败:', error.message);
      this.tokens = [];
    }
  }

  /**
   * 并发刷新所有过期的 token
   * @private
   */
  async _refreshExpiredTokensConcurrently() {
    const expiredTokens = this.tokens.filter(token => this.isExpired(token));
    if (expiredTokens.length === 0) {
      return;
    }

    log.info(`发现 ${expiredTokens.length} 个过期token，开始并发刷新...`);
    const startTime = Date.now();

    const results = await Promise.allSettled(
      expiredTokens.map(token => this._refreshTokenSafe(token))
    );

    let successCount = 0;
    let failCount = 0;
    const tokensToDisable = [];

    results.forEach((result, index) => {
      const token = expiredTokens[index];
      if (result.status === 'fulfilled') {
        if (result.value === 'success') {
          successCount++;
        } else if (result.value === 'disable') {
          tokensToDisable.push(token);
          failCount++;
        }
      } else {
        failCount++;
        log.error(`...${token.access_token?.slice(-8) || 'unknown'} 刷新失败:`, result.reason?.message || result.reason);
      }
    });

    // 批量禁用失效的 token
    for (const token of tokensToDisable) {
      this.disableToken(token);
    }

    const elapsed = Date.now() - startTime;
    log.info(`并发刷新完成: 成功 ${successCount}, 失败 ${failCount}, 耗时 ${elapsed}ms`);
  }

  /**
   * 安全刷新单个 token（不抛出异常）
   * @param {Object} token - Token 对象
   * @returns {Promise<'success'|'disable'|'skip'>} 刷新结果
   * @private
   */
  async _refreshTokenSafe(token) {
    try {
      await this.refreshToken(token);
      return 'success';
    } catch (error) {
      if (error.statusCode === 403 || error.statusCode === 400) {
        log.warn(`...${token.access_token?.slice(-8) || 'unknown'}: Token 已失效，将被禁用`);
        return 'disable';
      }
      throw error;
    }
  }

  async _ensureInitialized() {
    if (!this._initPromise) {
      this._initPromise = this._initialize();
    }
    return this._initPromise;
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

  // 重建额度耗尽策略下的可用 token 列表
  _rebuildAvailableQuotaTokens() {
    this.availableQuotaTokenIndices = [];
    this.tokens.forEach((token, index) => {
      if (token.enable !== false && token.hasQuota !== false) {
        this.availableQuotaTokenIndices.push(index);
      }
    });

    if (this.availableQuotaTokenIndices.length === 0) {
      this.currentQuotaIndex = 0;
    } else {
      this.currentQuotaIndex = this.currentQuotaIndex % this.availableQuotaTokenIndices.length;
    }
  }

  // 从额度耗尽策略的可用列表中移除指定下标
  _removeQuotaIndex(tokenIndex) {
    const pos = this.availableQuotaTokenIndices.indexOf(tokenIndex);
    if (pos !== -1) {
      this.availableQuotaTokenIndices.splice(pos, 1);
      if (this.currentQuotaIndex >= this.availableQuotaTokenIndices.length) {
        this.currentQuotaIndex = 0;
      }
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

  /**
   * 检查 Token 是否过期
   * @param {Object} token - Token 对象
   * @returns {boolean} 是否过期
   */
  isExpired(token) {
    if (!token.timestamp || !token.expires_in) return true;
    const expiresAt = token.timestamp + (token.expires_in * 1000);
    return Date.now() >= expiresAt - TOKEN_REFRESH_BUFFER;
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
      const statusCode = error.response?.status;
      const rawBody = error.response?.data;
      const suffix = token.access_token ? token.access_token.slice(-8) : null;
      const message = typeof rawBody === 'string' ? rawBody : (rawBody?.error?.message || error.message || '刷新 token 失败');
      throw new TokenError(message, suffix, statusCode || 500);
    }
  }

  saveToFile(tokenToUpdate = null) {
    // 保持与旧接口同步调用方式一致，内部使用异步写入
    this.store.mergeActiveTokens(this.tokens, tokenToUpdate).catch((error) => {
      log.error('保存账号配置文件失败:', error.message);
    });
  }

  disableToken(token) {
    log.warn(`禁用token ...${token.access_token.slice(-8)}`)
    token.enable = false;
    this.saveToFile();
    this.tokens = this.tokens.filter(t => t.refresh_token !== token.refresh_token);
    this.currentIndex = this.currentIndex % Math.max(this.tokens.length, 1);
    // tokens 结构发生变化时，重建额度耗尽策略下的可用列表
    this._rebuildAvailableQuotaTokens();
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
    
    if (this.rotationStrategy === RotationStrategy.QUOTA_EXHAUSTED) {
      const tokenIndex = this.tokens.findIndex(t => t.refresh_token === token.refresh_token);
      if (tokenIndex !== -1) {
        this._removeQuotaIndex(tokenIndex);
      }
      this.currentIndex = (this.currentIndex + 1) % Math.max(this.tokens.length, 1);
    }
  }

  // 恢复token额度（用于额度重置后）
  restoreQuota(token) {
    token.hasQuota = true;
    this.saveToFile(token);
    log.info(`...${token.access_token.slice(-8)}: 额度已恢复`);
  }

  /**
   * 准备单个 token（刷新 + 获取 projectId）
   * @param {Object} token - Token 对象
   * @returns {Promise<'ready'|'skip'|'disable'>} 处理结果
   * @private
   */
  async _prepareToken(token) {
    // 刷新过期 token
    if (this.isExpired(token)) {
      await this.refreshToken(token);
    }

    // 获取 projectId
    if (!token.projectId) {
      if (config.skipProjectIdFetch) {
        token.projectId = generateProjectId();
        this.saveToFile(token);
        log.info(`...${token.access_token.slice(-8)}: 使用随机生成的projectId: ${token.projectId}`);
      } else {
        const projectId = await this.fetchProjectId(token);
        if (projectId === undefined) {
          log.warn(`...${token.access_token.slice(-8)}: 无资格获取projectId，禁用账号`);
          return 'disable';
        }
        token.projectId = projectId;
        this.saveToFile(token);
      }
    }

    return 'ready';
  }

  /**
   * 处理 token 准备过程中的错误
   * @param {Error} error - 错误对象
   * @param {Object} token - Token 对象
   * @returns {'disable'|'skip'} 处理结果
   * @private
   */
  _handleTokenError(error, token) {
    const suffix = token.access_token?.slice(-8) || 'unknown';
    if (error.statusCode === 403 || error.statusCode === 400) {
      log.warn(`...${suffix}: Token 已失效或错误，已自动禁用该账号`);
      return 'disable';
    }
    log.error(`...${suffix} 操作失败:`, error.message);
    return 'skip';
  }

  /**
   * 重置所有 token 的额度状态
   * @private
   */
  _resetAllQuotas() {
    log.warn('所有token额度已耗尽，重置额度状态');
    this.tokens.forEach(t => {
      t.hasQuota = true;
    });
    this.saveToFile();
    this._rebuildAvailableQuotaTokens();
  }

  async getToken() {
    await this._ensureInitialized();
    if (this.tokens.length === 0) return null;

    // 针对额度耗尽策略做单独的高性能处理
    if (this.rotationStrategy === RotationStrategy.QUOTA_EXHAUSTED) {
      return this._getTokenForQuotaExhaustedStrategy();
    }

    return this._getTokenForDefaultStrategy();
  }

  /**
   * 额度耗尽策略的 token 获取
   * @private
   */
  async _getTokenForQuotaExhaustedStrategy() {
    // 如果当前没有可用 token，尝试重置额度
    if (this.availableQuotaTokenIndices.length === 0) {
      this._resetAllQuotas();
    }

    const totalAvailable = this.availableQuotaTokenIndices.length;
    if (totalAvailable === 0) {
      return null;
    }

    const startIndex = this.currentQuotaIndex % totalAvailable;

    for (let i = 0; i < totalAvailable; i++) {
      const listIndex = (startIndex + i) % totalAvailable;
      const tokenIndex = this.availableQuotaTokenIndices[listIndex];
      const token = this.tokens[tokenIndex];

      try {
        const result = await this._prepareToken(token);
        if (result === 'disable') {
          this.disableToken(token);
          this._rebuildAvailableQuotaTokens();
          if (this.tokens.length === 0 || this.availableQuotaTokenIndices.length === 0) {
            return null;
          }
          continue;
        }

        this.currentIndex = tokenIndex;
        this.currentQuotaIndex = listIndex;
        return token;
      } catch (error) {
        const action = this._handleTokenError(error, token);
        if (action === 'disable') {
          this.disableToken(token);
          this._rebuildAvailableQuotaTokens();
          if (this.tokens.length === 0 || this.availableQuotaTokenIndices.length === 0) {
            return null;
          }
        }
        // skip: 继续尝试下一个 token
      }
    }

    // 所有可用 token 都不可用，重置额度状态
    this._resetAllQuotas();
    return this.tokens[0] || null;
  }

  /**
   * 默认策略（round_robin / request_count）的 token 获取
   * @private
   */
  async _getTokenForDefaultStrategy() {
    const totalTokens = this.tokens.length;
    const startIndex = this.currentIndex;

    for (let i = 0; i < totalTokens; i++) {
      const index = (startIndex + i) % totalTokens;
      const token = this.tokens[index];

      try {
        const result = await this._prepareToken(token);
        if (result === 'disable') {
          this.disableToken(token);
          if (this.tokens.length === 0) return null;
          continue;
        }

        // 更新当前索引
        this.currentIndex = index;

        // 根据策略决定是否切换
        if (this.shouldRotate(token)) {
          this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        }

        return token;
      } catch (error) {
        const action = this._handleTokenError(error, token);
        if (action === 'disable') {
          this.disableToken(token);
          if (this.tokens.length === 0) return null;
        }
        // skip: 继续尝试下一个 token
      }
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
    this._initPromise = this._initialize();
    await this._initPromise;
    log.info('Token已热重载');
  }

  async addToken(tokenData) {
    try {
      const allTokens = await this.store.readAll();
      
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
      await this.store.writeAll(allTokens);
      
      await this.reload();
      return { success: true, message: 'Token添加成功' };
    } catch (error) {
      log.error('添加Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  async updateToken(refreshToken, updates) {
    try {
      const allTokens = await this.store.readAll();
      
      const index = allTokens.findIndex(t => t.refresh_token === refreshToken);
      if (index === -1) {
        return { success: false, message: 'Token不存在' };
      }
      
      allTokens[index] = { ...allTokens[index], ...updates };
      await this.store.writeAll(allTokens);
      
      await this.reload();
      return { success: true, message: 'Token更新成功' };
    } catch (error) {
      log.error('更新Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  async deleteToken(refreshToken) {
    try {
      const allTokens = await this.store.readAll();
      
      const filteredTokens = allTokens.filter(t => t.refresh_token !== refreshToken);
      if (filteredTokens.length === allTokens.length) {
        return { success: false, message: 'Token不存在' };
      }
      
      await this.store.writeAll(filteredTokens);
      
      await this.reload();
      return { success: true, message: 'Token删除成功' };
    } catch (error) {
      log.error('删除Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  async getTokenList() {
    try {
      const allTokens = await this.store.readAll();
      
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
