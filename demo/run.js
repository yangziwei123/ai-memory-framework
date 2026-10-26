#!/usr/bin/env node
/**
 * 记忆框架 demo —— 不需要任何依赖，一条命令看到全流程。
 *
 *   node demo/run.js            跑一遍（临时目录，跑完删掉）
 *   node demo/run.js --keep     保留临时目录，方便自己翻文件
 *
 * 它会做四件事：
 *   1. 造 5 篇假日记（含过期的一篇，用来演示归档）
 *   2. 跑真正的 memory_rotate.py（预演 + apply）
 *   3. 打印生成的 short-memory.md / review-due.md
 *   4. 用真正的注入模块，打印「群聊」和「私聊」各自会收到的提示词
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ROTATE = path.join(ROOT, 'memory_rotate.py');
const { createMemoryInjector } = require(path.join(ROOT, 'integration', 'memory-inject.js'));

const KEEP = process.argv.includes('--keep');

// ── 小工具 ────────────────────────────────────────────────────
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`
};

const line = (ch = '─') => console.log(c.dim(ch.repeat(66)));
const title = (s) => { console.log(''); line(); console.log(c.bold(s)); line(); };

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
}

// ── 1) 造样例日记 ─────────────────────────────────────────────
const DIARIES = {
  [day(0)]: `# ${day(0)}

## [群]
- 群里在聊显卡和加班费，没插话
- 有人 @ 我问配置单，说了两句
- 群友提到周末聚会，时间还没定

## [私聊]
- 他让我把记忆改成按块分区，别按日期
- 连考了两天的记录，我说没有；他提醒我日期要能对上

## [通用]
- 心情：被认真对待的感觉不错
- 教训：别拿"印象"当事实依据
`,
  [day(1)]: `# ${day(1)}

## [私聊]
- 部署了一个只读面板，方便他自己翻记忆
- 今天定下：群聊只注入 [群]+[通用]，私聊注入全部

## [通用]
- 喜欢把东西真跑通的那一刻
`,
  [day(2)]: `# ${day(2)}

## [群]
- 群里在讨论一个新出的模型，我没接话

## [私聊]
- 他说我回复太快会像人机，要按发微信的节奏
`,
  // 过期的一篇：10 天前，演示归档
  [day(10)]: `# ${day(10)}

## [私聊]
- 这是 10 天前的日记，超过保留期后会被归档进长期总库
`
};

// ── 2) 找 python ──────────────────────────────────────────────
function findPython() {
  for (const bin of ['python3', 'python', 'py']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0 && /Python 3/.test((r.stdout || '') + (r.stderr || ''))) return bin;
  }
  return null;
}

function runRotate(py, base, extraArgs = []) {
  const r = spawnSync(py, [ROTATE, '--base', base, ...extraArgs], {
    encoding: 'utf8',
    // Windows 控制台默认 GBK，强制 Python 用 UTF-8 输出，否则中文全是乱码
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  return { ok: r.status === 0, out };
}

// ── 主流程 ────────────────────────────────────────────────────
function main() {
  const py = findPython();
  if (!py) {
    console.error(c.yellow('\n找不到 Python 3。请先安装 Python 3.8+，或手动跑：'));
    console.error('  python3 memory_rotate.py --base ./demo-memory\n');
    process.exit(1);
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-demo-'));
  fs.mkdirSync(path.join(base, 'diary'), { recursive: true });
  for (const [date, text] of Object.entries(DIARIES)) {
    fs.writeFileSync(path.join(base, 'diary', `${date}.md`), text, 'utf8');
  }
  // 一份偏好库，演示它也会被注入
  fs.writeFileSync(path.join(base, 'preferences.md'), `# 偏好库

## 喜欢
- 把东西真跑通的那一刻
- 深夜没人吵

## 讨厌
- 重复劳动
- 废话、客服腔、分点汇报

## 立场
- 推荐类请求：先反问一句，不直接给清单。
`, 'utf8');

  console.log(c.cyan('\n记忆框架 demo'));
  console.log(c.dim(`  工作目录: ${base}`));
  console.log(c.dim(`  python:   ${py}`));
  console.log(c.dim(`  日记:     ${Object.keys(DIARIES).length} 篇（其中 1 篇已过期）`));

  // ── 预演 ──
  title('① 预演（不加 --apply：只重建短期记忆，不动日记）');
  const preview = runRotate(py, base);
  preview.out.split('\n').forEach((l) => console.log('  ' + l));

  const diaryAfterPreview = fs.readdirSync(path.join(base, 'diary')).filter((f) => f.endsWith('.md'));
  console.log('');
  console.log(`  ${c.green('✓')} 预演后 diary/ 仍有 ${diaryAfterPreview.length} 篇（过期那篇没被移动）`);

  // ── apply ──
  title('② 真正轮转（--apply：过期日记归档进长期总库）');
  const applied = runRotate(py, base, ['--apply']);
  applied.out.split('\n').forEach((l) => console.log('  ' + l));

  const diaryNow = fs.readdirSync(path.join(base, 'diary')).filter((f) => f.endsWith('.md')).sort();
  const archived = fs.existsSync(path.join(base, 'diary', 'archive'))
    ? fs.readdirSync(path.join(base, 'diary', 'archive')).filter((f) => f.endsWith('.md')).sort()
    : [];
  console.log('');
  console.log(`  ${c.green('✓')} diary/ 剩下 ${diaryNow.length} 篇：${diaryNow.join(', ')}`);
  console.log(`  ${c.green('✓')} archive/ 归档 ${archived.length} 篇：${archived.join(', ')}`);

  const bank = [];
  (function walk(d, prefix) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (e.name.endsWith('.md')) bank.push(rel);
    }
  })(path.join(base, 'memory-bank'), '');
  console.log(`  ${c.green('✓')} memory-bank/ 生成 ${bank.length} 个文件：${bank.join(', ')}`);

  // ── 生成的短期记忆 ──
  title('③ 生成的 short-memory.md（每轮注入的就是它）');
  const shortText = fs.readFileSync(path.join(base, 'short-memory.md'), 'utf8');
  shortText.trimEnd().split('\n').forEach((l) => console.log('  ' + l));
  console.log('');
  console.log(c.dim(`  共 ${shortText.length} 字符`));

  // ── 注入对比 ──
  title('④ 注入对比：群聊 vs 私聊');
  const mem = createMemoryInjector({ dir: base });
  const groupKey = 'group:123456789';
  const privateKey = 'private:987654321';
  const g = mem.buildPromptSection(groupKey);
  const p = mem.buildPromptSection(privateKey);

  console.log(c.bold(`【群聊 ${groupKey} 会收到】`) + c.dim(`  ${g.length} 字符`));
  g.trimEnd().split('\n').forEach((l) => console.log('  ' + l));
  console.log('');
  console.log(c.bold(`【私聊 ${privateKey} 会收到】`) + c.dim(`  ${p.length} 字符`));
  p.trimEnd().split('\n').forEach((l) => console.log('  ' + l));

  // ── 结论 ──
  title('⑤ 结果');
  const groupHasPrivate = g.includes('【私聊】');
  const privateHasPrivate = p.includes('【私聊】');
  console.log(`  群聊拿到 [私聊] 分区：${groupHasPrivate ? c.yellow('是（不该发生）') : c.green('否 ✓')}`);
  console.log(`  私聊拿到 [私聊] 分区：${privateHasPrivate ? c.green('是 ✓') : c.yellow('否（不该发生）')}`);
  console.log(`  私聊比群聊多 ${p.length - g.length} 字符`);
  console.log('');
  console.log(c.dim('  这就是「分区注入」的核心：群聊不是被要求别说私事，'));
  console.log(c.dim('  而是私事根本没进它的上下文。'));

  if (KEEP) {
    console.log('');
    console.log(c.dim(`  已保留目录：${base}`));
    console.log(c.dim('  可以自己翻 diary/ memory-bank/ short-memory.md review-due.md'));
  } else {
    fs.rmSync(base, { recursive: true, force: true });
    console.log('');
    console.log(c.dim('  临时目录已清理（加 --keep 可保留）'));
  }
  console.log('');
}

main();
