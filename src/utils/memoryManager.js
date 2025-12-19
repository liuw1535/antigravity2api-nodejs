/**
 * 智能内存管理器
 * 采用分级策略，根据内存压力动态调整缓存和对象池
 * 目标：在保证性能的前提下，将内存稳定在 20MB 左右
 */

import logger from './logger.js';

// 内存压力级别
const MemoryPressure = {
  LOW: 'low',       // < 15MB - 正常运行
  MEDIUM: 'medium', // 15-25MB - 轻度清理
  HIGH: 'high',     // 25-35MB - 积极清理
  CRITICAL: 'critical' // > 35MB - 紧急清理
};

// 阈值配置（字节）
const THRESHOLDS = {
  LOW: 15 * 1024 * 1024,      // 15MB
  MEDIUM: 25 * 1024 * 1024,   // 25MB
  HIGH: 35 * 1024 * 1024,     // 35MB
  TARGET: 20 * 1024 * 1024    // 20MB 目标
};

// 对象池最大大小配置（根据压力调整）
const POOL_SIZES = {
  [MemoryPressure.LOW]: { chunk: 30, toolCall: 15, lineBuffer: 5 },
  [MemoryPressure.MEDIUM]: { chunk: 20, toolCall: 10, lineBuffer: 3 },
  [MemoryPressure.HIGH]: { chunk: 10, toolCall: 5, lineBuffer: 2 },
  [MemoryPressure.CRITICAL]: { chunk: 5, toolCall: 3, lineBuffer: 1 }
};

class MemoryManager {
  constructor() {
    this.currentPressure = MemoryPressure.LOW;
    this.cleanupCallbacks = new Set();
    this.lastGCTime = 0;
    this.gcCooldown = 10000; // GC 冷却时间 10秒
    this.checkInterval = null;
    this.isShuttingDown = false;
    
    // 统计信息
    this.stats = {
      gcCount: 0,
      cleanupCount: 0,
      peakMemory: 0
    };
  }

  /**
   * 启动内存监控
   * @param {number} interval - 检查间隔（毫秒）
   */
  start(interval = 30000) {
    if (this.checkInterval) return;
    
    this.checkInterval = setInterval(() => {
      if (!this.isShuttingDown) {
        this.check();
      }
    }, interval);
    
    // 首次立即检查
    this.check();
    logger.info(`内存管理器已启动 (检查间隔: ${interval/1000}秒)`);
  }

  /**
   * 停止内存监控
   */
  stop() {
    this.isShuttingDown = true;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.cleanupCallbacks.clear();
    logger.info('内存管理器已停止');
  }

  /**
   * 注册清理回调
   * @param {Function} callback - 清理函数，接收 pressure 参数
   */
  registerCleanup(callback) {
    this.cleanupCallbacks.add(callback);
  }

  /**
   * 取消注册清理回调
   * @param {Function} callback
   */
  unregisterCleanup(callback) {
    this.cleanupCallbacks.delete(callback);
  }

  /**
   * 获取当前内存使用情况
   */
  getMemoryUsage() {
    const usage = process.memoryUsage();
    return {
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      rss: usage.rss,
      external: usage.external,
      heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024 * 10) / 10
    };
  }

  /**
   * 确定内存压力级别
   */
  getPressureLevel(heapUsed) {
    if (heapUsed < THRESHOLDS.LOW) return MemoryPressure.LOW;
    if (heapUsed < THRESHOLDS.MEDIUM) return MemoryPressure.MEDIUM;
    if (heapUsed < THRESHOLDS.HIGH) return MemoryPressure.HIGH;
    return MemoryPressure.CRITICAL;
  }

  /**
   * 获取当前压力下的对象池大小配置
   */
  getPoolSizes() {
    return POOL_SIZES[this.currentPressure];
  }

  /**
   * 获取当前压力级别
   */
  getCurrentPressure() {
    return this.currentPressure;
  }

  /**
   * 检查内存并触发相应清理
   */
  check() {
    const { heapUsed, heapUsedMB } = this.getMemoryUsage();
    const newPressure = this.getPressureLevel(heapUsed);
    
    // 更新峰值统计
    if (heapUsed > this.stats.peakMemory) {
      this.stats.peakMemory = heapUsed;
    }
    
    // 压力级别变化时记录日志
    if (newPressure !== this.currentPressure) {
      logger.info(`内存压力变化: ${this.currentPressure} -> ${newPressure} (${heapUsedMB}MB)`);
      this.currentPressure = newPressure;
    }
    
    // 根据压力级别执行不同策略
    switch (newPressure) {
      case MemoryPressure.CRITICAL:
        this.handleCriticalPressure(heapUsedMB);
        break;
      case MemoryPressure.HIGH:
        this.handleHighPressure(heapUsedMB);
        break;
      case MemoryPressure.MEDIUM:
        this.handleMediumPressure(heapUsedMB);
        break;
      // LOW 压力不需要特殊处理
    }
    
    return newPressure;
  }

  /**
   * 处理中等压力
   */
  handleMediumPressure(heapUsedMB) {
    // 通知各模块缩减对象池
    this.notifyCleanup(MemoryPressure.MEDIUM);
    this.stats.cleanupCount++;
  }

  /**
   * 处理高压力
   */
  handleHighPressure(heapUsedMB) {
    logger.info(`内存较高 (${heapUsedMB}MB)，执行积极清理`);
    this.notifyCleanup(MemoryPressure.HIGH);
    this.stats.cleanupCount++;
    
    // 尝试触发 GC（带冷却）
    this.tryGC();
  }

  /**
   * 处理紧急压力
   */
  handleCriticalPressure(heapUsedMB) {
    logger.warn(`内存紧急 (${heapUsedMB}MB)，执行紧急清理`);
    this.notifyCleanup(MemoryPressure.CRITICAL);
    this.stats.cleanupCount++;
    
    // 强制 GC（忽略冷却）
    this.forceGC();
  }

  /**
   * 通知所有注册的清理回调
   */
  notifyCleanup(pressure) {
    for (const callback of this.cleanupCallbacks) {
      try {
        callback(pressure);
      } catch (error) {
        logger.error('清理回调执行失败:', error.message);
      }
    }
  }

  /**
   * 尝试触发 GC（带冷却时间）
   */
  tryGC() {
    const now = Date.now();
    if (now - this.lastGCTime < this.gcCooldown) {
      return false;
    }
    return this.forceGC();
  }

  /**
   * 强制触发 GC
   */
  forceGC() {
    if (global.gc) {
      const before = this.getMemoryUsage().heapUsedMB;
      global.gc();
      this.lastGCTime = Date.now();
      this.stats.gcCount++;
      const after = this.getMemoryUsage().heapUsedMB;
      logger.info(`GC 完成: ${before}MB -> ${after}MB (释放 ${(before - after).toFixed(1)}MB)`);
      return true;
    }
    return false;
  }

  /**
   * 手动触发检查和清理
   */
  cleanup() {
    return this.check();
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const memory = this.getMemoryUsage();
    return {
      ...this.stats,
      currentPressure: this.currentPressure,
      currentHeapMB: memory.heapUsedMB,
      peakMemoryMB: Math.round(this.stats.peakMemory / 1024 / 1024 * 10) / 10,
      poolSizes: this.getPoolSizes()
    };
  }
}

// 单例导出
const memoryManager = new MemoryManager();
export default memoryManager;

// 统一封装注册清理回调，方便在各模块中保持一致风格
export function registerMemoryPoolCleanup(pool, getMaxSize) {
  memoryManager.registerCleanup(() => {
    const maxSize = getMaxSize();
    while (pool.length > maxSize) {
      pool.pop();
    }
  });
}
export { MemoryPressure, THRESHOLDS };