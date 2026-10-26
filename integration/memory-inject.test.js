#!/usr/bin/env node
/**
 * memory-inject 的回归测试（零依赖，node 直接跑）。
 *
 *   node integration/memory-inject.test.js
 *
 * 重点测两件事：
 *   1. 群聊**拿不到** [私聊] 分区（结构性隔离）
 *   2. 未知/缺失的 key **必须抛错**，不能默认放行（fail-closed）
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMemoryInjector } = require('./memory-inject.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${error.message}`);
  }
}

// ── 造一个临时记忆目录 ────────────────────────────────────────
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-inject-test-'));
fs.writeFileSync(
  path.join(base, 'short-memory.md'),
  `# 短期记忆（最近 7 天）

## [群]
- 群里在聊显卡
- 群友提到周末聚会

## [私聊]
- 私聊秘密：他在准备一个惊喜
- 私聊秘密：服务器密码别外传

## [通用]
- 心情：还不错
`,
  'utf8'
);
fs.writeFileSync(
  path.join(base, 'preferences.md'),
  `# 偏好库

## 喜欢
- 把东西真跑通

## 讨厌
- 废话

## 立场
- 推荐先反问
`,
  'utf8'
);

const mem = createMemoryInjector({ dir: base });
const groupText = mem.buildPromptSection('group:123456');
const privateText = mem.buildPromptSection('private:654321');

console.log('\n[1] 分区隔离');

test('群聊包含 [群] 分区内容', () => {
  assert.ok(groupText.includes('群里在聊显卡'), '群聊应该看到群内容');
});

test('群聊包含 [通用] 分区内容', () => {
  assert.ok(groupText.includes('心情：还不错'), '群聊应该看到通用内容');
});

test('群聊**不包含** [私聊] 分区标签', () => {
  assert.ok(!groupText.includes('【私聊】'), '群聊不该出现【私聊】标签');
});

test('群聊**不包含**任何私聊内容（关键）', () => {
  assert.ok(!groupText.includes('私聊秘密'), '群聊泄漏了私聊内容');
});

test('私聊包含全部分区', () => {
  assert.ok(privateText.includes('【群】'), '私聊应该看到群分区');
  assert.ok(privateText.includes('【私聊】'), '私聊应该看到私聊分区');
  assert.ok(privateText.includes('私聊秘密'), '私聊应该看到私聊内容');
});

test('私聊比群聊长', () => {
  assert.ok(privateText.length > groupText.length, '私聊应包含更多内容');
});

console.log('\n[2] fail-closed（未知 key 必须拒绝）');

test('undefined 抛错', () => {
  assert.throws(() => mem.buildPromptSection(undefined), /无法识别的会话 key/);
});

test('null 抛错', () => {
  assert.throws(() => mem.buildPromptSection(null), /无法识别的会话 key/);
});

test('空字符串抛错', () => {
  assert.throws(() => mem.buildPromptSection(''), /无法识别的会话 key/);
});

test('无法识别的格式抛错（qq-group-123）', () => {
  assert.throws(() => mem.buildPromptSection('qq-group-123'), /无法识别的会话 key/);
});

test('只写 group 不带冒号也抛错', () => {
  assert.throws(() => mem.buildPromptSection('group'), /无法识别的会话 key/);
});

test('抛错信息里含原始 key，便于排查', () => {
  assert.throws(() => mem.buildPromptSection('qq-group-123'), /qq-group-123/);
});

console.log('\n[3] 偏好库');

test('群聊和私聊都能拿到偏好', () => {
  assert.ok(groupText.includes('把东西真跑通'), '群聊应有偏好');
  assert.ok(privateText.includes('把东西真跑通'), '私聊应有偏好');
});

test('偏好去掉了（来源：…）括号', () => {
  assert.ok(!groupText.includes('（来源'), '不应带来源括号');
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
fs.rmSync(base, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
