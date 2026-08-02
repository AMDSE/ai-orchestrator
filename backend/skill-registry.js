// backend/skill-registry.js
// 技能注册中心：动态加载 backend/skills/*.skill.json，支持热更新与 WebSocket 推送

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getSkillsDir } from './lib/paths.js';
const SKILLS_DIR = getSkillsDir();

class SkillRegistry {
  constructor() {
    this.skills = new Map();         // skillId -> skillObject
    this._emitter = null;            // 注入 orchestrator EventEmitter 广播
    this._watcher = null;
  }

  /**
   * 初始化：扫描并加载所有 .skill.json 文件
   */
  async init(emitter = null) {
    this._emitter = emitter;
    await this._loadAll();
    this._watchSkillsDir();
    console.log(`[SkillRegistry] 已加载 ${this.skills.size} 个技能: ${[...this.skills.keys()].join(', ')}`);
  }

  /**
   * 扫描加载所有技能文件
   */
  async _loadAll() {
    try {
      fs.mkdirSync(SKILLS_DIR, { recursive: true });
    } catch {}

    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.skill.json'));
    for (const file of files) {
      this._loadFile(file);
    }
  }

  /**
   * 加载单个技能文件
   */
  _loadFile(filename) {
    try {
      const filePath = path.join(SKILLS_DIR, filename);
      const raw = fs.readFileSync(filePath, 'utf-8');
      const skill = JSON.parse(raw);
      if (skill.id) {
        this.skills.set(skill.id, skill);
        console.log(`[SkillRegistry] ✅ 加载技能: ${skill.name} (${skill.id})`);
      }
    } catch (e) {
      console.error(`[SkillRegistry] ❌ 加载技能文件失败: ${filename}`, e.message);
    }
  }

  /**
   * 监听 skills/ 目录变化（热加载新炼化的技能）
   */
  _watchSkillsDir() {
    try {
      this._watcher = fs.watch(SKILLS_DIR, (eventType, filename) => {
        if (!filename || !filename.endsWith('.skill.json')) return;
        console.log(`[SkillRegistry] 🔄 检测到技能文件变化: ${filename}`);
        this._loadFile(filename);
        // 广播给所有 WebSocket 客户端刷新技能栏
        if (this._emitter) {
          this._emitter.emit('skills_updated', {
            skills: this.getAllForClient()
          });
        }
      });
    } catch (e) {
      console.warn('[SkillRegistry] 无法监听 skills/ 目录:', e.message);
    }
  }

  /**
   * 根据 skillId 获取技能
   */
  getSkill(skillId) {
    return this.skills.get(skillId) || null;
  }

  /**
   * 获取技能的执行脑 Prompt 注入内容
   */
  getSkillPrompt(skillId) {
    const skill = this.getSkill(skillId);
    if (!skill || !skill.systemPrompt) return '';
    return skill.systemPrompt;
  }

  /**
   * 获取所有技能（供前端展示）
   */
  getAllForClient() {
    return [...this.skills.values()].map(s => ({
      id: s.id,
      name: s.name,
      icon: s.icon || '🔧',
      description: s.description,
      version: s.version,
      builtIn: s.builtIn || false,
      targetPlatform: s.targetPlatform || '',
      sourceDocs: s.sourceDocs || [],
      createdAt: s.createdAt || null
    }));
  }

  /**
   * 保存新炼化的技能（来自 SkillAlchemist）
   */
  saveSkill(skillData) {
    const filename = `${skillData.id}.skill.json`;
    const filePath = path.join(SKILLS_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(skillData, null, 2), 'utf-8');
    this.skills.set(skillData.id, skillData);
    console.log(`[SkillRegistry] 💾 技能已保存: ${skillData.name} → ${filename}`);
    return skillData;
  }

  /**
   * 删除技能
   */
  deleteSkill(skillId) {
    const skill = this.skills.get(skillId);
    if (!skill) throw new Error('技能不存在');
    if (skill.builtIn) throw new Error('内置技能不可删除');

    const filePath = path.join(SKILLS_DIR, `${skillId}.skill.json`);
    try { fs.unlinkSync(filePath); } catch {}
    this.skills.delete(skillId);
    console.log(`[SkillRegistry] 🗑️ 已删除技能: ${skillId}`);
  }
}

export const skillRegistry = new SkillRegistry();
