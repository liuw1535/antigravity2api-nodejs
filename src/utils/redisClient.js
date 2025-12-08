import Redis from 'ioredis';
import config from '../config/config.js';
import { log } from './logger.js';

class RedisClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.keyPrefix = config.redis.keyPrefix;
    this.init();
  }

  init() {
    if (!config.redis.url) {
      log.info('Redis URL 未配置，使用内存模式存储限流状态');
      return;
    }

    try {
      this.client = new Redis(config.redis.url, {
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100,
        lazyConnect: true
      });

      this.client.on('connect', () => {
        this.isConnected = true;
        log.info('Redis 连接成功');
      });

      this.client.on('error', (err) => {
        this.isConnected = false;
        log.warn('Redis 连接错误:', err.message);
      });

      this.client.on('close', () => {
        this.isConnected = false;
        log.warn('Redis 连接已关闭');
      });

      this.client.connect().catch(err => {
        log.warn('Redis 连接失败，将使用内存模式:', err.message);
      });
    } catch (error) {
      log.warn('Redis 初始化失败，将使用内存模式:', error.message);
    }
  }

  // 设置限流标记，带 TTL
  async setRateLimit(key, data, ttlSeconds) {
    if (!this.isConnected) return false;
    try {
      const fullKey = this.keyPrefix + 'ratelimit:' + key;
      await this.client.setex(fullKey, ttlSeconds, JSON.stringify(data));
      return true;
    } catch (error) {
      log.warn('Redis setRateLimit 失败:', error.message);
      return false;
    }
  }

  // 获取限流信息
  async getRateLimit(key) {
    if (!this.isConnected) return null;
    try {
      const fullKey = this.keyPrefix + 'ratelimit:' + key;
      const data = await this.client.get(fullKey);
      if (data) {
        const ttl = await this.client.ttl(fullKey);
        return { ...JSON.parse(data), ttl };
      }
      return null;
    } catch (error) {
      log.warn('Redis getRateLimit 失败:', error.message);
      return null;
    }
  }

  // 删除限流标记
  async deleteRateLimit(key) {
    if (!this.isConnected) return false;
    try {
      const fullKey = this.keyPrefix + 'ratelimit:' + key;
      await this.client.del(fullKey);
      return true;
    } catch (error) {
      log.warn('Redis deleteRateLimit 失败:', error.message);
      return false;
    }
  }

  // 删除某个 token 的所有限流标记
  async deleteRateLimitsByPattern(pattern) {
    if (!this.isConnected) return false;
    try {
      const fullPattern = this.keyPrefix + 'ratelimit:' + pattern + '*';
      const keys = await this.client.keys(fullPattern);
      if (keys.length > 0) {
        await this.client.del(...keys);
      }
      return true;
    } catch (error) {
      log.warn('Redis deleteRateLimitsByPattern 失败:', error.message);
      return false;
    }
  }

  // 获取某个 token 的所有限流模型
  async getRateLimitedModels(refreshToken) {
    if (!this.isConnected) return null;
    try {
      const pattern = this.keyPrefix + 'ratelimit:' + refreshToken + ':*';
      const keys = await this.client.keys(pattern);
      const models = [];

      for (const key of keys) {
        const data = await this.client.get(key);
        const ttl = await this.client.ttl(key);
        if (data && ttl > 0) {
          const parsed = JSON.parse(data);
          models.push({
            model: parsed.model,
            remainingSeconds: ttl
          });
        }
      }
      return models;
    } catch (error) {
      log.warn('Redis getRateLimitedModels 失败:', error.message);
      return null;
    }
  }

  // 检查是否可用
  available() {
    return this.isConnected;
  }

  // 关闭连接
  async close() {
    if (this.client) {
      await this.client.quit();
    }
  }
}

const redisClient = new RedisClient();
export default redisClient;
