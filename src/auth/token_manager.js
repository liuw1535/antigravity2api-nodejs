import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { log } from '../utils/logger.js';
import { generateSessionId, generateProjectId } from '../utils/idGenerator.js';
import config from '../config/config.js';
import { OAUTH_CONFIG } from '../constants/oauth.js';
import { buildAxiosProxyOptions } from '../utils/proxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class TokenManager {
  constructor(filePath = path.join(__dirname,'..','..','data' ,'accounts.json')) {
    this.filePath = filePath;
    this.tokens = [];
    this.currentIndex = 0;
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
      if (this.tokens.length === 0) {
        log.warn('⚠ 暂无可用账号，请使用以下方式添加：');
        log.warn('  方式1: 运行 npm run login 命令登录');
        log.warn('  方式2: 访问前端管理页面添加账号');
      } else {
        log.info(`成功加载 ${this.tokens.length} 个可用token`);
      }
    } catch (error) {
      log.error('初始化token失败:', error.message);
      this.tokens = [];
    }
  }

  async fetchProjectId(token) {
    const response = await axios({
      method: 'POST',
      url: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
      headers: {
        'Host': 'daily-cloudcode-pa.sandbox.googleapis.com',
        'User-Agent': 'antigravity/1.11.9 windows/amd64',
        'Authorization': `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      data: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
      timeout: config.timeout,
      ...buildAxiosProxyOptions(config.proxy)
    });
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
      const response = await axios({
        method: 'POST',
        url: OAUTH_CONFIG.TOKEN_URL,
        headers: {
          'Host': 'oauth2.googleapis.com',
          'User-Agent': 'Go-http-client/1.1',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept-Encoding': 'gzip'
        },
        data: body.toString(),
        timeout: config.timeout,
        ...buildAxiosProxyOptions(config.proxy)
      });

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

  async getToken() {
    if (this.tokens.length === 0) return null;

    //const startIndex = this.currentIndex;
    const totalTokens = this.tokens.length;

    for (let i = 0; i < totalTokens; i++) {
      const token = this.tokens[this.currentIndex];
      
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
              this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
              continue;
            }
          }
        }
        this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        return token;
      } catch (error) {
        if (error.statusCode === 403 || error.statusCode === 400) {
          log.warn(`...${token.access_token.slice(-8)}: Token 已失效或错误，已自动禁用该账号`);
          this.disableToken(token);
          if (this.tokens.length === 0) return null;
        } else {
          log.error(`...${token.access_token.slice(-8)} 刷新失败:`, error.message);
          this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        }
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
      
      const { access_token_suffix, ...cleanUpdates } = updates; allTokens[index] = { ...allTokens[index], ...cleanUpdates };
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
        email: token.email || null
      }));
    } catch (error) {
      log.error('获取Token列表失败:', error.message);
      return [];
    }
  }
}
const tokenManager = new TokenManager();
export default tokenManager;
