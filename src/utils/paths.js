/**
 * 路径工具模块
 * 统一处理 pkg 打包环境和开发环境下的路径获取
 * @module utils/paths
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 检测是否在 pkg 打包环境中运行
 * @type {boolean}
 */
export const isPkg = typeof process.pkg !== 'undefined';

/**
 * 获取项目根目录
 * @returns {string} 项目根目录路径
 */
export function getProjectRoot() {
  if (isPkg) {
    return path.dirname(process.execPath);
  }
  return path.join(__dirname, '../..');
}

/**
 * 获取数据目录路径
 * pkg 环境下使用可执行文件所在目录或当前工作目录
 * @returns {string} 数据目录路径
 */
export function getDataDir() {
  if (isPkg) {
    // pkg 环境：优先使用可执行文件旁边的 data 目录
    const exeDir = path.dirname(process.execPath);
    const exeDataDir = path.join(exeDir, 'data');
    // 检查是否可以在该目录创建文件
    try {
      if (!fs.existsSync(exeDataDir)) {
        fs.mkdirSync(exeDataDir, { recursive: true });
      }
      return exeDataDir;
    } catch (e) {
      // 如果无法创建，尝试当前工作目录
      const cwdDataDir = path.join(process.cwd(), 'data');
      try {
        if (!fs.existsSync(cwdDataDir)) {
          fs.mkdirSync(cwdDataDir, { recursive: true });
        }
        return cwdDataDir;
      } catch (e2) {
        // 最后使用用户主目录
        const homeDataDir = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.antigravity', 'data');
        if (!fs.existsSync(homeDataDir)) {
          fs.mkdirSync(homeDataDir, { recursive: true });
        }
        return homeDataDir;
      }
    }
  }
  // 开发环境
  return path.join(__dirname, '..', '..', 'data');
}

/**
 * 获取公共静态文件目录
 * @returns {string} public 目录路径
 */
export function getPublicDir() {
  if (isPkg) {
    // pkg 环境：优先使用可执行文件旁边的 public 目录
    const exeDir = path.dirname(process.execPath);
    const exePublicDir = path.join(exeDir, 'public');
    if (fs.existsSync(exePublicDir)) {
      return exePublicDir;
    }
    // 其次使用当前工作目录的 public 目录
    const cwdPublicDir = path.join(process.cwd(), 'public');
    if (fs.existsSync(cwdPublicDir)) {
      return cwdPublicDir;
    }
    // 最后使用打包内的 public 目录（通过 snapshot）
    return path.join(__dirname, '../../public');
  }
  // 开发环境
  return path.join(__dirname, '../../public');
}

/**
 * 获取图片存储目录
 * @returns {string} 图片目录路径
 */
export function getImageDir() {
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

/**
 * 获取 .env 文件路径
 * @returns {string} .env 文件路径
 */
export function getEnvPath() {
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

/**
 * 获取配置文件路径集合
 * @returns {{envPath: string, configJsonPath: string, examplePath: string}} 配置文件路径
 */
export function getConfigPaths() {
  if (isPkg) {
    // pkg 环境：优先使用可执行文件旁边的配置文件
    const exeDir = path.dirname(process.execPath);
    const cwdDir = process.cwd();
    
    // 查找 .env 文件
    let envPath = path.join(exeDir, '.env');
    if (!fs.existsSync(envPath)) {
      const cwdEnvPath = path.join(cwdDir, '.env');
      if (fs.existsSync(cwdEnvPath)) {
        envPath = cwdEnvPath;
      }
    }
    
    // 查找 config.json 文件
    let configJsonPath = path.join(exeDir, 'config.json');
    if (!fs.existsSync(configJsonPath)) {
      const cwdConfigPath = path.join(cwdDir, 'config.json');
      if (fs.existsSync(cwdConfigPath)) {
        configJsonPath = cwdConfigPath;
      }
    }
    
    // 查找 .env.example 文件
    let examplePath = path.join(exeDir, '.env.example');
    if (!fs.existsSync(examplePath)) {
      const cwdExamplePath = path.join(cwdDir, '.env.example');
      if (fs.existsSync(cwdExamplePath)) {
        examplePath = cwdExamplePath;
      }
    }
    
    return { envPath, configJsonPath, examplePath };
  }
  
  // 开发环境
  return {
    envPath: path.join(__dirname, '../../.env'),
    configJsonPath: path.join(__dirname, '../../config.json'),
    examplePath: path.join(__dirname, '../../.env.example')
  };
}

/**
 * 计算相对路径用于日志显示
 * @param {string} absolutePath - 绝对路径
 * @returns {string} 相对路径或原路径
 */
export function getRelativePath(absolutePath) {
  if (isPkg) {
    const exeDir = path.dirname(process.execPath);
    if (absolutePath.startsWith(exeDir)) {
      return '.' + absolutePath.slice(exeDir.length).replace(/\\/g, '/');
    }
    const cwdDir = process.cwd();
    if (absolutePath.startsWith(cwdDir)) {
      return '.' + absolutePath.slice(cwdDir.length).replace(/\\/g, '/');
    }
  }
  return absolutePath;
}