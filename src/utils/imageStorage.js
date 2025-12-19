import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config/config.js';
import { getDefaultIp } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 检测是否在 pkg 打包环境中运行
const isPkg = typeof process.pkg !== 'undefined';

// 获取图片存储目录
// pkg 环境下使用可执行文件所在目录或当前工作目录
function getImageDir() {
  if (isPkg) {
    // pkg 环境：优先使用可执行文件旁边的 public/images 目录
    const exeDir = path.dirname(process.execPath);
    const exeImageDir = path.join(exeDir, 'public', 'images');
    try {
      if (!fs.existsSync(exeImageDir)) {
        fs.mkdirSync(exeImageDir, { recursive: true });
      }
      return exeImageDir;
    } catch (e) {
      // 如果无法创建，尝试当前工作目录
      const cwdImageDir = path.join(process.cwd(), 'public', 'images');
      try {
        if (!fs.existsSync(cwdImageDir)) {
          fs.mkdirSync(cwdImageDir, { recursive: true });
        }
        return cwdImageDir;
      } catch (e2) {
        // 最后使用用户主目录
        const homeImageDir = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.antigravity', 'images');
        if (!fs.existsSync(homeImageDir)) {
          fs.mkdirSync(homeImageDir, { recursive: true });
        }
        return homeImageDir;
      }
    }
  }
  // 开发环境
  return path.join(__dirname, '../../public/images');
}

const IMAGE_DIR = getImageDir();

// 确保图片目录存在（开发环境）
if (!isPkg && !fs.existsSync(IMAGE_DIR)) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

// MIME 类型到文件扩展名映射
const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

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
