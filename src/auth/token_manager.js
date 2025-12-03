import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { log } from '../utils/logger.js';
import { generateProjectId, generateSessionId } from '../utils/idGenerator.js';
import config from '../config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

class TokenManager {
  constructor(filePath = path.join(__dirname,'..','..','data' ,'accounts.json')) {
    this.filePath = filePath;
    this.tokens = [];
    this.currentIndex = 0;
    this.initialize();
  }

  initialize() {
    try {
      log.info('正在初始化token管理器...');
      const data = fs.readFileSync(this.filePath, 'utf8');
      let tokenArray = JSON.parse(data);
      let needSave = false;
      
      tokenArray = tokenArray.map(token => {
        if (!token.projectId) {
          token.projectId = generateProjectId();
          needSave = true;
        }
        return token;
      });
      
      if (needSave) {
        fs.writeFileSync(this.filePath, JSON.stringify(tokenArray, null, 2), 'utf8');
      }
      
      this.tokens = tokenArray.filter(token => token.enable !== false).map(token => ({
        ...token,
        sessionId: generateSessionId(),
        usedCount: 0
      }));
      this.currentIndex = 0;
      log.info(`成功加载 ${this.tokens.length} 个可用token`);
    } catch (error) {
      log.error('初始化token失败:', error.message);
      this.tokens = [];
    }
  }

  isExpired(token) {
    if (!token.timestamp || !token.expires_in) return true;
    const expiresAt = token.timestamp + (token.expires_in * 1000);
    return Date.now() >= expiresAt - 300000;
  }

  async refreshToken(token) {
    log.info('正在刷新token...');
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token
    });

    try {
      const response = await axios({
        method: 'POST',
        url: 'https://oauth2.googleapis.com/token',
        headers: {
          'Host': 'oauth2.googleapis.com',
          'User-Agent': 'Go-http-client/1.1',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept-Encoding': 'gzip'
        },
        data: body.toString(),
        timeout: config.timeout,
        proxy: config.proxy ? (() => {
          const proxyUrl = new URL(config.proxy);
          return { protocol: proxyUrl.protocol.replace(':', ''), host: proxyUrl.hostname, port: parseInt(proxyUrl.port) };
        })() : false
      });

      token.access_token = response.data.access_token;
      token.expires_in = response.data.expires_in;
      token.timestamp = Date.now();
      this.saveToFile();
      return token;
    } catch (error) {
      throw { statusCode: error.response?.status, message: error.response?.data || error.message };
    }
  }

  saveToFile() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const allTokens = JSON.parse(data);
      
      this.tokens.forEach(memToken => {
        const index = allTokens.findIndex(t => t.refresh_token === memToken.refresh_token);
        if (index !== -1) {
          const { sessionId, ...tokenToSave } = memToken;
          allTokens[index] = tokenToSave;
        }
      });
      
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

  set429(token) {
    log.warn(`Token ...${token.access_token.slice(-8)} 因 429 被禁用一小时`)
    token.temp_forbidden = true;
    token.forbidden_until = Date.now() + 3600000; // 禁用一小时
    this.saveToFile();
    this.currentIndex = this.currentIndex % Math.max(this.tokens.length, 1);
  }

  is429(token) {
    return token.temp_forbidden && token.forbidden_until && token.forbidden_until > Date.now();
  }

  is429Released(token) {
    return token.temp_forbidden && token.forbidden_until && token.forbidden_until <= Date.now();
  }

  unset429(token) {
    log.info('正在恢复因 429 被禁用的token...');
    token.temp_forbidden = false;
    token.forbidden_until = null;
    this.saveToFile();
    this.initialize();
  }

  async getToken() {
    if (this.tokens.length === 0) return null;

    const startIndex = this.currentIndex;
    const totalTokens = this.tokens.length;

    for (let i = 0; i < totalTokens; i++) {
      const token = this.tokens[this.currentIndex];
      
      try {
        if (this.isExpired(token)) {
          await this.refreshToken(token);
        }
        if (this.is429Released(token)) {
          this.unset429(token);
        }
        if (token.temp_forbidden) {
          this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
          continue;
        }
        if (token.usedCount >= config.tokenReuse.singleTokenUseCount) this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        token.usedCount++;
        return token;
      } catch (error) {
        if (error.statusCode === 403 || error.statusCode === 400) {
          const accountNum = this.currentIndex + 1;
          log.warn(`账号 ${accountNum}: Token 已失效或错误，已自动禁用该账号`);
          this.disableToken(token);
          if (this.tokens.length === 0) return null;
        } else if (error.statusCode === 429) {
          log.warn(`账号 ${accountNum}仍在429中，请稍后再试`)
          if (this.tokens.length === 0) return null;
          this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        } else {
          log.error(`Token ${this.currentIndex + 1} 刷新失败:`, error.message);
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
}
const tokenManager = new TokenManager();
export default tokenManager;
