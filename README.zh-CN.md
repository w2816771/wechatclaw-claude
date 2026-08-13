# wechatclaw-claude

[English](README.md) · **中文**

**一句话:** 让你能像发微信一样,给自己电脑上的 [Claude Code](https://code.claude.com) 发消息,
它帮你干活(改代码、读文件等),结果再发回给你。

```
   你发消息  ──►  wechatclaw-claude  ──►  电脑上的 Claude  ──►  你的文件
```

- **不花额外的钱。** 用你**已经买的 Claude 会员**,不是那种按字数收费的 API。
- **东西都在你自己电脑上。** 不上传到任何服务器,文件也不出你的机器。

## 现在能用到什么程度

**v0.1,能跑,但还简陋。**

- ✅ **在电脑终端(黑框框)里直接跟 Claude 打字聊天** —— 现在就能用。
- ✅ **一个 OpenAI 兼容接口(`serve`)** —— 现在就能用,已测通。
- 🚧 **微信** —— 通过 OpenClaw 接那个接口来跑,见下面[「微信怎么接」](#微信怎么接)。

## 怎么用

先决条件:装了 Node 22 以上,而且 Claude Code 已经登录好(`claude auth`)。

```bash
npm install       # 装依赖
npm run build     # 编译
node dist/cli.js init     # 第一次:回答几个问题(见下)
node dist/cli.js start    # 启动,然后就能打字聊天了
```

`init` 会问你几个**必须你自己决定、软件不敢替你猜**的事:

- **让 Claude 碰哪个文件夹?** —— 它只能读写你指定的这个目录,别的碰不到。
- **谁能给它发消息?** —— 默认谁都不理,你得先把自己加进白名单。
- **给它多大权限?** —— 默认「能改你那个文件夹里的文件」;想只读、或者想给它完全权限
  (包括跑命令),都得你手动选,选完全权限还要重打一遍路径确认,防手滑。

答完存成一个配置文件,以后想改直接改那个文件就行,升级也不会再问你一遍。

启动后你会看到 `you ›`,打字回车,Claude 的回复会一段段冒出来,前面标着 `claude ›`。

## 微信怎么接

微信这块走 [OpenClaw](https://github.com/openclaw/openclaw)——一个本地网关,由它管
聊天渠道,我们这个项目当它背后的**"模型"**。OpenClaw 用腾讯**官方**微信插件收发消息
(在微信里:我 → 设置 → 插件 → ClawBot,OAuth 扫码,不逆向、不封号);每来一条消息,
它就调我们的 OpenAI 兼容接口,我们用你的订阅版 Claude 跑一遍再把回复流式发回去。

```
微信 ──► OpenClaw(官方微信插件)──► wechatclaw-claude serve ──► Claude Code
```

同一个 `serve` 接口对任何 OpenAI 兼容的前端都能用,所以 OpenClaw 支持的另外 30 多个
渠道(Telegram、Slack…)也顺带能用上你订阅版的 Claude。

**怎么搭:**

```bash
# 1. 启动模型接口(本项目)—— 已测通
node dist/cli.js serve                    # → http://127.0.0.1:8760/v1

# 2. 装 OpenClaw + 官方微信插件,然后手机扫码
npm install -g openclaw
openclaw onboard --install-daemon
npx -y @tencent-weixin/openclaw-weixin-cli install
openclaw channels login --channel openclaw-weixin

# 3. 把 OpenClaw 的模型提供方指向上面那个接口(OpenAI 兼容)。
#    具体配置字段名请对照你装的 OpenClaw 版本的模型文档确认。
```

第 1 步我已经端到端测通(流式 + 多轮)。第 2、3 步在你机器上跑——扫码得你自己来,
OpenClaw 那边配置字段也请对着你装的版本确认一下。

> 说明:OpenClaw 是把每条渠道消息路由给一个模型的网关,所以对接点是这个 OpenAI 接口,
> **不是** `ChannelAdapter`。[`src/channel/wechat.ts`](src/channel/wechat.ts) 只是留作
> 一个"直连微信适配器"的桩,不是推荐路线。

## 安全上做了什么

- **只在你自己电脑上跑**,不对外开任何网络端口,别人从网上碰不到。
- **陌生人发消息默认不理**,只有你加进白名单的人能用。
- **只能碰你指定的文件夹**,想越界访问别的目录会被拦下来。
- **密码、密钥这类东西从环境变量读,绝不写进配置文件。**

## 慢/卡是怎么回事

- **`serve` 启动后的第一条消息**要付 Claude Code 的冷启动(钩子、插件同步、CLAUDE.md
  扫描)。`serve` 启动时会预热一个进程,所以只要你第一条消息在它启动完(约 6 秒)之后
  再发,就能跳过冷启动(这台机器上 ~7s → ~4-5s)。想关掉:设环境变量 `WCC_NO_PREWARM=1`。
- **之后每条消息**的耗时就是模型自己的响应时间(`sonnet` 约 3-4 秒)。这个是模型决定的,
  不是本项目的锅——想更快,把配置里的 `model` 换成 `haiku`(会快不少,但没那么聪明)。
- HTTP 服务和本地网络本身几乎不耗时(几毫秒)。

## 给开发者

它是驱动 `claude` 命令行工具跑的(不是 Agent SDK),因为命令行走的是你的**会员订阅**,
而 SDK 会强制按 API 收费 —— 对个人用户不划算。整体是两个接口撑起来的(agent 后端 +
聊天渠道),互不依赖,加新平台不用动别处。细节和取舍见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)(英文)。

```
src/
  agent/    跟 Claude 打交道的后端(给每个会话常驻一个进程,省启动时间)
  channel/  聊天渠道(终端能用,微信是桩)
  server/   OpenAI 兼容接口(给 OpenClaw 等用)
  config.ts 配置、校验、文件夹越界检查
  bridge.ts 把消息在渠道和 agent 之间来回转
  cli.ts    init 向导 + start 启动 + serve
```

```bash
npm run typecheck   # 类型检查
npm test            # 24 个测试
npm run dev         # 不编译,直接从源码跑
```

## 致谢与参考

本项目参考了 [XavierJiezou/codex-weixin](https://github.com/XavierJiezou/codex-weixin)
(MIT 许可)—— 一个把个人微信接到本地 Codex 的项目。整个「把聊天账号接到本地 agent」
的思路来自它,`agent/claude-code.ts` 里有几处关键逻辑是照着它改的:

- **怎么找到并启动命令行工具** —— Windows 上优先用原生 exe、退回 `.cmd`(得经 `cmd.exe`)、
  `.js` 用 node 跑。改自它的 `resolveCodexCommand`。
- **解析 stream-json 输出** —— 一行行读 JSON,抽出正文和会话 id。改自它的
  `parseCodexExecOutput`。
- **常驻进程的通信方式** —— 用 stdin 喂消息、从 stdout 读回复,以及 `windowsHide`
  隐藏窗口、整体驱动命令行的做法。

改了什么:这里把它做成常驻进程**池**(启动一次、多轮复用),再把这些细节全部藏到
`AgentBackend` 接口后面,让 agent 和聊天渠道彻底分开。**微信那部分没有照抄它** —— 走
的是 OpenClaw 官方渠道(见[「微信怎么接」](#微信怎么接))。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。随便用。
