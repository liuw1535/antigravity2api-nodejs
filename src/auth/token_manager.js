import { log } from '../utils/logger.js';
import { generateSessionId, generateInstanceId } from '../utils/idGenerator.js';
import config, { getConfigJson } from '../config/config.js';
import { DEFAULT_REQUEST_COUNT_PER_TOKEN } from '../constants/index.js';
import TokenStore from './token_store.js';
import TokenPool from './token_pool.js';
import TokenLifecycleManager from './token_lifecycle_manager.js';
import ProjectIdFetcher from './project_id_fetcher.js';
import TokenValidator from './token_validator.js';
import { StrategyFactory, RotationStrategy } from './token_rotation_strategy.js';
import { TokenError } from '../utils/errors.js';
import quotaManager from './quota_manager.js';
import tokenCooldownManager from './token_cooldown_manager.js';
import { randomUUID } from 'crypto';

/**
 * Token 管理器（重构版）
 * 负责 Token 的存储、轮询、刷新等功能
 */
class TokenManager {
  /**
   * @param {string} filePath - Token 数据文件路径
   */
  constructor(filePath) {
    // 核心组件
    this.store = new TokenStore(filePath);
    this.pool = new TokenPool(this.store);
    this.lifecycle = new TokenLifecycleManager(this.store);
    this.projectIdFetcher = new ProjectIdFetcher();
    this.validator = new TokenValidator(this.store);

    // 轮询策略
    this.strategy = null;
    this.rotationStrategyName = RotationStrategy.ROUND_ROBIN;
    this.requestCountPerToken = DEFAULT_REQUEST_COUNT_PER_TOKEN;

    // 初始化状态
    this._initPromise = null;
  }

  /**
   * 初始化
   * @private
   */
  async _initialize() {
    try {
      log.info('正在初始化token管理器...');

      // 1. 读取所有 token
      const tokenArray = await this.store.readAll();

      // 2. 清空池并重新加载
      this.pool.clear();

      // 3. 为所有 token 添加必要属性（包括禁用的token，以便前端显示）
      const tokensWithMetadata = tokenArray.map(token => ({
        ...token,
        sessionId: generateSessionId(),
        instanceId: generateInstanceId(),
        deviceId: randomUUID(),
        sub: token?.sub || 'g1-pro-tier',
        // 确保 enable 字段有默认值
        enable: token.enable !== undefined ? token.enable : true
      }));

      // 4. 批量添加到池中（包括禁用的token）
      await this.pool.addAll(tokensWithMetadata);

      // 5. 加载轮询策略配置
      this._loadRotationConfig();

      // 6. 创建轮询策略实例
      this.strategy = StrategyFactory.create(this.rotationStrategyName, {
        requestCountPerToken: this.requestCountPerToken
      });

      // 7. 日志输出
      const poolSize = this.pool.size();
      const enabledCount = this.pool.getEnabledIds().length;
      const disabledCount = poolSize - enabledCount;
      
      if (poolSize === 0) {
        log.warn('⚠ 暂无可用账号，请使用以下方式添加：');
        log.warn('  方式1: 运行 npm run login 命令登录');
        log.warn('  方式2: 访问前端管理页面添加账号');
      } else {
        log.info(`成功加载 ${poolSize} 个token (启用: ${enabledCount}, 禁用: ${disabledCount})`);
        if (this.rotationStrategyName === RotationStrategy.REQUEST_COUNT) {
          log.info(`轮询策略: ${this.rotationStrategyName}, 每token请求 ${this.requestCountPerToken} 次后切换`);
        } else {
          log.info(`轮询策略: ${this.rotationStrategyName}`);
        }

        // 8. 并发刷新所有过期的启用token
        await this._refreshExpiredTokens();
      }
    } catch (error) {
      log.error('初始化token失败:', error.message);
      this.pool.clear();
    }
  }

  /**
   * 加载轮询策略配置
   * @private
   */
  _loadRotationConfig() {
    try {
      const jsonConfig = getConfigJson();
      if (jsonConfig.rotation) {
        this.rotationStrategyName = jsonConfig.rotation.strategy || RotationStrategy.ROUND_ROBIN;
        this.requestCountPerToken = jsonConfig.rotation.requestCount || DEFAULT_REQUEST_COUNT_PER_TOKEN;
      }
    } catch (error) {
      log.warn('加载轮询配置失败，使用默认值:', error.message);
    }
  }

  /**
   * 刷新所有过期的 token
   * @private
   */
  async _refreshExpiredTokens() {
    // 获取所有启用的 tokens
    const allTokens = this.pool.getEnabledIds().map(tokenId => ({
      tokenId,
      token: this.pool.get(tokenId)
    }));

    // 过滤出过期的 tokens
    const expiredTokens = this.lifecycle.getExpiredTokens(allTokens);

    if (expiredTokens.length === 0) {
      return;
    }

    // 并发刷新
    const { tokensToDisable } = await this.lifecycle.refreshTokensConcurrently(expiredTokens);

    // 禁用失效的 tokens
    for (const { token, tokenId } of tokensToDisable) {
      await this._disableTokenInternal(tokenId);
    }
  }

  /**
   * 确保已初始化
   * @private
   */
  async _ensureInitialized() {
    if (!this._initPromise) {
      this._initPromise = this._initialize();
    }
    return this._initPromise;
  }

  /**
   * 内部禁用 token（不持久化）
   * @param {string} tokenId - Token ID
   * @private
   */
  async _disableTokenInternal(tokenId) {
    this.pool.disable(tokenId);
    log.warn(`Token ${tokenId} 已被禁用`);
  }
  /**
   * 获取下一个可用的 token
   * @param {string} modelId - 模型 ID
   * @returns {Promise<Object|null>} token 对象或 null
   */
  async getNextToken(modelId) {
    await this._ensureInitialized();

    // 1. 获取所有启用的 tokens
    let availableTokens = this.pool.getEnabledIds().map(tokenId => ({
      tokenId,
      token: this.pool.get(tokenId)
    }));

    if (availableTokens.length === 0) {
      log.error('没有可用的token');
      return null;
    }

    // 2. 如果提供了 modelId，过滤出对该模型可用的 tokens
    if (modelId) {
      availableTokens = await this.validator.filterAvailableTokens(availableTokens, modelId);

      if (availableTokens.length === 0) {
        // 检查是否所有 token 对该模型都不可用
        const allTokens = this.pool.getEnabledIds().map(tokenId => ({
          tokenId,
          token: this.pool.get(tokenId)
        }));

        const allExhausted = await this.validator.areAllTokensExhausted(allTokens, modelId);
        if (allExhausted) {
          log.warn(`所有token对模型 ${modelId} 都不可用，重置额度状态`);
          this.pool.resetAllQuotas();

          // 重新获取可用 tokens
          availableTokens = this.pool.getEnabledIds().map(tokenId => ({
            tokenId,
            token: this.pool.get(tokenId)
          }));
        } else {
          log.error(`没有对模型 ${modelId} 可用的token`);
          return null;
        }
      }
    }

    // 3. 使用策略选择 token
    const selected = this.strategy.selectToken(availableTokens);
    if (!selected) {
      return null;
    }

    const { token, tokenId } = selected;

    // 4. 检查是否需要刷新
    if (this.lifecycle.isExpired(token)) {
      try {
        await this.lifecycle.refreshToken(token, tokenId);
        await this._persistToken(token);
      } catch (error) {
        log.error(`刷新token失败: ${error.message}`);
        if (error.statusCode === 403 || error.statusCode === 400) {
          await this.disableToken(token);
        }
        return this.getNextToken(modelId);
      }
    }

    // 5. 记录使用
    const shouldSwitch = this.strategy.recordUsage(tokenId);

    // 6. 如果是 request_count 策略且需要切换
    if (shouldSwitch && this.rotationStrategyName === RotationStrategy.REQUEST_COUNT) {
      this.strategy.switchToNext(availableTokens.length, tokenId);
    }

    return token;
  }

  /**
   * 获取下一个可用的 token
   * @param {string} modelId - 模型 ID
   * @returns {Promise<Object|null>} token 对象或 null
   */
  async getToken(modelId) {
    await this._ensureInitialized();

    // 1. 获取所有启用的 tokens
    let availableTokens = this.pool.getEnabledIds().map(tokenId => ({
      tokenId,
      token: this.pool.get(tokenId)
    }));

    if (availableTokens.length === 0) {
      log.error('没有可用的token');
      return null;
    }

    // 2. 如果提供了 modelId，过滤出对该模型可用的 tokens
    if (modelId) {
      availableTokens = await this.validator.filterAvailableTokens(availableTokens, modelId);

      if (availableTokens.length === 0) {
        // 检查是否所有 token 对该模型都不可用
        const allTokens = this.pool.getEnabledIds().map(tokenId => ({
          tokenId,
          token: this.pool.get(tokenId)
        }));

        const allExhausted = await this.validator.areAllTokensExhausted(allTokens, modelId);
        if (allExhausted) {
          log.warn(`所有token对模型 ${modelId} 都不可用，重置额度状态`);
          this.pool.resetAllQuotas();

          // 重新获取可用 tokens
          availableTokens = this.pool.getEnabledIds().map(tokenId => ({
            tokenId,
            token: this.pool.get(tokenId)
          }));
        } else {
          log.error(`没有对模型 ${modelId} 可用的token`);
          return null;
        }
      }
    }

    // 3. 使用策略选择 token
    const selected = this.strategy.selectToken(availableTokens);
    if (!selected) {
      return null;
    }

    const { token, tokenId } = selected;

    // 4. 检查是否需要刷新
    if (this.lifecycle.isExpired(token)) {
      try {
        await this.lifecycle.refreshToken(token, tokenId);
        await this._persistToken(token);
      } catch (error) {
        log.error(`刷新token失败: ${error.message}`);
        if (error.statusCode === 403 || error.statusCode === 400) {
          await this.disableToken(token);
        }
        return this.getToken(modelId);
      }
    }

    // 5. 记录使用
    const shouldSwitch = this.strategy.recordUsage(tokenId);

    // 6. 如果是 request_count 策略且需要切换
    if (shouldSwitch && this.rotationStrategyName === RotationStrategy.REQUEST_COUNT) {
      this.strategy.switchToNext(availableTokens.length, tokenId);
    }

    return token;
  }

  /**
   * 持久化单个 token
   * @param {Object} token - Token 对象
   * @private
   */
  async _persistToken(token) {
    try {
      const allTokens = await this.store.readAll();
      const tokenId = await this.pool.generateTokenId(token);

      // 修复: 不能在 findIndex 中使用异步回调，需要先生成所有 tokenId
      let index = -1;
      for (let i = 0; i < allTokens.length; i++) {
        const tid = await this.pool.generateTokenId(allTokens[i]);
        if (tid === tokenId) {
          index = i;
          break;
        }
      }

      if (index !== -1) {
        allTokens[index] = token;
        await this.store.writeAll(allTokens);
      }
    } catch (error) {
      log.error(`持久化token失败: ${error.message}`);
    }
  }

  /**
   * 添加新的 token
   * @param {Object} tokenData - Token 数据
   * @returns {Promise<Object>} 添加后的 token
   */
  async addToken(tokenData) {
    await this._ensureInitialized();

    // 1. 获取 projectId
    const { projectId, sub } = await this.projectIdFetcher.fetchProjectId(tokenData);

    // 2. 构建完整的 token 对象
    const token = {
      ...tokenData,
      projectId,
      sub,
      enable: true,
      hasQuota: true,
      sessionId: generateSessionId(),
      instanceId: generateInstanceId(),
      deviceId: randomUUID()
    };

    // 3. 添加到池中
    const tokenId = await this.pool.add(token);

    // 4. 持久化
    const allTokens = await this.store.readAll();
    allTokens.push(token);
    await this.store.writeAll(allTokens);

    log.info(`Token ${tokenId} 添加成功`);
    return token;
  }

  /**
   * 禁用 token
   * @param {Object} token - Token 对象
   */
  async disableToken(token) {
    const tokenId = await this.pool.findTokenId(token.refresh_token);
    if (!tokenId) {
      log.warn('尝试禁用不存在的token');
      return;
    }

    // 1. 在池中禁用
    this.pool.disable(tokenId);

    // 2. 持久化
    try {
      const allTokens = await this.store.readAll();
      
      // 修复: 不能在 findIndex 中使用异步回调，需要先生成所有 tokenId
      let index = -1;
      for (let i = 0; i < allTokens.length; i++) {
        const tid = await this.pool.generateTokenId(allTokens[i]);
        if (tid === tokenId) {
          index = i;
          break;
        }
      }

      if (index !== -1) {
        allTokens[index].enable = false;
        await this.store.writeAll(allTokens);
      }
    } catch (error) {
      log.error(`持久化禁用状态失败: ${error.message}`);
    }

    log.warn(`Token ${tokenId} 已被禁用`);
  }

  /**
   * 标记 token 额度耗尽
   * @param {Object} token - Token 对象
   */
  async markTokenQuotaExhausted(token) {
    const tokenId = await this.pool.findTokenId(token.refresh_token);
    if (!tokenId) {
      return;
    }

    this.pool.markQuotaExhausted(tokenId);

    // 如果是 quota_exhausted 策略，切换到下一个
    if (this.rotationStrategyName === RotationStrategy.QUOTA_EXHAUSTED) {
      const totalTokens = this.pool.getEnabledWithQuotaIds().length;
      this.strategy.switchToNext(totalTokens);
    }
  }

  /**
   * 刷新指定 token
   * @param {Object} token - Token 对象
   * @param {boolean} silent - 是否静默模式
   * @returns {Promise<Object>} 刷新后的 token
   */
  async refreshToken(token, silent = false) {
    const tokenId = await this.pool.findTokenId(token.refresh_token);
    if (!tokenId) {
      throw new TokenError('Token不存在', null, 404);
    }

    await this.lifecycle.refreshToken(token, tokenId, silent);
    await this._persistToken(token);

    return token;
  }

  /**
   * 检查 token 是否过期
   * @param {Object} token - Token 对象
   * @returns {boolean} 是否过期
   */
  isExpired(token) {
    return this.lifecycle.isExpired(token);
  }

  /**
   * 重新加载所有 token
   */
  async reload() {
    this._initPromise = null;
    await this._ensureInitialized();
  }

  /**
   * 更新轮询策略配置
   * @param {string} strategy - 策略名称
   * @param {number} requestCount - 请求计数（仅用于 request_count 策略）
   */
  updateRotationConfig(strategy, requestCount) {
    if (strategy && StrategyFactory.isValidStrategy(strategy)) {
      this.rotationStrategyName = strategy;
      this.strategy = StrategyFactory.create(strategy, {
        requestCountPerToken: requestCount || this.requestCountPerToken
      });

      if (requestCount && requestCount > 0) {
        this.requestCountPerToken = requestCount;
      }

      if (this.rotationStrategyName === RotationStrategy.REQUEST_COUNT) {
        log.info(`轮询策略已更新: ${this.rotationStrategyName}, 每token请求 ${this.requestCountPerToken} 次后切换`);
      } else {
        log.info(`轮询策略已更新: ${this.rotationStrategyName}`);
      }
    }
  }

  /**
   * 获取轮询策略配置
   * @returns {Object} 配置对象
   */
  getRotationConfig() {
    return {
      strategy: this.rotationStrategyName,
      requestCount: this.requestCountPerToken
    };
  }

  /**
   * 记录请求（用于配额管理）
   * @param {Object} token - Token 对象
   * @param {string} modelId - 模型 ID
   */
  async recordRequest(token, modelId) {
    if (!token || !modelId) return;

    try {
      const tokenId = await this.pool.generateTokenId(token);
      quotaManager.recordRequest(tokenId, modelId);
    } catch (error) {
      // 记录失败不影响请求
      log.warn('记录请求次数失败:', error.message);
    }
  }

  /**
   * 获取所有 token 列表（不含敏感信息）
   * @returns {Promise<Array>} Token 列表
   */
  async getTokenList() {
    try {
      await this._ensureInitialized();
      const salt = await this.store.getSalt();

      return this.pool.getAllIds().map(tokenId => {
        const token = this.pool.get(tokenId);
        return {
          id: tokenId,
          expires_in: token.expires_in,
          timestamp: token.timestamp,
          enable: token.enable !== false,
          projectId: token.projectId || null,
          email: token.email || null,
          hasQuota: token.hasQuota !== false,
          sub: token.sub || null,
          credits: token.credits !== null && token.credits !== undefined ? token.credits : null
        };
      });
    } catch (error) {
      log.error('获取Token列表失败:', error.message);
      return [];
    }
  }

  /**
   * 根据 tokenId 查找 token
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object|null>} token 对象或 null
   */
  async findTokenById(tokenId) {
    await this._ensureInitialized();
    return this.pool.get(tokenId);
  }

  /**
   * 根据 tokenId 更新 token
   * @param {string} tokenId - Token ID
   * @param {Object} updates - 更新内容
   * @returns {Promise<Object>} 操作结果
   */
  async updateTokenById(tokenId, updates) {
    try {
      await this._ensureInitialized();

      // 更新池中的 token
      const success = this.pool.update(tokenId, updates);
      if (!success) {
        return { success: false, message: 'Token不存在' };
      }

      // 持久化
      const token = this.pool.get(tokenId);
      await this._persistToken(token);

      return { success: true, message: 'Token更新成功' };
    } catch (error) {
      log.error('更新Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * 根据 tokenId 删除 token
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object>} 操作结果
   */
  async deleteTokenById(tokenId) {
    try {
      await this._ensureInitialized();

      // 从池中删除
      const success = this.pool.remove(tokenId);
      if (!success) {
        return { success: false, message: 'Token不存在' };
      }

      // 持久化
      const allTokens = await this.store.readAll();
      const filteredTokens = [];
      for (const token of allTokens) {
        const tid = await this.pool.generateTokenId(token);
        if (tid !== tokenId) {
          filteredTokens.push(token);
        }
      }

      await this.store.writeAll(filteredTokens);

      return { success: true, message: 'Token删除成功' };
    } catch (error) {
      log.error('删除Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * 根据 tokenId 刷新 token
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object>} 刷新后的 token 信息
   */
  async refreshTokenById(tokenId) {
    await this._ensureInitialized();

    const token = this.pool.get(tokenId);
    if (!token) {
      throw new TokenError('Token不存在', null, 404);
    }

    await this.lifecycle.refreshToken(token, tokenId);
    await this._persistToken(token);

    return {
      expires_in: token.expires_in,
      timestamp: token.timestamp
    };
  }

  /**
   * 获取盐值
   * @returns {Promise<string>} 盐值
   */
  async getSalt() {
    return this.store.getSalt();
  }

  /**
   * 根据 token 对象获取 tokenId
   * @param {Object} token - Token 对象
   * @returns {Promise<string|null>} tokenId
   */
  async getTokenId(token) {
    if (!token?.refresh_token) return null;
    try {
      return await this.pool.findTokenId(token.refresh_token);
    } catch (error) {
      log.error(`生成tokenId失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 获取 projectId（兼容旧 API）
   * @param {Object} token - Token 对象
   * @returns {Promise<Object>} {projectId, sub}
   */
  async fetchProjectId(token) {
    return this.projectIdFetcher.fetchProjectId(token);
  }

  /**
   * 根据 tokenId 获取并更新 projectId
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object>} 包含 projectId 的结果
   */
  async fetchProjectIdForToken(tokenId) {
    await this._ensureInitialized();

    const token = this.pool.get(tokenId);
    if (!token) {
      throw new TokenError('Token不存在', null, 404);
    }

    // 确保 token 未过期
    if (this.lifecycle.isExpired(token)) {
      await this.lifecycle.refreshToken(token, tokenId);
      await this._persistToken(token);
    }

    const { projectId, sub } = await this.projectIdFetcher.fetchProjectId(token);
    if (!projectId) {
      throw new TokenError('无法获取 projectId，该账号可能无资格', null, 400);
    }

    // 更新 token
    this.pool.update(tokenId, {
      projectId,
      sub,
      hasQuota: true
    });

    // 持久化
    await this._persistToken(token);

    return { projectId };
  }
}

// 导出策略枚举（向后兼容）
export { RotationStrategy };

const tokenManager = new TokenManager();
export default tokenManager;
