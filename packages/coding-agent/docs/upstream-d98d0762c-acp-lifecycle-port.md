# 代码事项：移植 prime-agent d98d0762c（ACP/daemon/session 生命周期加固）

> 目的：把上游 prime-agent 的 commit **d98d0762c**（`feat(acp): harden resident session lifecycle`，#1494）完整移植进 VSurf。
>
> 目标读者：接手这段移植的工程师。此文是「别人做」的移交说明。**直接照着「任务清单」逐项做，详细上下文/坑见下方小节。**

---

## 任务清单（按顺序做，每项单独提交，`npm run check` 绿才提交）

- [ ] **T1 agent-connection 块**（rebrand 整文件替换）
  - 文件：`src/modes/agent-connection/{types,snapshot,daemon-agent-connection,in-process-agent-connection}.ts`
  - 做法：`git show d98d0762c:<path>` 取 upstream，做 §7 品牌替换后写回。
  - 验收：`npm run check` 全绿。
  - 风险：`SessionMeta`/`AgentConnection` 新方法名（`getRlmChildSnapshots`/`acquireSessionInputPause`/`waitForHeadlessIdle`/`waitForRlmQuiescence`）会被下游 acp-mode/daemon-supervisor 引用，单独提交时可能引用未定义符号——若 T1 单独 check 不过，说明耦合强，须与 T2/T3 合并为一次「块提交」。

- [ ] **T2 acp 块**（rebrand 整文件替换）
  - 文件：`src/modes/acp/{acp-meta,acp-mode,acp-events}.ts`
  - 做法：同 T1，rebrand 替换。
  - 验收：`npm run check` 全绿。

- [ ] **T3 daemon 块**（protocol/worker-protocol rebrand 替换，supervisor/mode 人肉融合）
  - 文件：`src/modes/daemon/daemon-protocol.ts`、`daemon-worker-protocol.ts`（rebrand 替换）；`daemon-supervisor.ts`、`daemon-mode.ts`（人肉融合，见 §4.2）。
  - 关键：`daemon-supervisor.ts` 必须**保留 VSurf 的「精确 socket 路径比较 + 去掉 `normalizeSocketPath`」选择**（VSurf 修过的 Windows bug）。`DurableDaemonCreateCommand` 形状要和 agent-connection/types.ts 对齐（否则 TS 不匹配）。
  - 验收：`npm run check` 全绿。

- [ ] **T4 agent-session.ts 人肉融合**（最难，约 54 hunk / 693 行）
  - 文件：`src/core/agent-session.ts`
  - 做法：把 d98 的 ACP 生命周期框架逐段写进 VSurf 的 agent-session（input 门禁/暂停、session settlement、RLM 静止、post-compaction settlement、删除运行清理）。**必须保留 VSurf 已有的 browser / self-update / goal / Windows 代码**。
  - 注意：不能只加字段（会触发 unused-field 警告导致 check 失败），必须「字段 + 方法 + 接线」整体完成再验。
  - 验收：`npm run check` 全绿。

- [ ] **T5 core API 对齐：agent-traces.ts**
  - 文件：`src/core/agent-traces.ts`（upstream 有、VSurf 无，需新增或改写）。
  - 依赖 VSurf 已重构 API：`config.js` 的 `getAgentLogPath`、`session-manager.js` 的 `getSessionArtifactsPath`、`SettingsManager` 的 tracer 开关、`prime-inference-auth.js`。**不要覆盖 VSurf 已重构的 config/session-manager/settings-manager API**。
  - 验收：`npm run check` 全绿。

- [ ] **T6 headless-completion / daemon-ps / main**
  - 文件：`src/modes/headless-completion.ts`（rebrand 替换）、`src/main.ts`（3-way 融合）、`src/cli/daemon-ps.ts`（**保留 VSurf 版，不要照搬 upstream**——upstream import 了已删除的 `normalizeSocketPath`）。
  - 验收：`npm run check` 全绿。

- [ ] **T7 测试更新**
  - 文件：`test/acp-events.test.ts`（按 upstream 更新，新增 `activeAssistantMessageId` 等）。
  - 验收：`cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/acp-events.test.ts` 通过。**别跑全量 `npm test`**（慢且 1/3 shard 易超时）。

---

## 1. 硬性约束

- **保留 VSurf 独有的 browser 功能**：`packages/coding-agent/src/core/browser/*`、`skills/browser/*`、`vsurf-runtime`。
- **保留 VSurf 修过的 Windows 相关 bug**：重点是 `daemon-supervisor.ts` 里「精确 socket 路径比较 + 去掉 `normalizeSocketPath`」的选择、Windows 冷启动/进程风暴修复。
- upstream 把 `Vsurf*` 品牌改回 `PrimeAgent*`，**VSurf 必须保留 `vsurf` 品牌**——移植时按下述规则改回来。

## 2. 前置上下文

- VSurf 是 prime-agent 的 fork + rebrand，git 历史是一次 squash 导入，与 upstream **无共享历史**，**不能 `git merge`/`rebase`**，只能按文件比对移植。
- 本地已加 upstream remote（`git@github.com:PrimeIntellect-ai/prime-agent.git`），`upstream/main` = v0.8.1（bc0fa7606）。取文件用 `git show d98d0762c:<path>`。
- 相关 branch：`feat/upstream-0.8-deep-refactors`（基于 v0.7.7 main）。已完成：`session_before_refine`（#1558）。目标基线：`0.7.7`。

## 3. d98d0762c 是干什么的

不是给终端用户的新 UI，而是让 ACP（IDE 客户端协议）在长任务/子代理/自主续跑下可靠：

- **ACP 更新关联/排序**：新增 `SessionMeta`（`promptTurnId` / `eventSequence` / `phase`），客户端知道每条更新属于哪个 prompt、顺序、是否重复。
- **终端 quiescence**：`QuiescenceMeta`（`outstandingSubagents` / `remainingAutonomousContinuations`），客户端据此确认「turn 真正结束（所有子代理静止）」，而不是父代理一结束就宣布完成。
- **输入暂停/门禁（daemon）**：turn 在 settle/abort/pause 时会话「暂停接收输入」，防止 follow-up prompt 与上一轮清理重叠、会话挂死。
- **会话结算所有权**：resident 会话正确拥有终态；follow-up 会 await 上一轮 settlement。

它是 `02e217e6a`（应答 ACP prompt 时机）、`ab3db326d`（post-compaction 续跑拒绝）、`a9b5d88b5`（ACP 静止/推理血缘）、`e51d2266c`（RLM 静止 goal 续跑）的地基。

## 4. 涉及文件（34 个）

### 4.1 可「rebrand 后整文件替换」（VSurf delta 小，基本只是品牌差异）

用 `git show d98d0762c:<path>` 取 upstream 版本，做 §7 品牌替换后写回：

- `src/modes/agent-connection/types.ts`
- `src/modes/agent-connection/snapshot.ts`
- `src/modes/agent-connection/daemon-agent-connection.ts`
- `src/modes/agent-connection/in-process-agent-connection.ts`
- `src/modes/acp/acp-meta.ts`
- `src/modes/acp/acp-mode.ts`
- `src/modes/acp/acp-events.ts`
- `src/modes/daemon/daemon-protocol.ts`
- `src/modes/daemon/daemon-worker-protocol.ts`
- `src/modes/headless-completion.ts`
- `src/core/agent-session-config.ts`

注意：`src/cli/daemon-ps.ts` **不要照搬**——upstream import 了 `normalizeSocketPath`，而 VSurf 已去掉该导出；保留 VSurf 自己的 `daemon-ps.ts`。

### 4.2 需「3-way 人工融合」（VSurf 有大的/竞争性改动）

- `src/core/agent-session.ts`（upstream +693 行；VSurf 已偏离 upstream pre-d98 约 744 行，含 browser/self-update/goal 等）
- `src/modes/daemon/daemon-supervisor.ts`（VSurf delta 仅 37 行，但含「精确路径比较 + 去 normalizeSocketPath」选择，需保留）
- `src/modes/daemon/daemon-mode.ts`（VSurf delta 大：288/471）
- `src/main.ts`（VSurf delta 14/21）

### 4.3 连带新增（upstream 有、VSurf 缺）

- `src/core/agent-traces.ts`（upstream 文件，VSurf 没有）。依赖 VSurf 已重构核心 API：config.js 的 `getAgentLogPath`、session-manager.js 的 `getSessionArtifactsPath`、SettingsManager 的 tracer 开关、`prime-inference-auth.js`。**需先对齐 VSurf 对应 API，或改写 agent-traces.ts 用 VSurf 的 API。**
- `test/acp-events.test.ts` 需按 upstream 更新（新增 `activeAssistantMessageId` 等）。

## 5. 关键坑（已实测）

1. **自动 merge 全部失败**：`git apply --3way` 在 agent-session.ts line 172、daemon-supervisor.ts line 22 都 `patch does not apply`；`git merge-file`（base/ours/theirs）对 agent-session.ts 返回「ours 原样」；`git apply --reject` 全 reject。
2. **不能增量提交**：只加 d98 字段会触发 `unused field` 警告 → `npm run check`（`--error-on-warnings`）失败。必须「字段 + 方法 + 接线」作为一整块写完、验证再提交。
3. **耦合**：`SessionMeta`/`AgentConnection` 改动（`getRlmChildSnapshots`、`acquireSessionInputPause`、`waitForHeadlessIdle`、`waitForRlmQuiescence`、`DurableDaemonCreateCommand` 形状）需 types.ts + daemon-agent-connection + in-process-agent-connection + acp-mode + daemon-supervisor 一起改，单独改任何一处编译不过。
4. **品牌反转**：upstream `Vsurf*` → `PrimeAgent*`，VSurf 需改回 `vsurf`。

## 6. rebrand 替换规则

```js
s.replace(/@earendil-works\/pi-agent-core/g,'vsurf-agent')
 .replace(/@earendil-works\/pi-ai/g,'vsurf-ai')
 .replace(/@earendil-works\/pi-tui/g,'vsurf-tui')
 .replace(/@earendil-works\/pi-coding-agent/g,'vsurf')
 .replace(/PRIME_AGENT/g,'VSURF')
 .replace(/Prime Agent/g,'VSurf')
 .replace(/prime-agent/g,'vsurf')
 .replace(/PrimeAgent/g,'Vsurf')
 .replace(/primeAgent/g,'vsurf');
```

## 7. 验证

- 每个协调块：`npm run check`（biome + tsgo --noEmit + check:browser-smoke）必须全绿。
- 涉及 kernel/ACP/daemon 的块：跑相关测试，例如 `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/acp-events.test.ts`。**别跑全量 `npm test`**（慢且 1/3 shard 易超时）。
- 提交前 `git status`，只 `git add` 本块文件，别带上别的改动。

## 8. 后续（依赖本块的 commit，可之后再做）

- `02e217e6a`（应答 ACP prompt 时机）
- `ab3db326d`（post-compaction 续跑拒绝）
- `a9b5d88b5`（ACP 静止/推理血缘）
- `e51d2266c`（RLM 静止 goal 续跑）
- MCP breaking 组：`f8f02221e` / `bb61ca21c` / `a3d86fbe5` / `c75a637b0` / `8c749fb98`
- `274cbb84f`（refinement 状态卡片）、`addfc23ff`（kernel fork-server 随 owner 退出）

## 9. 已实测结论

在本分支实测：把 §4.1 的 11 个文件 rebrand 替换 + agent-session 换成 upstream-post-d98 后，`tsgo` 报错只剩：
- agent-traces.ts 缺失（及其依赖的 VSurf 核心 API）
- daemon-supervisor.ts 的 `DurableDaemonCreateCommand` 形状不匹配（需人肉融合）
- acp-events.test.ts 需更新
- `normalizeSocketPath` 不存在（daemon-ps 保留 VSurf 版即可）

即：除 agent-session / daemon-supervisor / daemon-mode / main / agent-traces 这几块，其余基本是「rebrand 替换 + 接口就位」就能过。主要工作量在 §4.2 与 §4.3。
