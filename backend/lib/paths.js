// backend/lib/paths.js
// 统一数据路径解析：打包为 Electron 桌面版后，工作区/userdata/技能库
// 必须落在可写目录（app.asar 内部只读），未打包时保持原项目目录结构

import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 是否运行在 asar 打包环境中
export const isPackaged = __dirname.includes('app.asar');

/**
 * 数据根目录：
 * - 打包环境 → %APPDATA%/AI-Orchestrator（可写）
 * - 开发环境 → 项目根目录（backend/../）
 */
export function getDataRoot() {
  if (isPackaged) {
    const base = process.env.APPDATA || path.join(os.homedir(), '.config');
    return path.join(base, 'AI-Orchestrator');
  }
  return path.join(__dirname, '..', '..');
}

/** 项目运行会话数据目录 userdata/ */
export function getUserdataDir() {
  return path.join(getDataRoot(), 'userdata');
}

/** 项目代码构建产物目录 workspace/ */
export function getWorkspaceBase() {
  return path.join(getDataRoot(), 'workspace');
}

/**
 * 技能库目录：
 * - 打包环境 → 可写目录，并自动从 asar 内置技能复制初始技能
 * - 开发环境 → backend/skills/
 */
export function getSkillsDir() {
  if (isPackaged) {
    const dir = path.join(getDataRoot(), 'skills');
    seedBuiltinSkills(dir);
    return dir;
  }
  return path.join(__dirname, '..', '..', 'backend', 'skills');
}

// 从 asar 内置技能复制到可写目录（仅首次）
function seedBuiltinSkills(targetDir) {
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const builtinDir = path.join(__dirname, '..', '..', 'backend', 'skills');
    if (!fs.existsSync(builtinDir)) return;
    for (const file of fs.readdirSync(builtinDir)) {
      if (!file.endsWith('.skill.json')) continue;
      const dest = path.join(targetDir, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(builtinDir, file), dest);
        console.log(`[Paths] 内置技能已复制到可写目录: ${file}`);
      }
    }
  } catch (e) {
    console.warn('[Paths] 内置技能复制失败:', e.message);
  }
}
