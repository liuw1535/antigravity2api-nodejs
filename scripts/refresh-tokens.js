import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import log from '../src/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

async function refreshToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
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

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

async function refreshAllTokens() {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    log.error(`文件不存在: ${ACCOUNTS_FILE}`);
    process.exit(1);
  }

  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
  log.info(`找到 ${accounts.length} 个账号`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    
    if (account.enable === false) {
      log.warn(`账号 ${i + 1}: 已禁用，跳过`);
      continue;
    }

    try {
      log.info(`刷新账号 ${i + 1}...`);
      const tokenData = await refreshToken(account.refresh_token);
      account.access_token = tokenData.access_token;
      account.expires_in = tokenData.expires_in;
      account.timestamp = Date.now();
      
      successCount++;
      log.info(`账号 ${i + 1}: 刷新成功`);
    } catch (error) {
      failCount++;
      log.error(`账号 ${i + 1}: 刷新失败 - ${error.message}`);
      
      if (error.message.includes('invalid_grant') || error.message.includes('400')) {
        account.enable = false;
        log.warn(`账号 ${i + 1}: Token 已失效或错误，已自动禁用该账号`);
      }
    }
  }

  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
  log.info(`刷新完成: 成功 ${successCount} 个, 失败 ${failCount} 个`);
}

refreshAllTokens().catch(err => {
  log.error('刷新失败:', err.message);
  process.exit(1);
});
