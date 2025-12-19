import fs from 'fs';
import path from 'path';
import config from '../config/config.js';
import { getDefaultIp } from './utils.js';
import { getImageDir, isPkg } from './paths.js';
import { MIME_TO_EXT } from '../constants/index.js';

const IMAGE_DIR = getImageDir();

// 确保图片目录存在（开发环境）
if (!isPkg && !fs.existsSync(IMAGE_DIR)) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

/**
 * 清理超过限制数量的旧图片
 * @param {number} maxCount - 最大保留图片数量
 */
function cleanOldImages(maxCount = 10) {
  const files = fs.readdirSync(IMAGE_DIR)
    .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
    .map(f => ({
      name: f,
      path: path.join(IMAGE_DIR, f),
      mtime: fs.statSync(path.join(IMAGE_DIR, f)).mtime.getTime()
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length > maxCount) {
    files.slice(maxCount).forEach(f => fs.unlinkSync(f.path));
  }
}

/**
 * 保存 base64 图片到本地并返回访问 URL
 * @param {string} base64Data - base64 编码的图片数据
 * @param {string} mimeType - 图片 MIME 类型
 * @returns {string} 图片访问 URL
 */
export function saveBase64Image(base64Data, mimeType) {
  const ext = MIME_TO_EXT[mimeType] || 'jpg';
  const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}.${ext}`;
  const filepath = path.join(IMAGE_DIR, filename);
  
  // 解码并保存
  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(filepath, buffer);
  
  // 清理旧图片
  cleanOldImages(config.maxImages);
  
  // 返回访问 URL
  const baseUrl = config.imageBaseUrl || `http://${getDefaultIp()}:${config.server.port}`;
  return `${baseUrl}/images/${filename}`;
}
