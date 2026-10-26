/**
 * 记忆库只读接口示例（原生 Node http，无框架依赖）。
 *
 * 三个接口：
 *   GET /api/memory/overview                → 一次拿全部（短期记忆已解析分区）
 *   GET /api/memory/diary?date=YYYY-MM-DD   → 单日日记原文
 *   GET /api/memory/bank?path=...           → 长期总库文件
 *
 * 安全：
 *   · 只读，没有任何写接口
 *   · date 白名单正则；path 必须 resolve 后仍在 memory-bank 之下
 *   · 请自行套上鉴权（token/cookie），别直接暴露到公网
 *
 * 用法：
 *   const { createMemoryApi } = require('./memory-api.example');
 *   const handle = createMemoryApi({ dir: '/home/ai/.ai-memory' });
 *   // 在你自己的 http 服务里：if (handle(req, res)) return;
 */
'use strict';

const fs = require('fs');
const path = require('path');

function createMemoryApi(options = {}) {
  const dir = options.dir || path.join(process.env.HOME || '.', '.ai-memory');
  const diaryDir = path.join(dir, 'diary');
  const bankDir = path.join(dir, 'memory-bank');
  const shortPath = path.join(dir, 'short-memory.md');
  const prefPath = path.join(dir, 'preferences.md');

  const statOf = (f) => {
    try {
      const st = fs.statSync(f);
      return { mtime: st.mtimeMs, bytes: st.size };
    } catch {
      return { mtime: 0, bytes: 0 };
    }
  };

  const readText = (f, max = 200000) => {
    try {
      const t = fs.readFileSync(f, 'utf8');
      return t.length > max ? t.slice(0, max) + '\n…（已截断）' : t;
    } catch {
      return '';
    }
  };

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

  function overview() {
    const shortText = readText(shortPath);
    const diary = [];
    try {
      for (const f of fs.readdirSync(diaryDir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
        const st = statOf(path.join(diaryDir, f));
        diary.push({ date: f.slice(0, 10), bytes: st.bytes, mtime: st.mtime });
      }
    } catch {}
    diary.sort((a, b) => (a.date < b.date ? 1 : -1));

    const bank = [];
    const walk = (d, prefix) => {
      let entries = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        const rel = prefix ? prefix + '/' + e.name : e.name;
        if (e.isDirectory()) walk(full, rel);
        else if (e.name.endsWith('.md')) {
          const st = statOf(full);
          bank.push({ path: rel, bytes: st.bytes, mtime: st.mtime });
        }
      }
    };
    walk(bankDir, '');

    let archiveCount = 0;
    try {
      archiveCount = fs.readdirSync(path.join(diaryDir, 'archive')).filter((f) => f.endsWith('.md')).length;
    } catch {}

    return {
      ok: true,
      short: { text: shortText, blocks: parseBlocks(shortText), ...statOf(shortPath) },
      preferences: { text: readText(prefPath), ...statOf(prefPath) },
      diary,
      bank,
      archiveCount
    };
  }

  function diary(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { status: 400, body: { ok: false, error: 'date 格式应为 YYYY-MM-DD' } };
    const f = path.join(diaryDir, date + '.md');
    if (!fs.existsSync(f)) return { status: 404, body: { ok: false, error: '没有这一天的日记' } };
    return { status: 200, body: { ok: true, date, text: fs.readFileSync(f, 'utf8') } };
  }

  function bankFile(rel) {
    const root = path.resolve(bankDir);
    const full = path.resolve(root, rel || '');
    if (!rel || !/\.md$/.test(rel) || !full.startsWith(root + path.sep)) {
      return { status: 400, body: { ok: false, error: 'path 不合法' } };
    }
    if (!fs.existsSync(full)) return { status: 404, body: { ok: false, error: '没有这个总库文件' } };
    return { status: 200, body: { ok: true, path: rel, text: fs.readFileSync(full, 'utf8') } };
  }

  /**
   * 返回 true 表示已处理；false 表示不是记忆接口，交回给调用方。
   */
  function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/memory/')) return false;
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '只读接口' }));
      return true;
    }

    let result;
    if (url.pathname === '/api/memory/overview') result = { status: 200, body: overview() };
    else if (url.pathname === '/api/memory/diary') result = diary(String(url.searchParams.get('date') || ''));
    else if (url.pathname === '/api/memory/bank') result = bankFile(String(url.searchParams.get('path') || ''));
    else result = { status: 404, body: { ok: false, error: '未知接口' } };

    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.body));
    return true;
  }

  return { handle, overview, diary, bankFile };
}

module.exports = { createMemoryApi };
