import http from 'http';
import { URL } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import log from '../src/utils/logger.js';
import axios from 'axios';
import config from '../src/config/config.js';
import { generateProjectId } from '../src/utils/idGenerator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const STATE = crypto.randomUUID();

const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
];

function generateAuthUrl(port) {
  const params = new URLSearchParams({
    access_type: 'offline',
    client_id: CLIENT_ID,
    prompt: 'consent',
    redirect_uri: `http://localhost:${port}/oauth-callback`,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state: STATE
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function getAxiosConfig() {
  const axiosConfig = { timeout: config.timeout };
  if (config.proxy) {
    const proxyUrl = new URL(config.proxy);
    axiosConfig.proxy = {
      protocol: proxyUrl.protocol.replace(':', ''),
      host: proxyUrl.hostname,
      port: parseInt(proxyUrl.port)
    };
  }
  return axiosConfig;
}

async function exchangeCodeForToken(code, port) {
  const postData = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: `http://localhost:${port}/oauth-callback`,
    grant_type: 'authorization_code'
  });
  
  const response = await axios({
    method: 'POST',
    url: 'https://oauth2.googleapis.com/token',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: postData.toString(),
    ...getAxiosConfig()
  });
  
  return response.data;
}

async function fetchUserEmail(accessToken) {
  const response = await axios({
    method: 'GET',
    url: 'https://www.googleapis.com/oauth2/v2/userinfo',
    headers: {
      'Host': 'www.googleapis.com',
      'User-Agent': 'Go-http-client/1.1',
      'Authorization': `Bearer ${accessToken}`,
      'Accept-Encoding': 'gzip'
    },
    ...getAxiosConfig()
  });
  return response.data?.email;
}

async function fetchProjectId(accessToken) {
  const response = await axios({
    method: 'POST',
    url: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
    headers: {
      'Host': 'daily-cloudcode-pa.sandbox.googleapis.com',
      'User-Agent': 'antigravity/1.11.9 windows/amd64',
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip'
    },
    data: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    ...getAxiosConfig()
  });
  return response.data?.cloudaicompanionProject;
}

const server = http.createServer((req, res) => {
  const port = server.address().port;
  const url = new URL(req.url, `http://localhost:${port}`);
  
  if (url.pathname === '/oauth-callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    
    if (code) {
      log.info('收到授权码，正在交换 Token...');
      exchangeCodeForToken(code, port).then(async (tokenData) => {
        const account = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_in: tokenData.expires_in,
          timestamp: Date.now()
        };
        
        try {
          const email = await fetchUserEmail(account.access_token);
          if (email) {
            account.email = email;
            log.info('获取到用户邮箱: ' + email);
          }
        } catch (err) {
          log.warn('获取用户邮箱失败:', err.message);
        }
        
        if (config.skipProjectIdFetch) {
          account.projectId = generateProjectId();
          account.enable = true;
          log.info('已跳过API验证，使用随机生成的projectId: ' + account.projectId);
        } else {
          log.info('正在验证账号资格...');
          try {
            const projectId = await fetchProjectId(account.access_token);
            if (projectId === undefined) {
              log.warn('该账号无资格使用（无法获取projectId），已跳过保存');
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end('<h1>账号无资格</h1><p>该账号无法获取projectId，未保存。</p>');
              setTimeout(() => server.close(), 1000);
              return;
            }
            account.projectId = projectId;
            account.enable = true;
            log.info('账号验证通过');
          } catch (err) {
            log.error('验证账号资格失败:', err.message);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>验证失败</h1><p>无法验证账号资格，请查看控制台。</p>');
            setTimeout(() => server.close(), 1000);
            return;
          }
        }
        
        let accounts = [];
        try {
          if (fs.existsSync(ACCOUNTS_FILE)) {
            accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
          }
        } catch (err) {
          log.warn('读取 accounts.json 失败，将创建新文件');
        }
        
        accounts.push(account);
        
        const dir = path.dirname(ACCOUNTS_FILE);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
        
        log.info(`Token 已保存到 ${ACCOUNTS_FILE}`);
        
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>授权成功！</h1><p>Token 已保存，可以关闭此页面。</p>');
        
        setTimeout(() => server.close(), 1000);
      }).catch(err => {
        log.error('Token 交换失败:', err.message);
        
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Token 获取失败</h1><p>查看控制台错误信息</p>');
        
        setTimeout(() => server.close(), 1000);
      });
    } else {
      log.error('授权失败:', error || '未收到授权码');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>授权失败</h1>');
      setTimeout(() => server.close(), 1000);
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(0, () => {
  const port = server.address().port;
  const authUrl = generateAuthUrl(port);
  log.info(`服务器运行在 http://localhost:${port}`);
  log.info('请在浏览器中打开以下链接进行登录：');
  console.log(`\n${authUrl}\n`);
  log.info('等待授权回调...');
});
