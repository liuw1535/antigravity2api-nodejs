/**
 * API 调用监控统计
 * 以内存环形历史记录保存最近 30 天的 API 请求与 token 用量。
 */

import fs from 'fs';
import path from 'path';
import { getDataDir } from './paths.js';

const MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const API_PATH_PREFIXES = ['/v1/', '/v1beta/', '/cli/v1/'];
const DATA_FILE = path.join(getDataDir(), 'usage-stats.json');

function startOfUtcDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function emptyTotals() {
  return {
    requests: 0,
    success: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
}

function toSafeCount(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function normalizeUsage(usage = {}) {
  const inputTokens = Number(
    usage.prompt_tokens ??
    usage.input_tokens ??
    usage.promptTokenCount ??
    usage.inputTokenCount ??
    0
  ) || 0;
  const outputTokens = Number(
    usage.completion_tokens ??
    usage.output_tokens ??
    usage.candidatesTokenCount ??
    usage.outputTokenCount ??
    0
  ) || 0;
  const totalTokens = Number(
    usage.total_tokens ??
    usage.totalTokenCount ??
    inputTokens + outputTokens
  ) || inputTokens + outputTokens;

  return { inputTokens, outputTokens, totalTokens };
}

function createBucket(day) {
  return {
    day,
    ...emptyTotals(),
    models: {}
  };
}

class UsageStatsStore {
  constructor() {
    this.buckets = new Map();
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(DATA_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const bucket of raw.buckets || []) {
        if (bucket?.day) {
          this.buckets.set(Number(bucket.day), bucket);
        }
      }
      this.prune();
    } catch {
      this.buckets = new Map();
    }
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1000);
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify({ buckets: Array.from(this.buckets.values()) }, null, 2));
    } catch {
      // 监控统计不能影响主请求链路
    }
  }

  shouldTrackPath(path = '') {
    return API_PATH_PREFIXES.some(prefix => path.startsWith(prefix));
  }

  record({ timestamp = Date.now(), statusCode = 0, model = 'unknown', usage = {}, successCount, failedCount } = {}) {
    const day = startOfUtcDay(timestamp);
    const bucket = this.buckets.get(day) || createBucket(day);
    const normalizedUsage = normalizeUsage(usage);
    const modelName = typeof model === 'string' && model.trim() ? model.trim() : 'unknown';
    const failed = statusCode >= 400 || statusCode === 0;
    const success = successCount === undefined ? (failed ? 0 : 1) : toSafeCount(successCount);
    const failedAttempts = failedCount === undefined ? (failed ? 1 : 0) : toSafeCount(failedCount);
    const requests = success + failedAttempts;

    bucket.requests += requests;
    bucket.success += success;
    bucket.failed += failedAttempts;
    bucket.inputTokens += normalizedUsage.inputTokens;
    bucket.outputTokens += normalizedUsage.outputTokens;
    bucket.totalTokens += normalizedUsage.totalTokens;

    const modelStats = bucket.models[modelName] || emptyTotals();
    modelStats.requests += requests;
    modelStats.success += success;
    modelStats.failed += failedAttempts;
    modelStats.inputTokens += normalizedUsage.inputTokens;
    modelStats.outputTokens += normalizedUsage.outputTokens;
    modelStats.totalTokens += normalizedUsage.totalTokens;
    bucket.models[modelName] = modelStats;

    this.buckets.set(day, bucket);
    this.prune(timestamp);
    this.scheduleSave();
  }

  prune(now = Date.now()) {
    const minDay = startOfUtcDay(now - (MAX_DAYS - 1) * DAY_MS);
    for (const day of this.buckets.keys()) {
      if (day < minDay) {
        this.buckets.delete(day);
      }
    }
  }

  getSummary(days = 7) {
    const safeDays = [7, 14, 30].includes(Number(days)) ? Number(days) : 7;
    const now = Date.now();
    const today = startOfUtcDay(now);
    const totals = emptyTotals();
    const modelMap = new Map();
    const daily = [];

    this.prune(now);

    for (let i = safeDays - 1; i >= 0; i--) {
      const day = today - i * DAY_MS;
      const bucket = this.buckets.get(day) || createBucket(day);
      daily.push({
        date: new Date(day).toISOString().slice(0, 10),
        requests: bucket.requests,
        success: bucket.success,
        failed: bucket.failed,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        totalTokens: bucket.totalTokens
      });

      for (const key of Object.keys(totals)) {
        totals[key] += bucket[key];
      }

      for (const [modelName, stats] of Object.entries(bucket.models)) {
        const merged = modelMap.get(modelName) || emptyTotals();
        for (const key of Object.keys(merged)) {
          merged[key] += stats[key] || 0;
        }
        modelMap.set(modelName, merged);
      }
    }

    const minutes = safeDays * 24 * 60;
    const models = Array.from(modelMap.entries())
      .map(([model, stats]) => ({ model, ...stats }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);

    return {
      rangeDays: safeDays,
      totals,
      averages: {
        tpm: totals.totalTokens / minutes,
        rpm: totals.requests / minutes,
        rdp: totals.requests / safeDays
      },
      models,
      daily,
      updatedAt: new Date(now).toISOString()
    };
  }
}

export const usageStats = new UsageStatsStore();
export function setUsageMetrics(req, { model, usage } = {}) {
  if (!req) return;
  req.apiUsageMetrics = {
    ...(req.apiUsageMetrics || {}),
    ...(model !== undefined ? { model } : {}),
    ...(usage !== undefined ? { usage } : {})
  };
}

export function recordUsageAttemptFailure(req, { model } = {}) {
  if (!req) return;
  req.apiUsageMetrics = {
    ...(req.apiUsageMetrics || {}),
    ...(model !== undefined ? { model } : {}),
    failedAttempts: toSafeCount(req.apiUsageMetrics?.failedAttempts) + 1
  };
}
export default usageStats;
