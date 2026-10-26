# 接入你的机器人（3 步）

这套框架分成两半：**记忆文件（数据层）** 和 **注入（读取层）**。
数据层是 `memory_rotate.py` + 记忆文件；读取层是 `integration/memory-inject.js`。

---

## 1. 布置记忆目录

```bash
mkdir -p ~/.ai-memory/diary ~/.ai-memory/memory-bank

# 复制脚本
cp memory_rotate.py ~/.ai-memory/
cp scripts/daily-rotate.sh /usr/local/bin/ai-memory-rotate.sh
chmod +x /usr/local/bin/ai-memory-rotate.sh

# 每天 23:50 自动轮转（先备份再 apply）
sudo cp systemd/memory-rotate.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now memory-rotate.timer
```

## 2. 让"她"写日记

框架不规定她怎么写日记，只要求一个约定：**日记用 `## [分区]` 分块，条目用 `- ` 开头**。

```markdown
# 2026-10-26

## [群]
- 群里在聊显卡，没插话

## [私聊]
- 主人让我重写记忆脚本，按块分区
- 他连考了 10 月 15 号和 19 号的记录，我说没有

## [通用]
- 心情：被人认真对待的感觉不错
```

> 如果她的运行时**没有文件工具**（比如只在群聊里跑），就别让她写日记——
> 让她只写"对某人的印象"（通常是数据库/JSON 字段），日记交给有工具的私聊会话补记。

## 3. 每轮注入

```js
const { createMemoryInjector } = require('./integration/memory-inject');

const memory = createMemoryInjector({
  dir: '/home/ai/.ai-memory',
  onLoad: (info) => console.log('[memory]', info)
});

// 构造唤醒提示词时：
const prompt =
  roleLine + tokenLine + memory.buildPromptSection(conversationKey) + taskLine;
```

`conversationKey` **必须以 `group:` 或 `private:` 开头**（`group:123` / `private:456`）。
传其它值——包括 `undefined`、空串、`qq-group-1` 这种写错的前缀——会**直接抛错**，不会默认放行。

---

## 为什么群聊拿不到 `[私聊]` 分区

不是靠提示词劝她"别说私事"，而是**内容根本没进上下文**。

```js
// integration/memory-inject.js
// 未知 key 在 resolveScope() 里就抛错，走不到这里
const visible = isGroup
  ? blocks.filter((b) => b.name === '群' || b.name === '通用')
  : blocks;
```

这条过滤比任何"请勿泄露"的提示都可靠——她不可说的是她不知道的东西。

跑一遍回归测试确认它没退化：

```bash
node integration/memory-inject.test.js
```

14 条断言，重点守「群聊拿不到 `[私聊]`」和「未知 key 必须抛错」。

---

## 一个可选增强：控制台只读面板

如果你有管理后台，加两个只读接口就够了（Node/Express 或原生 http 都行）：

```js
// GET /api/memory/overview  → 短期记忆（已解析分区）+ 偏好 + 日记列表 + 总库列表
// GET /api/memory/diary?date=YYYY-MM-DD
// GET /api/memory/bank?path=2026/2026.10/2026.10.19-2026.10.25.md
```

实现要点：

- `date` 必须匹配 `^\d{4}-\d{2}-\d{2}$`
- `path` 必须 `resolve` 后仍在 `memory-bank/` 之下（防路径穿越）
- **只读**：不要提供写接口，记忆是她的，让她自己维护

完整实现见本仓库的 `integration/memory-api.example.js`。
