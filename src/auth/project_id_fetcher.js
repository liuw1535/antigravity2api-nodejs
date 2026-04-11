import { log } from '../utils/logger.js';
import config from '../config/config.js';
import requesterManager from '../utils/requesterManager.js';

/**
 * ProjectId 获取类
 * 负责从 Google API 获取 projectId
 */
class ProjectIdFetcher {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 5;
    this.retryDelay = options.retryDelay || 2000;
    this.timeout = options.timeout || 30000;
  }

  /**
   * 完整的账号验证流程（重构版）
   * @param {Object} token - Token 对象
   * @returns {Promise<{projectId: string|null, sub: string, hasQuota: boolean, source: string, isActivated: boolean, credits: number|null}>}
   */
  async validateAccount(token) {
    const result = {
      projectId: null,
      sub: 'free-tier',
      hasQuota: false,
      source: 'none',
      isActivated: false,
      credits: null
    };

    // 步骤1: 尝试 loadCodeAssist
    try {
      const loadResult = await this._tryLoadCodeAssist(token);
      
      // 场景2/3: 已激活账号（loadCodeAssist 返回 currentTier 和 projectId）
      if (loadResult?.projectId) {
        result.projectId = loadResult.projectId;
        result.sub = loadResult.sub;
        result.hasQuota = true;
        result.source = 'loadCodeAssist';
        result.isActivated = true;
        result.credits = loadResult.credits;
        
        log.info(`[validateAccount] 场景2/3: 已激活账号，sub=${result.sub}, credits=${result.credits}`);
        return result;
      }
      
      // loadCodeAssist 返回了 currentTier 但没有 projectId（异常情况）
      if (loadResult?.sub && loadResult.sub !== 'free-tier') {
        log.warn('[validateAccount] 账号已激活但无 projectId（异常）');
        result.sub = loadResult.sub;
        result.isActivated = true;
        result.hasQuota = false;
        return result;
      }
      
    } catch (err) {
      log.warn(`[validateAccount] loadCodeAssist 失败: ${err.message}`);
    }

    // 步骤2: loadCodeAssist 未返回有效结果，尝试 onboardUser
    log.info('[validateAccount] loadCodeAssist 未激活，尝试 onboardUser');
    
    try {
      const onboardResult = await this._tryOnboardUser(token);
      
      // 场景4: Pro账号未激活（onboardUser 可以获取 projectId）
      if (onboardResult?.projectId) {
        result.projectId = onboardResult.projectId;
        result.sub = 'g1-pro-tier'; // Pro账号的默认订阅
        result.hasQuota = true;
        result.source = 'onboardUser';
        result.isActivated = false;
        
        log.info('[validateAccount] 场景4: Pro未激活账号');
        return result;
      }
      
    } catch (err) {
      log.warn(`[validateAccount] onboardUser 失败: ${err.message}`);
    }

    // 步骤3: 两种方式都失败，场景1: 普通未激活账号
    log.info('[validateAccount] 场景1: 普通未激活账号（free-tier）');
    result.sub = 'free-tier';
    result.hasQuota = false;
    result.source = 'none';
    result.isActivated = false;
    
    return result;
  }

  /**
   * 获取 projectId（尝试两种方式）
   * @param {Object} token - Token 对象
   * @returns {Promise<{projectId: string|undefined, sub: string}>} projectId 和 sub
   */
  async fetchProjectId(token) {
    // 步骤1: 尝试 loadCodeAssist
    try {
      const result = await this._tryLoadCodeAssist(token);
      if (result?.projectId) {
        return result;
      }
      log.warn('[fetchProjectId] loadCodeAssist 未返回 projectId，回退到 onboardUser');
    } catch (err) {
      log.warn(`[fetchProjectId] loadCodeAssist 失败: ${err.message}，回退到 onboardUser`);
    }

    // 步骤2: 回退到 onboardUser
    try {
      const result = await this._tryOnboardUser(token);
      if (result?.projectId) {
        return result;
      }
      log.error('[fetchProjectId] loadCodeAssist 和 onboardUser 均未能获取 projectId');
      return { projectId: undefined, sub: 'free-tier' };
    } catch (err) {
      log.error(`[fetchProjectId] onboardUser 失败: ${err.message}`);
      return { projectId: undefined, sub: 'free-tier' };
    }
  }

  /**
   * 尝试通过 loadCodeAssist 获取 projectId
   * @param {Object} token - Token 对象
   * @returns {Promise<{projectId: string|null, sub: string, isActivated: boolean, credits: number|null}|null>} projectId、sub、激活状态和积分
   * @private
   */
  async _tryLoadCodeAssist(token) {
    const apiHost = config.api.host;
    const requestUrl = `https://${apiHost}/v1internal:loadCodeAssist`;
    const requestBody = {
      metadata: {
        ideType: 'ANTIGRAVITY',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
      }
    };

    log.info(`[loadCodeAssist] 请求: ${requestUrl}`);
    const response = await requesterManager.fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Host': apiHost,
        'User-Agent': config.api.userAgent,
        'Authorization': `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      body: requestBody,
      okStatus: [200]
    });

    const data = response.data;
    //console.log(JSON.stringify(data,null,2));

    // 检查是否有 currentTier（表示用户已激活）
    if (data?.currentTier) {
      log.info('[loadCodeAssist] 用户已激活');
      const projectId = data.cloudaicompanionProject || null;
      let sub = data.currentTier.id || 'free-tier';
      const sub2 = data?.paidTier?.id;
      if (sub2){
        sub = sub2;
      }
      
      // 提取积分信息（仅 free-tier 以上订阅才有）
      let credits = null;
      if (sub !== 'free-tier' && data?.paidTier?.availableCredits?.[0]?.creditAmount) {
        try {
          credits = parseFloat(data.paidTier.availableCredits[0].creditAmount);
          log.info(`[loadCodeAssist] 获取到积分信息: ${credits}`);
        } catch (err) {
          log.warn(`[loadCodeAssist] 解析积分信息失败: ${err.message}`);
        }
      }
      
      return {
        projectId,
        sub,
        isActivated: true,
        credits
      };
    }

    // 未激活
    log.info('[loadCodeAssist] 用户未激活 (无 currentTier)');
    return {
      projectId: null,
      sub: 'free-tier',
      isActivated: false,
      credits: null
    };
  }

  /**
   * 尝试通过 onboardUser 获取 projectId（长时间运行操作，需要轮询）
   * @param {Object} token - Token 对象
   * @returns {Promise<{projectId: string, sub: string}|null>} projectId 和 sub 或 null
   * @private
   */
  async _tryOnboardUser(token) {
    const apiHost = config.api.host;
    const requestUrl = `https://${apiHost}/v1internal:onboardUser`;

    // 首先获取用户的 tier 信息
    const tierId = await this._getOnboardTier(token);
    if (!tierId) {
      log.error('[onboardUser] 无法确定用户 tier');
      return null;
    }

    log.info(`[onboardUser] 用户 tier: ${tierId}`);

    const requestBody = {
      tierId: tierId,
      metadata: {
        ideType: 'ANTIGRAVITY',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
      }
    };

    log.info(`[onboardUser] 请求: ${requestUrl}`);

    // onboardUser 是长时间运行操作，需要轮询
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      log.info(`[onboardUser] 轮询尝试 ${attempt}/${this.maxRetries}`);

      const response = await requesterManager.fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Host': apiHost,
          'User-Agent': config.api.userAgent,
          'Authorization': `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip'
        },
        body: requestBody,
        okStatus: [200]
      });

      const data = response.data;

      // 检查长时间运行操作是否完成
      let sub = 'g1-pro-tier';
      if (data?.done) {
        log.info('[onboardUser] 操作完成');
        const responseData = data.response || {};
        const projectObj = responseData.cloudaicompanionProject;

        let projectId = null;
        if (typeof projectObj === 'object' && projectObj !== null) {
          projectId = projectObj.id;
        } else if (typeof projectObj === 'string') {
          projectId = projectObj;
        }

        if (projectId) {
          log.info(`[onboardUser] 成功获取 projectId: ${projectId}`);
          return { projectId, sub };
        }
        log.warn('[onboardUser] 操作完成但响应中无 projectId');
        return null;
      }

      log.info(`[onboardUser] 操作进行中，等待 ${this.retryDelay}ms...`);
      await this._sleep(this.retryDelay);
    }

    log.error(`[onboardUser] 超时：操作未在 ${this.maxRetries * this.retryDelay / 1000} 秒内完成`);
    return null;
  }

  /**
   * 从 loadCodeAssist 响应中获取用户应该注册的 tier
   * @param {Object} token - Token 对象
   * @returns {Promise<string|null>} tier_id 或 null
   * @private
   */
  async _getOnboardTier(token) {
    const apiHost = config.api.host;
    const requestUrl = `https://${apiHost}/v1internal:loadCodeAssist`;
    const requestBody = {
      metadata: {
        ideType: 'ANTIGRAVITY',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
      }
    };

    log.info(`[_getOnboardTier] 请求: ${requestUrl}`);

    try {
      const response = await requesterManager.fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Host': apiHost,
          'User-Agent': config.api.userAgent,
          'Authorization': `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip'
        },
        body: requestBody,
        okStatus: [200]
      });

      const data = response.data;

      // 查找默认的 tier
      const allowedTiers = data?.allowedTiers || [];
      for (const tier of allowedTiers) {
        if (tier.isDefault) {
          log.info(`[_getOnboardTier] 找到默认 tier: ${tier.id}`);
          return tier.id;
        }
      }

      // 如果没有默认 tier，使用 LEGACY 作为回退
      log.warn('[_getOnboardTier] 未找到默认 tier，使用 LEGACY');
      return 'LEGACY';
    } catch (err) {
      log.error(`[_getOnboardTier] 获取 tier 失败: ${err.message}`);
      return null;
    }
  }

  /**
   * 睡眠指定时间
   * @param {number} ms - 毫秒数
   * @returns {Promise<void>}
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 专门获取积分和订阅信息
   * @param {Object} token - Token 对象
   * @returns {Promise<{sub: string, credits: number|null, isActivated: boolean}>}
   */
  async fetchSubscriptionAndCredits(token) {
    const result = {
      sub: 'free-tier',
      credits: null,
      isActivated: false
    };

    try {
      const loadResult = await this._tryLoadCodeAssist(token);
      
      if (loadResult?.isActivated) {
        result.sub = loadResult.sub || 'free-tier';
        result.credits = loadResult.credits;
        result.isActivated = true;
        
        log.info(`[fetchSubscriptionAndCredits] 订阅: ${result.sub}, 积分: ${result.credits}`);
      } else {
        log.info('[fetchSubscriptionAndCredits] 账号未激活，保持 free-tier');
      }
      
      return result;
    } catch (err) {
      log.error(`[fetchSubscriptionAndCredits] 获取失败: ${err.message}`);
      return result;
    }
  }

  /**
   * 设置最大重试次数
   * @param {number} retries - 重试次数
   */
  setMaxRetries(retries) {
    if (retries > 0) {
      this.maxRetries = retries;
    }
  }

  /**
   * 设置重试延迟
   * @param {number} delay - 延迟时间（毫秒）
   */
  setRetryDelay(delay) {
    if (delay > 0) {
      this.retryDelay = delay;
    }
  }

  /**
   * 设置超时时间
   * @param {number} timeout - 超时时间（毫秒）
   */
  setTimeout(timeout) {
    if (timeout > 0) {
      this.timeout = timeout;
    }
  }
}

export default ProjectIdFetcher;