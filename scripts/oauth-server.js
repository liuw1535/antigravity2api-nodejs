import http from 'http';
import https from 'https';
import { URL } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import log from '../src/utils/logger.js';
import config from '../src/config/config.js';
import axios from 'axios';

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

const RESOURCE_MANAGER_API_URL = 'cloudresourcemanager.googleapis.com';
const SERVICE_USAGE_API_URL = 'serviceusage.googleapis.com';
const REQUIRE_SERVICES = [
  "geminicloudassist.googleapis.com",  // Gemini Cloud Assist API
  "cloudaicompanion.googleapis.com",  // Gemini for Google Cloud API
]

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

function exchangeCodeForToken(code, port) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      code: code,
      client_id: CLIENT_ID,
      redirect_uri: `http://localhost:${port}/oauth-callback`,
      grant_type: 'authorization_code'
    });
    
    if (CLIENT_SECRET) {
      postData.append('client_secret', CLIENT_SECRET);
    }
    
    const data = postData.toString();
    
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function refreshToken(account) {
  log.info('正在刷新token...');
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: account.refresh_token
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

    account.access_token = response.data.access_token;
    account.expires_in = response.data.expires_in;
    account.timestamp = Date.now();
    return account;
  } catch (error) {
    throw { statusCode: error.response?.status, message: error.response?.data || error.message };
  }
}

async function getProjects(account) {
  const options = {
    hostname: RESOURCE_MANAGER_API_URL,
    path: '/v1/projects',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${account.access_token}`,
      'User-Agent': config.api.userAgent
    }
  };
  
  const response = await new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  }).catch(err => {
    log.error('获取项目列表失败:', err.message);
    return {};
  });
  if (!response.projects) return [];
  log.info(`获取到api响应：${response}`);
  const projects = response.projects || [];
  const activeProjects = projects.filter(project => project.lifecycleState === 'ACTIVE');
  log.info(`获取到项目列表：${activeProjects}`);
  return activeProjects;
}

async function enableApiForProject(account, projectId, apiName) {
  const headers = {
    'Authorization': `Bearer ${account.access_token}`,
    "Content-Type": "application/json",
    'User-Agent': config.api.userAgent
  };
  const check_options = {
    hostname: SERVICE_USAGE_API_URL,
    path: `/v1/projects/${projectId}/services/${apiName}`,
    method: 'GET',
    headers
  };
  const response = await new Promise((resolve, reject) => {
    const req = https.request(check_options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  }).catch(err => {
    log.error('获取服务状态失败:', err.message);
    return {};
  });
  if (response.state === 'ENABLED') {
    log.info(`${apiName}已启用`);
    return true;
  }
  log.info(`正在启用${apiName}...`);
  const enable_options = {
    hostname: SERVICE_USAGE_API_URL,
    path: `/v1/projects/${projectId}/services/${apiName}:enable`,
    method: 'POST',
    headers
  };
  return new Promise((resolve, reject) => {
    const req = https.request(enable_options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode in [200, 201]) {
          resolve(true);
        } else if (res.statusCode === 400) {
          const error_data = JSON.parse(body);
          if (error_data.error && error_data.error.message?.toLowerCase().includes('already enabled')) {
            log.info(`${apiName}已启用`);
            resolve(true);
            return;
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        }
      })
    })
    req.on('error', reject);
    req.end();
  }).catch(err => {
    log.error('启用服务失败:', err.message);
    return {};
  });

}


const server = http.createServer((req, res) => {
  const port = server.address().port;
  const url = new URL(req.url, `http://localhost:${port}`);
  
  if (url.pathname === '/oauth-callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    
    if (code) {
      log.info('收到授权码，正在交换 Token...');
      exchangeCodeForToken(code, port).then(async tokenData => {
        log.info('Token 交换成功，具体信息：', tokenData);
        let account = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_in: tokenData.expires_in,
          timestamp: Date.now()
        };

        // 接下来分为四步：刷新token -> 获取所有项目 -> 选择默认项目或者第一个项目 -> 开启对应api
        // account = await refreshToken(account);
        // log.info(`token刷新成功，新token为 ${account}`)
        // const projects = await getProjects(account);
        // if (projects.length === 0) {
        //   log.warn('获取不到项目或没有可用的项目');
        //   return;
        // }
        // const defaultProject = projects.find(project => project.projectId in config.projectIds) || projects[0];
        // log.info(`正在使用项目 ${defaultProject.projectId}`);
        // const res = REQUIRE_SERVICES.map(apiName => enableApiForProject(account, defaultProject.projectId, apiName));
        // // 所有项全过才行
        // const enable_res = await Promise.all(res).then(res => res.every(r => r));
        // if (!enable_res) {
        //   log.warn('启用api服务失败');
        //   return;
        // }
        // account.projectId = defaultProject.projectId;
        
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
        //log.info(`过期时间: ${account.expires_in}秒`);
        
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
