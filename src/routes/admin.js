import express from 'express';
import fs from 'fs';
import { generateToken, authMiddleware } from '../auth/jwt.js';
import tokenManager from '../auth/token_manager.js';
import quotaManager from '../auth/quota_manager.js';
import oauthManager from '../auth/oauth_manager.js';
import config, { getConfigJson, saveConfigJson } from '../config/config.js';
import logger from '../utils/logger.js';
import { parseEnvFile, updateEnvFile } from '../utils/envParser.js';
import { reloadConfig } from '../utils/configReloader.js';
import { deepMerge } from '../utils/deepMerge.js';
import { getModelsWithQuotas } from '../api/client.js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 检测是否在 pkg 打包环境中运行
const isPkg = typeof process.pkg !== 'undefined';

// 获取 .env 文件路径
// pkg 环境下使用可执行文件所在目录或当前工作目录
function getEnvPath() {
  if (isPkg) {
    // pkg 环境：优先使用可执行文件旁边的 .env
    const exeDir = path.dirname(process.execPath);
    const exeEnvPath = path.join(exeDir, '.env');
    if (fs.existsSync(exeEnvPath)) {
      return exeEnvPath;
    }
    // 其次使用当前工作目录的 .env
    const cwdEnvPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(cwdEnvPath)) {
      return cwdEnvPath;
    }
    // 返回可执行文件目录的路径（即使不存在）
    return exeEnvPath;
  }
  // 开发环境
  return path.join(__dirname, '../../.env');
}

const envPath = getEnvPath();

const router = express.Router();

// 登录接口
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  
  if (username === config.admin.username && password === config.admin.password) {
    const token = generateToken({ username, role: 'admin' });
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: '用户名或密码错误' });
  }
});

// Token管理API - 需要JWT认证
router.get('/tokens', authMiddleware, (req, res) => {
  const tokens = tokenManager.getTokenList();
  res.json({ success: true, data: tokens });
});

router.post('/tokens', authMiddleware, (req, res) => {
  const { access_token, refresh_token, expires_in, timestamp, enable, projectId, email } = req.body;
  if (!access_token || !refresh_token) {
    return res.status(400).json({ success: false, message: 'access_token和refresh_token必填' });
  }
  const tokenData = { access_token, refresh_token, expires_in };
  if (timestamp) tokenData.timestamp = timestamp;
  if (enable !== undefined) tokenData.enable = enable;
  if (projectId) tokenData.projectId = projectId;
  if (email) tokenData.email = email;
  
  const result = tokenManager.addToken(tokenData);
  res.json(result);
});

router.put('/tokens/:refreshToken', authMiddleware, (req, res) => {
  const { refreshToken } = req.params;
  const updates = req.body;
  const result = tokenManager.updateToken(refreshToken, updates);
  res.json(result);
});

router.delete('/tokens/:refreshToken', authMiddleware, (req, res) => {
  const { refreshToken } = req.params;
  const result = tokenManager.deleteToken(refreshToken);
  res.json(result);
});

router.post('/tokens/reload', authMiddleware, async (req, res) => {
  try {
    await tokenManager.reload();
    res.json({ success: true, message: 'Token已热重载' });
  } catch (error) {
    logger.error('热重载失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/oauth/exchange', authMiddleware, async (req, res) => {
  const { code, port } = req.body;
  if (!code || !port) {
    return res.status(400).json({ success: false, message: 'code和port必填' });
  }
  
  try {
    const account = await oauthManager.authenticate(code, port);
    const message = account.hasQuota 
      ? 'Token添加成功' 
      : 'Token添加成功（该账号无资格，已自动使用随机ProjectId）';
    res.json({ success: true, data: account, message, fallbackMode: !account.hasQuota });
  } catch (error) {
    logger.error('认证失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取配置
router.get('/config', authMiddleware, (req, res) => {
  try {
    const envData = parseEnvFile(envPath);
    const jsonData = getConfigJson();
    res.json({ success: true, data: { env: envData, json: jsonData } });
  } catch (error) {
    logger.error('读取配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新配置
router.put('/config', authMiddleware, (req, res) => {
  try {
    const { env: envUpdates, json: jsonUpdates } = req.body;
    
    if (envUpdates) updateEnvFile(envPath, envUpdates);
    if (jsonUpdates) saveConfigJson(deepMerge(getConfigJson(), jsonUpdates));
    
    dotenv.config({ override: true });
    reloadConfig();
    
    logger.info('配置已更新并热重载');
    res.json({ success: true, message: '配置已保存并生效（端口/HOST修改需重启）' });
  } catch (error) {
    logger.error('更新配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取轮询策略配置
router.get('/rotation', authMiddleware, (req, res) => {
  try {
    const rotationConfig = tokenManager.getRotationConfig();
    res.json({ success: true, data: rotationConfig });
  } catch (error) {
    logger.error('获取轮询配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 更新轮询策略配置
router.put('/rotation', authMiddleware, (req, res) => {
  try {
    const { strategy, requestCount } = req.body;
    
    // 验证策略值
    const validStrategies = ['round_robin', 'quota_exhausted', 'request_count'];
    if (strategy && !validStrategies.includes(strategy)) {
      return res.status(400).json({
        success: false,
        message: `无效的策略，可选值: ${validStrategies.join(', ')}`
      });
    }
    
    // 更新内存中的配置
    tokenManager.updateRotationConfig(strategy, requestCount);
    
    // 保存到config.json
    const currentConfig = getConfigJson();
    if (!currentConfig.rotation) currentConfig.rotation = {};
    if (strategy) currentConfig.rotation.strategy = strategy;
    if (requestCount) currentConfig.rotation.requestCount = requestCount;
    saveConfigJson(currentConfig);
    
    // 重载配置到内存
    reloadConfig();
    
    logger.info(`轮询策略已更新: ${strategy || '未变'}, 请求次数: ${requestCount || '未变'}`);
    res.json({ success: true, message: '轮询策略已更新', data: tokenManager.getRotationConfig() });
  } catch (error) {
    logger.error('更新轮询配置失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 获取指定Token的模型额度
router.get('/tokens/:refreshToken/quotas', authMiddleware, async (req, res) => {
  try {
    const { refreshToken } = req.params;
    const forceRefresh = req.query.refresh === 'true';
    const tokens = tokenManager.getTokenList();
    let tokenData = tokens.find(t => t.refresh_token === refreshToken);
    
    if (!tokenData) {
      return res.status(404).json({ success: false, message: 'Token不存在' });
    }
    
    // 检查token是否过期，如果过期则刷新
    if (tokenManager.isExpired(tokenData)) {
      try {
        tokenData = await tokenManager.refreshToken(tokenData);
      } catch (error) {
        logger.error('刷新token失败:', error.message);
        // 使用 400 而不是 401，避免前端误认为 JWT 登录过期
        return res.status(400).json({ success: false, message: 'Google Token已过期且刷新失败，请重新登录Google账号' });
      }
    }
    
    // 先从缓存获取（除非强制刷新）
    let quotaData = forceRefresh ? null : quotaManager.getQuota(refreshToken);
    
    if (!quotaData) {
      // 缓存未命中或强制刷新，从API获取
      const token = { access_token: tokenData.access_token, refresh_token: refreshToken };
      const quotas = await getModelsWithQuotas(token);
      quotaManager.updateQuota(refreshToken, quotas);
      quotaData = { lastUpdated: Date.now(), models: quotas };
    }
    
    // 转换时间为北京时间
    const modelsWithBeijingTime = {};
    Object.entries(quotaData.models).forEach(([modelId, quota]) => {
      modelsWithBeijingTime[modelId] = {
        remaining: quota.r,
        resetTime: quotaManager.convertToBeijingTime(quota.t),
        resetTimeRaw: quota.t
      };
    });
    
    res.json({ 
      success: true, 
      data: { 
        lastUpdated: quotaData.lastUpdated,
        models: modelsWithBeijingTime 
      } 
    });
  } catch (error) {
    logger.error('获取额度失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;