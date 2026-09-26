# qqaibot

一个把 QQ 接入 AI 的机器人：通过 [SnowLuma](https://github.com/SnowLuma/SnowLuma)（OneBot v11）收发消息，
在群里被 @ 或私聊时调用大模型回复，自带一个零依赖的本地管理面板。

- **群聊**：只有 `@机器人` 才会回复；**私聊**：直接回复。
- **识图可开关**，且**聊天模型与识图模型完全独立**（可以一家 DeepSeek、一家通义千问 VL）。
- **人格可配置**：全局一份，每个群/每个人还能单独覆盖。
- **上下文可配置**：默认记录群里的**全部消息**（不只是 @ 机器人的），机器人仍然只在被 @ 时回复；
  每个会话默认保留最近 40 条，群内共享同一份上下文。
- **历史图片不烧 token**：默认 `caption` 模式，第一次见到图片时让识图模型生成文字描述，
  之后回放历史用描述代替真实图片。
- **本地管理面板**：概览 / 会话设置 / 模型与设置 / 用量统计 / 运行日志 / 在线测试。
- **开箱即用**：打包版内置 Node 运行时，目标机器无需安装任何东西，双击即可运行。

## 目录结构

```
src/
  index.ts        入口：加载配置、启动 DB / Bot / WebUI、处理退出
  config.ts       yaml + zod 配置、${ENV} 替换、缺失时自动生成
  paths.ts        以可执行文件位置为基准解析所有路径（不依赖 cwd）
  logger.ts       控制台 + 按天滚动日志（保留 N 天）
  db.ts           node:sqlite（WAL）封装：消息 / 媒体 / 会话设置 / 全局设置 / 用量
  settings.ts     三层配置合并：会话设置 > 面板全局覆盖 > config.yaml
  bot.ts          SnowLuma 连接、事件过滤、串行队列、AI 调用、回复、打标签
  normalize.ts    消息段 → 文本/图片，引用解析，@ 解析，语音转文字
  prompt.ts       构造 system + 历史 + 当前轮的消息数组（含图片预算）
  media.ts        图片下载 / 内容寻址落盘 / dataURL / 过期清理
  mentions.ts     群名片缓存（TTL）
  ai.ts           OpenAI 兼容客户端（重试 / 超时 / 用量）
  text.ts         Markdown 降级、长消息分片
  webui/server.ts 原生 node:http 路由 + 静态资源
public/           零依赖原生 HTML/CSS/JS 管理面板
test/e2e.mjs      Mock OneBot + Mock AI 的端到端测试
scripts/package.mjs 组装可双击运行的发布目录
```

## 开发

```bash
npm install
npm run typecheck
npm run build      # -> dist/bot.mjs（esbuild 单文件）
npm start          # 运行 dist/bot.mjs，WebUI 在 http://127.0.0.1:8787
npm test           # 端到端冒烟测试
npm run package    # -> release/QQAIBot（内置 node.exe + 启动器）
```

> 注意：`@snowluma/sdk` 发布版的 ESM 入口缺少 `.js` 后缀，直接 `node` 运行会报
> `ERR_MODULE_NOT_FOUND`。本项目用 esbuild 打包，在构建期就把它解析掉了。

## 配置

首次运行会从 `config.example.yaml` 生成 `config.yaml`。三种来源的优先级：

```
scope_settings（面板里的“会话设置”）
  > app_settings（面板里的“模型与设置”全局覆盖）
    > config.yaml（出厂默认）
```

面板**不会改写 yaml**，它的修改都存在 `data/bot.db` 里；删掉 `data/` 即恢复 yaml。

`config.yaml` 里字符串中的 `${VAR}` 会从 `.env` / 环境变量取值。

### 群聊上下文

默认 `context.recordAll: true`，即群里**所有**消息都会写入上下文（不只是 @ 机器人的那些），
但机器人**只在被 @ 时回复**。相关开关（面板「模型与设置 → 对话上下文」里也能改）：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `context.recordAll` | `true` | 是否记录群内全部消息作为上下文 |
| `context.recordImages` | `true` | 被动消息里的图片是否也下载保存；关掉时只记 `[图片]` 占位，省流量/磁盘 |
| `context.maxTurns` | `20` | 每个会话保留最近多少轮（1 轮 ≈ 2 条消息） |
| `context.maxContextChars` | `12000` | 上下文字符硬上限，超出从最早的消息开始丢 |
| `context.includeTimestamps` | `false` | 是否给历史消息加时间戳 |

> 记录得越多，每次请求的 token 也越多。群里很活跃时可以把 `maxTurns` 调小，
> 或者把 `recordAll` 关掉退回到「只记 @ 机器人的消息」。

### 图片怎么送给模型

默认 `historyImages.mode: latest`：图片**不转文字**，而是按发送时的原顺序
（`文字 → 图片 → 文字 → 图片…`）作为真正的 `image_url` 直接发给多模态模型。
图片只会在第一次收到时下载保存（按 sha1 去重），之后回放都复用这份文件。

| `historyImages.mode` | 行为 |
| --- | --- |
| `latest`（默认） | 历史里的真实图片按原顺序发给多模态模型；张数受 `historyImages.maxImages` 和 `vision.maxImagesPerRequest` 限制 |
| `none` | 历史图片一律显示成 `[图片]`，最省 token |
| `caption` | 首次收到时让识图模型生成文字描述，历史里用描述代替（省 token，但会多花一次识图调用） |

### 群内 @ 的表情回应

`reply.emojiReaction`（默认 `"424"`）：群里被 @ 时，先用 OneBot 的
`set_msg_emoji_like` 给那条消息贴一个表情。留空即关闭，面板「回复行为」里也能改。

## 升级（保留旧数据）

代码升级只需要替换 `app/bot.mjs` 和 `app/public/`，**不要删 `data/`**，也不要覆盖
`app/config.yaml`：

- 数据库结构只做「加表 / 加列」的向前迁移，永不删列删表；升级前会自动把旧库备份成
  `data/bot.db.bak-v<N>-<时间>`。
- `config.yaml` 里已删除的旧键（如 `context.maxMessages`）会被识别并折算成新键，
  用户手动改过的值不会被覆盖。
- 媒体文件按 sha1 存在 `data/media/`，与代码版本无关。

安全做法：先整包复制备份，再覆盖程序文件。

```powershell
Copy-Item -Recurse -Force .\QQAIBot .\QQAIBot-backup
Copy-Item -Force .\新版本\app\bot.mjs    .\QQAIBot\app\bot.mjs
Copy-Item -Recurse -Force .\新版本\app\public .\QQAIBot\app\public
```

## 数据

| 路径 | 内容 |
| --- | --- |
| `data/bot.db` | 消息、图片元数据+描述、会话设置、全局覆盖、用量 |
| `data/logs/` | 按天滚动，默认保留 7 天 |
| `data/media/` | 内容寻址（`<yyyy-MM>/<sha1>.<ext>`），默认保留 3 天 |

## 发布

`npm run package` 生成：

```
release/QQAIBot/
├─ 一键启动.bat
├─ 打开管理面板.bat
├─ 使用说明.txt
├─ runtime/node.exe      # 内置运行时
├─ app/bot.mjs           # 单文件机器人
├─ app/public/           # 管理面板
├─ app/config.yaml
└─ data/                 # 运行后生成
```

把整个 `QQAIBot` 文件夹拷给对方，双击 `一键启动.bat` 即可。
