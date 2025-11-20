import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

class TokenManager {
  constructor(filePath = path.join(__dirname,'..','..','data' ,'accounts.json')) {
    this.filePath = filePath;
    this.tokens = [];
    this.currentIndex = 0;
    this.loadTokens();
  }

  loadTokens() {
    try {
      log.info('正在加载token...');
      const data = fs.readFileSync(this.filePath, 'utf8');
      const tokenArray = JSON.parse(data);
      this.tokens = tokenArray.filter(token => token.enable !== false);
      this.currentIndex = 0;
      log.info(`成功加载 ${this.tokens.length} 个可用token`);
    } catch (error) {
      log.error('加载token失败:', error.message);
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

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Host': 'oauth2.googleapis.com',
        'User-Agent': 'Go-http-client/1.1',
        'Content-Length': body.toString().length.toString(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept-Encoding': 'gzip'
      },
      body: body.toString()
    });

    if (response.ok) {
      const data = await response.json();
      token.access_token = data.access_token;
      token.expires_in = data.expires_in;
      token.timestamp = Date.now();
      this.saveToFile();
      return token;
    } else {
      throw { statusCode: response.status, message: await response.text() };
    }
  }

  saveToFile() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const allTokens = JSON.parse(data);
      
      this.tokens.forEach(memToken => {
        const index = allTokens.findIndex(t => t.refresh_token === memToken.refresh_token);
        if (index !== -1) allTokens[index] = memToken;
      });
      
      fs.writeFileSync(this.filePath, JSON.stringify(allTokens, null, 2), 'utf8');
    } catch (error) {
      log.error('保存文件失败:', error.message);
    }
  }

  disableToken(token) {
    log.warn(`禁用token`)
    token.enable = false;
    this.saveToFile();
    this.loadTokens();
  }

  async getToken() {
    if (this.tokens.length === 0) return null;

    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[this.currentIndex];
      
      try {
        if (this.isExpired(token)) {
          await this.refreshToken(token);
        }
        this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        return token;
      } catch (error) {
        if (error.statusCode === 403) {
          log.warn(`Token ${this.currentIndex} 刷新失败(403)，禁用并尝试下一个`);
          this.disableToken(token);
        } else {
          log.error(`Token ${this.currentIndex} 刷新失败:`, error.message);
        }
        this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        if (this.tokens.length === 0) return null;
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

  async handleRequestError(error, currentAccessToken) {
    if (error.statusCode === 403) {
      log.warn('请求遇到403错误，尝试刷新token');
      const currentToken = this.tokens[this.currentIndex];
      if (currentToken && currentToken.access_token === currentAccessToken) {
        try {
          await this.refreshToken(currentToken);
          log.info('Token刷新成功，返回新token');
          return currentToken;
        } catch (refreshError) {
          if (refreshError.statusCode === 403) {
            log.warn('刷新token也遇到403，禁用并切换到下一个');
            this.disableToken(currentToken);
            return await this.getToken();
          }
          log.error('刷新token失败:', refreshError.message);
        }
      }
      return await this.getToken();
    }
    return null;
  }
}
const tokenManager = new TokenManager();
export default tokenManager;
