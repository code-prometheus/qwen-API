# Qwen Web2API Server

> 千问网页版 (chat.qwen.ai) → OpenAI / Anthropic 标准协议网关

[![Build & Release ZIP](https://github.com/code-prometheus/qwen-API/actions/workflows/release.yml/badge.svg)](https://github.com/code-prometheus/qwen-API/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

对外暴露标准 `/v1/chat/completions` (OpenAI) 和 `/v1/messages` (Anthropic) 端点，内部通过 undici fetch 直连千问网页版 API。支持流式 SSE、工具调用 (DSML)、思考过程 (thinking)、浏览器自动登录、WAF 绕过。

## 快速开始

### 方式一：便携 ZIP（推荐，无需安装依赖）

从 [Releases](https://github.com/code-prometheus/qwen-API/releases) 页面下载最新 `qwen-web2api-v*.zip`，解压到任意目录：

1. 解压 ZIP 到目标目录
2. 双击 `start.bat` 启动（首次运行会自动生成 `.env` 文件）
3. 编辑 `.env` 填入你的千问邮箱和密码
4. 重新运行 `start.bat`

> **前置要求**: 系统需安装 [Node.js 20+](https://nodejs.org/)

### 方式二：源码运行（开发者）

```bash
# 1. 克隆仓库
git clone https://github.com/code-prometheus/qwen-API.git
cd qwen-APIA

# 2. 安装依赖
npm install

# 3. 设置千问登录凭证
set QWEN_EMAIL=your_email@qq.com
set QWEN_PASSWORD=your_password

# 4. 启动
npm run dev      # 开发模式（热重载）
# 或
npm run build && npm start   # 编译后启动
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QWEN_EMAIL` | — | 千问登录邮箱 (**必填**) |
| `QWEN_PASSWORD` | — | 千问登录密码 (**必填**) |
| `API_KEYS` | `sk-deepseek-default-key` | API 鉴权密钥，逗号分隔多个 |
| `PORT` | `5419` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 绑定地址 |
| `MODE` | `expert` | `expert` / `quick`（quick 禁用 thinking） |
| `THINKING` | `true` | 默认启用思考模式 |
| `SEARCH` | `false` | 默认启用搜索 |
| `MAX_CONCURRENT` | `5` | 最大并发请求数 |
| `FAIL_FAST` | `true` | 超并发时直接拒绝 (`true`) 或排队 (`false`) |

## API 端点

| 端点 | 协议 | 功能 |
|------|------|------|
| `GET /` | — | 服务状态 |
| `GET /health` | — | 健康检查 |
| `POST /v1/chat/completions` | OpenAI | 流式/非流式对话 + 工具调用 |
| `POST /v1/messages` | Anthropic | 流式/非流式对话 + 工具调用 |
| `GET /dashboard` | — | 管理仪表盘 |
| `POST /relogin` | — | 手动触发重新登录 |
| `POST /delete-chats` | — | 删除千问所有历史对话 |

### OpenAI 示例

```bash
curl -H "Authorization: Bearer sk-deepseek-default-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen-max","messages":[{"role":"user","content":"你好"}],"stream":false}' \
  http://localhost:5419/v1/chat/completions
```

### 工具调用示例

```bash
curl -H "Authorization: Bearer sk-deepseek-default-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"qwen-max",
    "messages":[{"role":"user","content":"北京今天天气怎么样？"}],
    "tools":[{
      "type":"function",
      "function":{
        "name":"get_weather",
        "description":"获取指定城市的天气",
        "parameters":{"type":"object","properties":{"location":{"type":"string"}}}
      }
    }],
    "stream":false
  }' \
  http://localhost:5419/v1/chat/completions
```

## 项目结构

```
qwen-APIA/
├── src/
│   ├── index.ts              # 入口：启动 Chrome + Fastify
│   ├── config.ts             # 环境变量配置
│   ├── logger.ts             # 日志 (pino)
│   ├── auth.ts               # API Key 鉴权
│   ├── concurrency.ts        # 并发控制 (信号量)
│   ├── models.ts             # 类型定义
│   ├── dashboard.html        # 管理仪表盘
│   ├── qwen-api.ts           # 千问网页 API 逆向封装
│   ├── tool-sieve.ts         # SSE 流筛分引擎 (DSML 解码)
│   ├── tool-dsml.ts          # DSML 工具编码
│   ├── qwen-client.ts        # 统一客户端 (Provider 模式)
│   ├── openai-adapter.ts     # OpenAI 协议适配
│   ├── anthropic-adapter.ts  # Anthropic 协议适配
│   ├── chrome-manager.ts     # Chrome CDP 连接管理
│   └── login-qwen.ts         # 浏览器自动登录
├── .github/workflows/        # CI 自动构建
├── package.json
├── tsconfig.json
├── .gitignore
├── .env.example              # 环境变量模板
├── start.bat                 # Windows 一键启动
└── README.md
```

## 许可证

MIT — 详见 [LICENSE](LICENSE)
