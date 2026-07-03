# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## 项目定位

将千问网页版 (chat.qwen.ai) 逆向封装为 OpenAI/Anthropic 标准协议的多协议 API 网关。
对外暴露标准 `/v1/chat/completions` (OpenAI) 和 `/v1/messages` (Anthropic) 端点，内部通过 undici fetch 直连千问网页版 API，支持流式 SSE、工具调用 (DSML)、思考过程 (thinking)。

## 技术栈

- **Runtime**: Node.js 20+ (TypeScript → ESM, `"type": "module"`)
- **HTTP 框架**: Fastify 5 + @fastify/cors
- **日志**: pino + pino-pretty
- **浏览器管理**: chrome-launcher + chrome-remote-interface + Playwright
- **HTTP 客户端**: undici (Node 原生 fetch)

## 开发命令

```bash
npm run dev          # tsx watch 热重载开发 (唯一日常开发命令)
npm run build        # tsc 编译 → dist/
npm start            # 运行编译产物: node dist/index.js
```

`package.json` 中只有 `build`、`start`、`dev` 三个脚本。没有 `npm test`、`npm run bundle`、`npm run package`——这些是规划中的命令。

## 实际文件结构 (src/ 全扁平)

src/ 下当前是扁平结构，没有 core/client/adapters/browser 子目录（CLAUDE.md 旧版列出的分层目录是规划中待重构的）：

```
src/
├── index.ts              # 入口：Chrome 启动/连接 → Fastify 启动并注册所有路由
├── config.ts             # 环境变量 → ServerConfig 对象
├── logger.ts             # pino 日志 (开发 pino-pretty, 生产写文件)
├── auth.ts               # API Key 鉴权 (Bearer / x-api-key)
├── concurrency.ts        # 信号量并发控制 (failFast / 排队)
├── models.ts             # 类型定义 (OpenAI/Anthropic/Qwen 协议类型)
├── dashboard.html        # Vue 3 管理仪表盘 (暗色主题, CDN Vue)
│
├── qwen-api.ts           # 核心：千问网页 API 逆向封装 (fetch 直连, SSE 解析, WAF 检测)
├── tool-sieve.ts         # StreamSieve: SSE 流筛分引擎 (DSML → tool_call 解码)
├── tool-dsml.ts          # DSML 工具编码 (tools[] → 提示词文本追加到消息)
├── qwen-client.ts        # QwenClient (统一入口, Provider 模式, 流式+非流式)
│
├── openai-adapter.ts     # OpenAI Chat Completions 协议适配 (路由注册在文件内)
├── anthropic-adapter.ts  # Anthropic Messages 协议适配 (路由注册在文件内)
│
├── chrome-manager.ts     # Chrome CDP 连接管理 (端口检测 → 启动/复用 → CDP 客户端)
└── login-qwen.ts         # Playwright 键盘操作弹窗登录 + 凭证持久化
```

## 架构与数据流 (6 层)

```
Route 层    → index.ts 注册路由 (/, /health, /dashboard, /relogin, /delete-chats)
              openai-adapter.ts 注册 POST /v1/chat/completions
              anthropic-adapter.ts 注册 POST /v1/messages
Adapter 层  → openai-adapter.ts / anthropic-adapter.ts
              (消息转换 + DSML 编码 + StreamSieve 解码 + SSE 协议输出)
Client 层   → qwen-client.ts (QwenClient + QwenProvider)
Core 层     → qwen-api.ts (QwenAI: fetch 直连 + createChat + SSE 解析 + WAF 重试)
              tool-sieve.ts (StreamSieve: DSML 标签剥离 + tool_call JSON 提取)
              tool-dsml.ts (formatToolsToDsml: tools[] → DSML 提示词)
Browser 层  → chrome-manager.ts (ChromeManager: 启动/复用 Chrome CDP)
              login-qwen.ts (Playwright 键盘操作登录 + 保存 qwen_auth.json)
Infra 层    → config.ts + logger.ts + auth.ts + concurrency.ts
```

### 核心数据流 (以 OpenAI 流式请求为例)

```
POST /v1/chat/completions {model, messages, tools[], stream}
  → verifyApiKey()                          # auth.ts
  → acquireOrFail()                         # concurrency.ts
  → buildQwenPayload()                      # openai-adapter.ts
     └→ formatToolsToDsml()                 # tool-dsml.ts (tools → DSML 文本追加到消息)
  → QwenClient.streamChat(payload)          # qwen-client.ts
     └→ QwenProvider.streamChat()
        └→ QwenAI.chatStream(messages)      # qwen-api.ts
           ├→ createChat()                  # POST /api/v2/chats/new (最多 5 次重试)
           ├→ fetch(completions, stream)    # POST /api/v2/chat/completions?chat_id=X
           └→ parseSSEChunk() × N           # SSE data: 行 → {thinking|text}
  → generateOpenAIStream()                  # openai-adapter.ts
     └→ StreamSieve.processChunk()          # tool-sieve.ts (DSML → tool_call)
     └→ SSE 格式输出                        # data: {...}\n\n
  → release()                               # concurrency.ts
```

## 关键设计细节

### 千问逆向 API

- **端点**: `POST /api/v2/chats/new` (创建对话), `POST /api/v2/chat/completions` (SSE 流), `GET /` (获取 acw_tc cookie)
- **凭证**: 从 `qwen_auth.json` 加载 `{access_token, cookies, user_agent}`，token 通过 `Authorization: Bearer` 头和 Cookie 双重传递
- **MODEL_MAP**: `qwen-max/qwen3-max/qwen-plus` → `qwen3.7-plus`; `qwen-turbo/qwen-lite` → `qwen3.6-plus`; 默认 → `qwen3.7-plus`
- **消息格式**: 每条消息需要 `fid`(UUID), `parentId`, `childrenIds`，最后一条消息附带 `feature_config`(thinking_enabled, auto_thinking 等)

### WAF 检测与重试

`qwen-api.ts` 的 `detectWaf()` 检测: `bxpunish` 响应头 → WAF; `content-type: text/html` + status 200 → WAF 挑战页; `content-type: json` 或 `event-stream` → 正常。WAF 时重试最多 3 次，每次刷新 `acw_tc` cookie，递增退避等待。

### DSML 工具调用格式

千问使用自定义 DSML 标签传递工具调用:
- 工具编码 (`tool-dsml.ts`): `<｜tool instructions begin｜>...可用工具 JSON...<｜tool instructions end｜>` 追加到用户消息末尾
- 工具解码 (`tool-sieve.ts`): 从 SSE 流中匹配 `<｜tool call begin｜>{"name":"...","arguments":{...}}<｜tool call end｜>`，用正则提取 JSON

### thinking 增量输出

`qwen-api.ts` 的 `chatStream()` 中 thinking 使用**长度追踪**而非全等比较：`lastThinkingLen` 记录已输出长度，每次只 yield 新增部分。这是因为千问可能重发已输出的 thinking 内容。

### 并发控制

`concurrency.ts` 实现简单信号量。`locked()` 检查 `available <= 0`(而非同时要求有等待者)，修复了旧版的 failFast 语义 bug。`failFast: true` 时超限直接拒绝 503，`false` 时进入 Promise 队列等待。

### Chrome 生命周期

`index.ts` 启动时: 检测端口 60131 → 无则启动 Chrome → CDP 连接 → Playwright connectOverCDP → 最大化窗口 → 打开仪表盘 → 关闭 Playwright(不关 Chrome)。Chrome 实例在进程间复用，永不主动关闭。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `QWEN_EMAIL` | — | 千问登录邮箱 (**必填**) |
| `QWEN_PASSWORD` | — | 千问登录密码 (**必填**) |
| `API_KEYS` | `sk-deepseek-default-key` | API Key, 逗号分隔 |
| `PORT` | `5419` | 监听端口 |
| `HOST` | `0.0.0.0` | 绑定地址 |
| `MODE` | `expert` | `expert` / `quick` (quick 禁用 thinking) |
| `THINKING` | `true` | 默认启用思考模式 |
| `SEARCH` | `false` | 默认启用搜索 |
| `MAX_CONCURRENT` | `5` | 最大并发请求数 |
| `FAIL_FAST` | `true` | 超并发直接拒绝 (true) 或排队 (false) |
| `LOG_LEVEL` | `info` | pino 日志级别 |
| `NODE_ENV` | — | `production` 时 pino 写文件到 `logs/app_debug.log` |

## 已知问题与约束

1. **TLS 指纹**: undici fetch 不支持 curl_cffi 的 `impersonate`，WAF 频繁拦截时需切 Chrome CDP 代理模式
2. **playwright 不能打包进 exe**: 需外挂 `node_modules/playwright`
3. **凭证安全**: `qwen_auth.json` 在 .gitignore，仅从环境变量读取密码
4. **独立部署**: 项目已从 `F:\AIQuantTrade\qwen\` 迁移到 `F:\qwen\`，Chrome Profile、日志、凭证路径均改为项目内部
5. **createChat 失败抛出异常** (非静默返回假 chat_id)
6. **thinking 增量用长度追踪** (非全等比较，防止跨 chunk 丢失)
7. **relogin 无环境变量时返回明确错误** (无硬编码 fallback)

## 路由一览

| 路由 | 方法 | 文件 | 功能 |
|------|------|------|------|
| `/` | GET | index.ts | 服务状态 (mode, chrome, login, connections) |
| `/health` | GET | index.ts | 健康检查 (凭证有效性 + 千问 API 状态) |
| `/dashboard` | GET | index.ts | Vue 3 管理仪表盘 HTML |
| `/relogin` | POST | index.ts | 手动触发千问重新登录 |
| `/delete-chats` | POST | index.ts | 删除千问所有历史对话 |
| `/v1/chat/completions` | POST | openai-adapter.ts | OpenAI 协议 (流式/非流式 + tools) |
| `/v1/messages` | POST | anthropic-adapter.ts | Anthropic 协议 (流式/非流式 + tools) |
