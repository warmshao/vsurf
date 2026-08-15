<p align="center">
  <img alt="vsurf" src="assets/brand/vsurf-logo.svg" width="220" style="max-width: 100%;">
</p>

<h3 align="center">
vsurf：浏览器优先的 RLM 智能体
</h3>

<p align="center">
  <a href="packages/coding-agent/docs/index.md">文档</a> | <a href="README.md">English</a>
</p>

vsurf 是一个开源的编码与研究智能体，面向通用任务和长时间运行的工作，内置一流的浏览器自动化能力。每个 RLM 智能体在同一个共享浏览器中拥有自己的标签页，多个智能体可以并行工作——各自只能看到自己的标签页。

它的设计围绕两个核心抽象：

- **递归语言模型（Recursive Language Model，RLM）**：将上下文视为变量（*prompt-as-a-variable*），将递归子智能体等工具视为函数调用（*programmatic sub-agent calling*），运行在一个持久化的 REPL 中。
- **持续演进 Harness（Continual Harness）**：将补充提示词、记忆、技能描述和可复用的子智能体规格存储为持久状态，vsurf 可以通过小步、有证据支撑的更新对其进行改进，默认仅在会话内生效。

## 浏览器原生智能体

vsurf 在 RLM 智能体模型之上扩展了一个共享的真实浏览器（你自己的 Chrome/Edge，或托管的 Chromium），通过单一 CDP 连接工作：

- **一个浏览器，多个智能体。** 所有智能体共享同一个浏览器实例；每个智能体被分配自己的标签页，永远看不到其他智能体的标签页。
- **并行浏览。** 多个智能体可以同时浏览网页、填写表单、抓取数据和测试页面，各自在自己的标签页中工作，没有窗口泛滥或配置文件冲突。
- **截图优先。** 视觉模型通过截图加坐标点击来操作，可以穿透 iframe 和 shadow DOM；纯文本模型则回退到 DOM 快照加索引点击。
- **安全接管你的浏览器。** 智能体可以接管你已经打开的标签页；被接管的标签页只会被释放，永远不会被关闭。智能体自己创建的标签页会在会话结束时自动关闭。

## 快速开始

要求 Node.js >= 22.8.0。使用浏览器模块需要本地安装 Chrome、Edge 或 Chromium。

从 npm 安装 `vsurf` 命令：

```bash
npm install -g @warmshao/vsurf
```

然后在希望 vsurf 工作的仓库或目录中启动它：

```bash
cd /path/to/project
vsurf
```

首次启动时，运行 `/login` 选择订阅或 API Key 提供商。vsurf 会在当前目录中工作，可以在其中运行命令和修改文件。建议使用一次性克隆、干净的 worktree 或其他可检查、可恢复的备份点。

### 从源码构建

```bash
git clone https://github.com/warmshao/vsurf.git
cd vsurf
npm install
npm run build
npm install -g .
```

不想全局安装，也可以直接从检出目录运行：

```bash
./vsurf.sh
```

> [!WARNING]
> vsurf 会以你的用户权限执行模型生成的 Python 代码、浏览器操作和项目命令。其 worker 和 kernel 进程提升了生命周期隔离和故障恢复能力，但它们**不是**安全沙箱。请审查变更，并只使用可信的仓库、指令、技能和扩展。不受信任的代码或指令请在外部沙箱或受限环境中运行。

常用命令：

```bash
vsurf agents                   # 浏览运行中、空闲和已保存的会话
vsurf attach <agent>           # 重新接入一个正在运行的会话
vsurf --resume [path|id]       # 浏览会话或直接恢复某个会话
vsurf status                   # 查看后台服务状态
vsurf doctor [--fix]           # 检查或修复安装
vsurf shutdown                 # 停止智能体、worker 和后台服务
```

## 为长时间运行的工作而生

vsurf 专为长时间运行的工作打造，尤其适合并行浏览器智能体场景。以下功能在 TUI 和自治模式中均可使用：

- **持久化 IPython 控制环境：** 文件操作、shell 命令、工具调用、子智能体和上下文管理全部通过代码完成。
- **内置子智能体：** 派生真正的子智能体处理并行或后台工作，并以编程方式获取结果。
- **持续演进 Harness：** `/refine` 将聚焦、可审查的经验教训持久化为补充提示词、记忆、技能或子智能体规格，带有历史记录和回滚能力。
- **可执行技能：** 技能是可导入的 Python 包；内置的技能创建器可以把重复出现的工作流转化为项目级或个人技能。
- **守护进程支持的连续性：** 终端断开后，活动会话、IPython 状态、定时任务和子智能体会继续运行，之后可以重新接入。
- **智能体间直接通信：** 运行中的智能体和保留的子智能体可以互相发现、交换消息并引导正在进行的工作。
- **心跳、定时任务和目标：** `/heartbeat`、`rlm_heartbeat` 和 `vsurf schedule` 定期重新进入会话；`/goal` 让目标跨多轮保持活跃。
- **有边界的自治模式：** `/autonomous` 在配置的轮次、token 和时间预算内持续运行，并可执行用户自定义的质量门禁。

## 文档

- [快速上手](packages/coding-agent/docs/quickstart.md) —— 安装、认证并运行第一个会话
- [使用与 CLI 参考](packages/coding-agent/docs/usage.md) —— 命令、会话、自治限制和输出模式
- [长时间运行与后台智能体](packages/coding-agent/docs/long-running-agents.md) —— 断开与重新接入、目标、心跳和定时任务
- [RLM 编程模型](packages/coding-agent/docs/rlm.md) —— 持久化 IPython、子智能体、技能和信任模型
- [RLM 运行时](packages/coding-agent/docs/rlm-runtime.md) —— 共享浏览器、每智能体标签页和 Python 运行时
- [浏览器](packages/coding-agent/docs/browser.md) —— 共享浏览器守护进程：CDP 连接、标签页所有权和托管启动
- [JSON 模式](packages/coding-agent/docs/json.md) 和 [RPC 模式](packages/coding-agent/docs/rpc.md) —— 无头自动化与集成
- [技能](packages/coding-agent/docs/skills.md) —— 安装和创建可复用能力
- [提供商配置](packages/coding-agent/docs/providers.md) —— 订阅与 API Key 提供商
- [架构概览](packages/coding-agent/docs/architecture.md) —— 守护进程、worker、kernel 和持久化边界
- [开发](packages/coding-agent/docs/development.md) —— 从源码构建和运行

## 参与贡献

有问题、bug 报告和功能建议，请在 [warmshao/vsurf](https://github.com/warmshao/vsurf) 提交 GitHub issue 或 discussion。完整流程请阅读[贡献指南](CONTRIBUTING.md)。

## 致谢

vsurf 基于 [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) 构建，而 Prime Agent 本身基于 [`pi`](https://github.com/badlogic/pi-mono)。感谢它们的作者做出的宝贵工作。

## 许可证

MIT
