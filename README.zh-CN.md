# wechatclaw-claude

[English](README.md) · **中文**

从聊天应用与运行在你自己电脑上的 [Claude Code](https://code.claude.com) 对话 ——
用你**已有的 Claude Code 订阅**,而不是按量计费的 API 账单。

```
   你的聊天应用  ──►  wechatclaw-claude  ──►  Claude Code  ──►  你的文件
                       (本地回环)              (你的登录)
```

不托管在任何地方。服务只绑定本地回环,文件留在你自己机器上,跑的是你已经登录好的
Claude Code 账号。

## 状态

**v0.1 —— 可运行的核心。** agent 后端、桥接层、配置、安装向导,以及一个**终端渠道**
现在都能用,并有测试覆盖。**微信渠道是桩** —— 见
[为什么微信是桩](#为什么微信是桩)。

## 快速开始

需要 Node ≥ 22,以及已安装并登录的 Claude Code(`claude auth`)。

```bash
npm install
npm run build
node dist/cli.js init     # 设置工作目录、白名单、权限
node dist/cli.js start    # 然后在提示符处输入
```

`init` 会带你过一遍**没有安全默认值**的选择 —— agent 能碰哪个目录、谁能给它发消息 ——
并写出一份你可以手改的配置。升级时它不会重新问。

用终端渠道 `start` 后,你会看到 `you ›` 提示符;回复会以 `claude ›` 流式返回。这就是
整条链路 —— 渠道 → 桥接 → agent → 返回 —— 端到端跑通,不需要任何外部账号。

## 它是怎么搭的

它驱动 `claude` CLI(`-p`),**而不是** Agent SDK —— 这是刻意的:CLI 跑在你的**订阅**上,
而 SDK 会逼每个用户走按量计费的 **API**。这个工具是给已经付了订阅的个人用户的。见
[ARCHITECTURE §2](docs/ARCHITECTURE.md#2-the-core-decision-subprocess-deliberately)。

两个接口撑起整个系统,所以加一个新聊天平台、或将来换一个走 API key 的后端,都不用动
其它任何地方:

- **`AgentBackend`** —— 一个 agent 运行时。不懂聊天平台。发布的这个实现给每个会话
  常驻一个 `claude` 进程(冷启动一轮约 4s,热的约 250ms)。
- **`ChannelAdapter`** —— 一个消息平台。不懂 agent。

```
src/
  agent/        AgentBackend 接口 + claude-code 常驻进程池后端
  channel/      ChannelAdapter 接口 + 终端渠道 + 微信桩
  config.ts     配置 schema、校验、工作目录遏制检查
  bridge.ts     路由、访问控制、自适应流式回复
  cli.ts        init 向导 + start
```

## 设计原则

1. **计费模型决定机制。** CLI 子进程蹭订阅;SDK 按 token 收费。用户是个人,所以:
   子进程。
2. **子进程被封装,绝不外露。** 只有一个后端知道进程、PID、会话文件。桥接层只看到事件。
3. **权限是策略,不是开关。** 默认 `acceptEdits`(可编辑工作目录内的文件);只读 `plan`
   和完全访问 `bypassPermissions` 都要显式选,后者在向导里还要重打一遍路径确认。
4. **核心与渠道无关。** 任何平台的词汇都不出现在共享签名里。

## 为什么微信是桩

自动化个人微信号意味着驱动逆向的、无文档的端点,并且违反腾讯的服务条款 —— 可能导致
账号被封。这部分集成应由使用者自己在自己的账号、自担风险地提供;本项目不打包、也不
重新分发它。[`src/channel/wechat.ts`](src/channel/wechat.ts) 是要实现的接口;
`ChannelAdapter` 之上的一切都已跑通,并由终端渠道验证。

## 安全

- 绑定本地回环;不开放任何入站网络端口。
- 发送者白名单默认拒绝 —— 未知发送者一律拒。
- 工作目录路径在桥接层做遏制检查,独立于 agent 自身的沙箱。
- 密钥从环境变量读取,绝不写进配置文件。

## 开发

```bash
npm run typecheck
npm test          # 18 个测试:后端、流式、常驻池、配置
npm run dev       # 用 tsx 从源码直接跑 CLI
```

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
