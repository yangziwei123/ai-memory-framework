# AI 长期记忆框架（三层 + 分区注入）

> **Layered memory framework for long-running AI personas.** Three layers — short-term summary,
> raw daily diary, long-term archive — plus **partition-based injection**: a group-chat session
> structurally cannot see the `[私聊]` (DM) partition, because that content never enters its context.
> No vector DB, no dependencies: plain Markdown files, one Python script, ~60 lines of injection code.
>
> Zero-setup demo: `node demo/run.js`

给长期在线的 AI 人格（陪伴型 bot、群聊角色）用的**记忆框架**：
让"她"记得住过去，同时**不让记忆无限膨胀、也不让私聊内容漏到群里**。

不是记忆库服务，是**一套文件约定 + 三个小脚本 + 一段注入代码**，可以直接抄进你自己的 bot。

```text
                  ┌─────────────────────────────┐
  每轮注入 ◄────── │  short-memory.md（≤ 1KB）    │ ◄── 每天 23:50 重建
                  └─────────────▲───────────────┘
                                │ 按分区聚合
                  ┌─────────────┴───────────────┐
  原料 ──────────► │  diary/YYYY-MM-DD.md（7 天） │ ── 超期 ──► memory-bank/（按天留块）
                  └─────────────────────────────┘
                  ┌─────────────────────────────┐
  倾向 ──────────► │  preferences.md（喜欢/讨厌/立场）│ ◄── 从日记抽候选，人工确认
                  └─────────────────────────────┘
```

---

## 跑起来是什么样

不用配置任何东西，clone 下来就能看：

```bash
node demo/run.js
```

节选（① ② ③ ⑤ 段是实际输出；④ 段是**手工整理的对比摘要**，程序打印的是完整提示词原文）：

```text
记忆框架 demo
  日记:     4 篇（其中 1 篇已过期）

① 预演（不加 --apply：只重建短期记忆，不动日记）
  将归档: 2026-10-16.md
  已重建 short-memory.md（281 字）
  ✓ 预演后 diary/ 仍有 4 篇（过期那篇没被移动）

② 真正轮转（--apply：过期日记归档进长期总库）
  归档: 2026-10-16.md
  已写入 2026.10.12-2026.10.18.md：1 天
  ✓ diary/ 剩下 3 篇
  ✓ archive/ 归档 1 篇：2026-10-16.md
  ✓ memory-bank/ 生成 1 个文件：2026/2026.10/2026.10.12-2026.10.18.md

③ 生成的 short-memory.md（每轮注入的就是它）
  # 短期记忆（最近 7 天）

  ## [群]
  - 群里在聊显卡和加班费，没插话
  - 有人 @ 我问配置单，说了两句
  - 群友提到周末聚会，时间还没定
  - 群里在讨论一个新出的模型，我没接话

  ## [私聊]
  - 他让我把记忆改成按块分区，别按日期
  - 连考了两天的记录，我说没有；他提醒我日期要能对上
  - （……共 5 条）

  ## [通用]
  - 心情：被认真对待的感觉不错
  - 教训：别拿"印象"当事实依据
  - 喜欢把东西真跑通的那一刻

④ 注入对比：群聊 vs 私聊

  【群聊 group:123456789 会收到】              249 字符
    【群】     ← 有
    【通用】   ← 有
    【私聊】   ← 没有

  【私聊 private:987654321 会收到】            367 字符
    【群】 【私聊】 【通用】  ← 全都有

⑤ 结果
  群聊拿到 [私聊] 分区：否 ✓
  私聊拿到 [私聊] 分区：是 ✓
  私聊比群聊多 118 字符

  这就是「分区注入」的核心：群聊不是被要求别说私事，
  而是私事根本没进它的上下文。
```

---

## 为什么需要它

陪伴型 AI 的"活人味"取决于三件事：**记得住**、**有偏好**、**分得清场合**。
但直接把这些塞进提示词会撞上三个坑：

| 坑 | 现象 | 本框架的对策 |
| --- | --- | --- |
| **记忆只增不减** | 上下文越跑越大，几轮之后开始"背设定"、变僵 | 三层结构 + 每日轮转 + 各层独立限字 |
| **私聊内容漏到群里** | 群里说出只有主人知道的事 | 记忆按 `[群]/[私聊]/[通用]` **分区块**，注入时按会话**结构性过滤** |
| **分不清来源** | 把私聊记的事当成"我群里看到的" | 分区是写入时就确定的，不是事后猜的 |

> 最后一条是真实事故：她把"昨天私聊记的识图插件"当成"我在群里也能看见"的证据。
> 打标签（`[群]` 前缀）靠自觉会漏，**块**靠结构不会。

---

## 目录结构

```text
memory_rotate.py                  轮转脚本（短期记忆 / 复习队列 / 偏好候选 / 归档）
scripts/daily-rotate.sh           每日包装：先 tar 备份 → 再 apply
scripts/archive-sessions.sh       会话目录归档（防对话历史无上限增长）
systemd/                          两个 timer 单元（记忆轮转 / 会话归档）
integration/memory-inject.js      注入模块（按会话过滤分区 + mtime 缓存）
integration/memory-api.example.js 只读 HTTP 接口（做管理面板用）
integration/README.md             接入你的 bot 的三步
prompt/memory-rules.group.md      群聊提示词（记忆规则）
prompt/memory-rules.private.md    私聊提示词（日记格式）
docs/记忆规则.md                  完整设计说明（三层结构、写入标准、冲突去重）
docs/偏好机制.md                  偏好库三栏与学习回路
docs/改卡机制.md                  角色卡改动流程（防人格漂移）
examples/                         跑起来长什么样的样例
```

---

## 快速开始

先看效果（不需要配置任何东西）：

```bash
node demo/run.js
```

它会造 4 篇假日记 → 跑真正的轮转脚本 → 打印「群聊」和「私聊」各自会收到的提示词。
详细说明见 [`demo/README.md`](demo/README.md)。

然后再正式布置：

```bash
git clone <this-repo> && cd <this-repo>

# 1) 建记忆目录
mkdir -p ~/.ai-memory/diary ~/.ai-memory/memory-bank
cp memory_rotate.py ~/.ai-memory/

# 2) 写第一篇日记
cat > ~/.ai-memory/diary/$(date +%F).md <<'EOF'
# 第一篇

## [私聊]
- 今天开始记东西了
EOF

# 3) 预演轮转（不会真的归档）
cd ~/.ai-memory && python3 memory_rotate.py

# 4) 看结果
cat ~/.ai-memory/short-memory.md
cat ~/.ai-memory/review-due.md
```

装成每日任务：

```bash
sudo cp scripts/daily-rotate.sh /usr/local/bin/ai-memory-rotate.sh
sudo chmod +x /usr/local/bin/ai-memory-rotate.sh
sudo cp systemd/memory-rotate.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now memory-rotate.timer
systemctl list-timers memory-rotate.timer
```

注入到提示词：

```js
const { createMemoryInjector } = require('./integration/memory-inject');
const memory = createMemoryInjector({ dir: '/home/ai/.ai-memory' });

// 每轮组装提示词时
const prompt = roleLine + tokenLine + memory.buildPromptSection('group:123456') + taskLine;
```

完整接入说明见 [`integration/README.md`](integration/README.md)。

---

## 设计决策（都是踩坑换来的）

### 1. 短期记忆按**分区**聚合，不按日期

直觉写法是按天聚合（`## 2026-10-26`），但那样 `[群]` 和 `[私聊]` 的内容会混在同一天里，
**注入时无法过滤**。改成跨 N 天按分区聚合后，过滤只需要一个数组 filter。

### 2. 群聊拿不到 `[私聊]` 分区——是结构，不是纪律

```js
// 未知 key 在 resolveScope() 里就抛错（fail-closed），走不到这里
const visible = isGroup
  ? blocks.filter((b) => b.name === '群' || b.name === '通用')
  : blocks;
```

靠提示词写"请勿泄露私聊内容"一定会漏。让内容**根本不进上下文**，她就没有可泄露的东西。

> ⚠️ 前提是判定必须 **fail-closed**：`key` 不以 `group:` / `private:` 开头就抛错。
> 早期版本把 `startsWith('group:')` 取反当默认，于是 `undefined` / 空串 / 写错的
> `qq-group-1` 全都漏成「私聊可见」——隔离承诺当场失效。现在有
> `integration/memory-inject.test.js` 专门守着这条（14 条断言）。

### 3. 摘要必须按**字符**切，不能按行

工具返回值大多是**单行 JSON**。按"前 40 行"切片等于切了全文——实测 9745 字符压完还有 9896。
按字符切才是真的压缩。

### 4. 写入限制放在**生成层**，不放在写入时

群聊会话往往没有文件工具，它写不了文件；能写的只有私聊。
所以"群块每天 ≤200 字"这种限制只能由轮转脚本在**聚合时截断**，放到写入时校验是空的。

### 5. `--apply` 之前先备份

脚本任何模式都会重写 `short-memory.md` / `review-due.md` / `preferences.log`，
`--apply` 还会 `shutil.move` 归档日记。`daily-rotate.sh` 先打 tar 再执行——
代价是一份几百 KB 的备份，收益是任何一天都能回滚。

### 6. 归档失败就**不删任何东西**

`archive-sessions.sh` 里：tar 产物为空 → 直接退出，一个目录都不删。
会话目录名常以 `--` 开头（hash 路径），`tar` 会把它当选项——这个坑我踩过，
静默失败 + 无条件删除 = 永久丢失历史对话。

### 7. 偏好要人确认，机器只出候选

`scan_preferences()` 只往 `preferences.log` 写 `[待确认]` 条目，不直接改 `preferences.md`。
理由：机器从日记里猜出来的"偏好"会把人格带偏，而偏好比记忆更影响行为。

### 8. 不要手改短期记忆

`short-memory.md` 是**派生产物**，每天由日记重建。手改的东西第二天就没了。

---

## 验证清单

跑完这几条，框架就是活的：

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| 轮转能跑 | `python3 memory_rotate.py` | 输出「已重建 short-memory.md（N 字）」 |
| 预演不落盘 | 上一条执行后 `git status` / `ls diary` | 过期日记**仍在** `diary/` |
| 分区生效 | `grep '^## \[' ~/.ai-memory/short-memory.md` | 只出现 `[群]` `[私聊]` `[通用]` |
| 过滤生效 | `node -e "…buildPromptSection('group:1')"` | 输出里**没有** `[私聊]` 段落 |
| 定时器 | `systemctl list-timers memory-rotate.timer` | 下次 23:50 |
| 备份 | `ls ~/.ai-memory-backups` | 每次轮转一份 tar.gz |

---

## 不包含什么

- **不包含模型提示词的其余部分**（人格、说话风格、工具协议）。这里只管记忆。
- **不包含向量检索**。所有记忆都是小文本文件，靠结构和限字控制体积——
  如果你的记忆量到几十万字，再考虑 RAG。
- **不绑定任何机器人框架**。注入是纯函数，接什么读什么。

---

## License

MIT。文档 `docs/` 下的三份设计说明来自一个真实运行中的陪伴型 bot 项目，已移除昵称、账号与主机相关信息。
