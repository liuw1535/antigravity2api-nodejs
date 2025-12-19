import axios from 'axios';
import crypto from 'crypto';
import log from '../utils/logger.js';
import config from '../config/config.js';
import { generateProjectId } from '../utils/idGenerator.js';
import tokenManager from './token_manager.js';
import { OAUTH_CONFIG, OAUTH_SCOPES } from '../constants/oauth.js';
import { buildAxiosRequestConfig } from '../utils/httpClient.js';

class OAuthManager {
  constructor() {
    this.state = crypto.randomUUID();
  }

  /**
   * 生成授权URL
   */
  generateAuthUrl(port) {
    const params = new URLSearchParams({
      access_type: 'offline',
      client_id: OAUTH_CONFIG.CLIENT_ID,
      prompt: 'consent',
      redirect_uri: `http://localhost:${port}/oauth-callback`,
      response_type: 'code',
      scope: OAUTH_SCOPES.join(' '),
      state: this.state
    });
    return `${OAUTH_CONFIG.AUTH_URL}?${params.toString()}`;
  }

  /**
   * 交换授权码获取Token
   */
  async exchangeCodeForToken(code, port) {
    const postData = new URLSearchParams({
      code,
      client_id: OAUTH_CONFIG.CLIENT_ID,
      client_secret: OAUTH_CONFIG.CLIENT_SECRET,
      redirect_uri: `http://localhost:${port}/oauth-callback`,
      grant_type: 'authorization_code'
    });
    
    const response = await axios(buildAxiosRequestConfig({
      method: 'POST',
      url: OAUTH_CONFIG.TOKEN_URL,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: postData.toString(),
      timeout: config.timeout
    }));
    
    return response.data;
  }

  /**
   * 获取用户邮箱
   */
  async fetchUserEmail(accessToken) {
    try {
      const response = await axios(buildAxiosRequestConfig({
        method: 'GET',
        url: 'https://www.googleapis.com/oauth2/v2/userinfo',
        headers: {
          'Host': 'www.googleapis.com',
          'User-Agent': 'Go-http-client/1.1',
          'Authorization': `Bearer ${accessToken}`,
          'Accept-Encoding': 'gzip'
        },
        timeout: config.timeout
      }));
      return response.data?.email;
    } catch (err) {
      log.warn('获取用户邮箱失败:', err.message);
      return null;
    }
  }

  /**
   * 资格校验：尝试获取projectId，失败则自动回退到随机projectId
   */
  async validateAndGetProjectId(accessToken) {
    // 如果配置跳过API验证，直接返回随机projectId
    if (config.skipProjectIdFetch) {
      const projectId = generateProjectId();
      log.info('已跳过API验证，使用随机生成的projectId: ' + projectId);
      return { projectId, hasQuota: false };
    }

    // 尝试从API获取projectId
    try {
      log.info('正在验证账号资格...');
      const projectId = await tokenManager.fetchProjectId({ access_token: accessToken });
      
      if (projectId === undefined) {
        // 无资格，自动回退到随机projectId
        const randomProjectId = generateProjectId();
        log.warn('该账号无资格使用，已自动退回无资格模式，使用随机projectId: ' + randomProjectId);
        return { projectId: randomProjectId, hasQuota: false };
      }
      
      log.info('账号验证通过，projectId: ' + projectId);
      return { projectId, hasQuota: true };
    } catch (err) {
      // 获取失败时也退回到随机projectId
      const randomProjectId = generateProjectId();
      log.warn('验证账号资格失败: ' + err.message + '，已自动退回无资格模式');
      log.info('使用随机生成的projectId: ' + randomProjectId);
      return { projectId: randomProjectId, hasQuota: false };
    }
  }

  /**
   * 完整的OAuth认证流程：交换Token -> 获取邮箱 -> 资格校验
   */
  async authenticate(code, port) {
    // 1. 交换授权码获取Token
    const tokenData = await this.exchangeCodeForToken(code, port);
    
    if (!tokenData.access_token) {
      throw new Error('Token交换失败：未获取到access_token');
    }

    const account = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      timestamp: Date.now()
    };

    // 2. 获取用户邮箱
    const email = await this.fetchUserEmail(account.access_token);
    if (email) {
      account.email = email;
      log.info('获取到用户邮箱: ' + email);
    }

    // 3. 资格校验并获取projectId
    const { projectId, hasQuota } = await this.validateAndGetProjectId(account.access_token);
    account.projectId = projectId;
    account.hasQuota = hasQuota;
    account.enable = true;

    return account;
  }
}

export default new OAuthManager();
