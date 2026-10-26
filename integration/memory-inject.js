/**
 * 记忆注入（把记忆文件变成每轮提示词的一段）——可复用模块。
 *
 * 这是整套框架里**最容易被忽略、但最影响效果**的一环：
 * 记忆文件建得再好，如果每轮不注入，模型就永远只看得到"当下"。
 *
 * 用法：
 *   const { createMemoryInjector } = require('./memory-inject');
 *   const mem = createMemoryInjector({
 *     dir: '/home/ai/.ai-memory',
 *     onLoad: (info) => console.log('记忆已加载', info)
 *   });
 *   const block = mem.buildPromptSection('group:123456');   // 群聊只给 [群]+[通用]
 *   const block2 = mem.buildPromptSection('private:654321'); // 私聊给全部
 *
 * 设计要点（都是踩过坑换来的）：
 *   1. 按 mtime 缓存，文件不变就不重复读盘；每天轮转后自动重载。
 *   2. 群聊**结构性拿不到 [私聊] 分区**——不是提示词劝她别说，而是内容根本没进上下文。
 *   3. 注入放在提示词靠前位置（紧跟身份/令牌之后），注意力更集中。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SHORT_FILE = 'short-memory.md';
const PREF_FILE = 'preferences.md';

// 偏好库只取这三栏，丢掉"来源/学习回路"这类给人看的元信息
const PREF_SECTIONS = ['喜欢', '讨厌', '立场'];

const MAX_SHORT_CHARS = 1200;
const MAX_PREF_CHARS = 600;

function parseBlocks(text) {
  const blocks = [];
  let cur = { name: '其他', lines: [] };
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trimEnd();
    const h = /^##\s*(?:\[([^\]]+)\]|(.+))\s*$/.exec(line.trim());
    if (h) {
      if (cur.lines.length || cur.name !== '其他') blocks.push(cur);
      cur = { name: (h[1] || h[2] || '其他').trim(), lines: [] };
      continue;
    }
    if (line.startsWith('# ') || !line.trim()) continue;
    cur.lines.push(line);
  }
  if (cur.lines.length || cur.name !== '其他') blocks.push(cur);
  return blocks;
}

function parsePreferences(text) {
  const out = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    const m = /^##\s+(.+)$/.exec(t);
    if (m) {
      const name = m[1].trim();
      current = PREF_SECTIONS.includes(name) ? [] : null;
      if (current) out.push([name, current]);
      continue;
    }
    if (!current || !t.startsWith('- ')) continue;
    // 去掉（来源：…）/（2026-10-26）这类括号：日期会让模型把它当"档案"念出来
    const item = t.slice(2).replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
    if (item) current.push(item);
  }
  return out.filter(([, items]) => items.length);
}

function createMemoryInjector(options = {}) {
  const dir = options.dir || path.join(process.env.HOME || '.', '.ai-memory');
  const shortPath = path.join(dir, SHORT_FILE);
  const prefPath = path.join(dir, PREF_FILE);
  const onLoad = typeof options.onLoad === 'function' ? options.onLoad : null;

  let shortCache = { mtime: 0, blocks: [] };
  let prefCache = { mtime: 0, text: '' };

  function readShortBlocks() {
    try {
      const st = fs.statSync(shortPath);
      if (st.mtimeMs !== shortCache.mtime) {
        const text = fs.readFileSync(shortPath, 'utf8').trim();
        shortCache = { mtime: st.mtimeMs, blocks: parseBlocks(text) };
        if (onLoad) onLoad({ file: SHORT_FILE, chars: text.length, blocks: shortCache.blocks.length });
      }
    } catch {
      return [];
    }
    return shortCache.blocks;
  }

  function readPreferencesText() {
    try {
      const st = fs.statSync(prefPath);
      if (st.mtimeMs !== prefCache.mtime) {
        const lines = parsePreferences(fs.readFileSync(prefPath, 'utf8'))
          .map(([name, items]) => `${name}：${items.join('；')}`);
        prefCache = { mtime: st.mtimeMs, text: lines.join('\n') };
        if (onLoad) onLoad({ file: PREF_FILE, chars: prefCache.text.length });
      }
    } catch {
      return '';
    }
    return prefCache.text;
  }

  /**
   * 判定会话可见范围。**未知 key 一律拒绝**（fail-closed）。
   *
   * 为什么不能默认当群聊、也不能默认当私聊：
   *   旧实现用 `String(key||'').startsWith('group:')` 得到 isGroup，于是
   *   undefined / '' / 'qq-group-123' 都变成「非群聊」→ 返回全部分区，
   *   把 [私聊] 注进了群会话。这是把「结构性隔离」变成「默认放行」。
   * 未知 key 说明调用方接错了，必须炸出来，不能猜。
   */
  function resolveScope(key) {
    const raw = key == null ? '' : String(key);
    if (raw.startsWith('group:')) return 'group';
    if (raw.startsWith('private:')) return 'private';
    return null;
  }

  function buildPromptSection(key) {
    const scope = resolveScope(key);
    if (!scope) {
      throw new Error(
        `memory-inject: 无法识别的会话 key "${key == null ? String(key) : String(key)}"；` +
          '必须以 "group:" 或 "private:" 开头。为防把 [私聊] 分区注入群会话，这里直接拒绝而不是猜。'
      );
    }
    const isGroup = scope === 'group';
    const blocks = readShortBlocks();
    // 群聊只见 [群] + [通用]；私聊全部
    const visible = isGroup
      ? blocks.filter((b) => b.name === '群' || b.name === '通用')
      : blocks;
    const parts = [];

    if (visible.length) {
      const body = visible
        .map((b) => `【${b.name}】\n` + b.lines.join('\n'))
        .join('\n\n');
      const clipped = body.length > MAX_SHORT_CHARS ? body.slice(0, MAX_SHORT_CHARS - 1) + '…' : body;
      const scope = isGroup ? '（你在群里，只看得到群和通用部分）' : '（私聊，全部可见）';
      parts.push(`【你最近的日子（短期记忆）${scope}】\n${clipped}`);
    }

    const pref = readPreferencesText();
    if (pref) {
      const clipped = pref.length > MAX_PREF_CHARS ? pref.slice(0, MAX_PREF_CHARS - 1) + '…' : pref;
      parts.push(`【你的偏好（认下来的倾向，不是行为规则）】\n${clipped}`);
    }

    return parts.length ? parts.join('\n\n') + '\n\n' : '';
  }

  return {
    dir,
    buildPromptSection,
    // 便于测试/调试
    _readShortBlocks: readShortBlocks,
    _readPreferencesText: readPreferencesText
  };
}

module.exports = { createMemoryInjector, parseBlocks, parsePreferences };
