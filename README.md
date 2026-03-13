```
     _          _   _                       _ _
    / \   _ __ | |_(_) __ _ _ __ __ ___   _(_) |_ _   _
   / _ \ | '_ \| __| |/ _` | '__/ _` \ \ / / | __| | | |
  / ___ \| | | | |_| | (_| | | | (_| |\ V /| | |_| |_| |
 /_/   \_\_| |_|\__|_|\__, |_|  \__,_| \_/ |_|\__|\__, |
    ____  _            |___/ _ _   _                |___/
   / ___|| |_ ___  __ _| | | |_| |__
   \___ \| __/ _ \/ _` | | | __| '_ \
    ___) | ||  __/ (_| | | | |_| | | |
   |____/ \__\___|\__,_|_|  \__|_| |_|
   ____
  |  _ \ _ __ _____  ___   _
  | |_) | '__/ _ \ \/ / | | |
  |  __/| | | (_) >  <| |_| |
  |_|   |_|  \___/_/\_\\__, |
                        |___/
```

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green?logo=node.js)
![License](https://img.shields.io/badge/License-MIT-blue)
![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20Windows-lightgrey)

---

# Antigravity Stealth Proxy

## 项目简介 / Introduction

**中文**

Antigravity Stealth Proxy 是一个 Node.js 反向代理服务器，可将 Anthropic Messages API 格式透明转换为 Google Cloud Code 内部 API 格式，从而让 Claude Code CLI 以 Google Cloud Code（免费额度 Gemini）作为后端运行。代理内置全面的反检测机制，模拟真实 IDE 使用行为，最大限度降低账号风险。

**为什么需要它？**
- Google Cloud Code 提供免费的大模型额度（包括 Gemini Pro 系列），但其 API 格式与 Anthropic API 完全不同
- Claude Code CLI 仅支持 Anthropic API 格式
- 本项目在两者之间架起桥梁，让你免费使用强大的 AI 编码助手

**English**

Antigravity Stealth Proxy is a Node.js reverse proxy server that transparently translates the Anthropic Messages API format into Google Cloud Code's internal API format, enabling Claude Code CLI to use Google Cloud Code (free-tier Gemini) as its backend. The proxy includes comprehensive anti-detection measures that simulate genuine IDE usage behavior to minimize account risk.

**Why do you need it?**
- Google Cloud Code offers free LLM quotas (including Gemini Pro series), but its API format is entirely different from Anthropic's
- Claude Code CLI only supports the Anthropic API format
- This project bridges the two, letting you use a powerful AI coding assistant at no cost

---

## 核心功能 / Core Features

### 中文

- **协议翻译** — 将 Anthropic Messages API 请求/响应实时转换为 Cloud Code API 格式，支持流式传输
- **多账号管理** — 支持配置多个 Google 账号，智能粘性路由 + 自动故障转移，每个用户绑定主/备账号
- **反检测引擎** — 会话指纹定期轮换（2-6 小时）、遥测事件模拟、心跳模拟、请求头随机化，模拟真实 IDE 行为
- **WebUI 管理面板** — 中文管理界面，一站式管理账号、查看状态、监控用量
- **Token 用量统计** — 按账号/用户实时统计 Token 消耗，每日请求限额管理
- **智能限速** — 令牌桶算法限速 + 人性化随机抖动延迟，模拟真实编码节奏
- **连接池复用** — 复用底层连接，降低新建连接产生的异常指纹
- **一键部署** — 提供安装脚本和 systemd 服务文件，快速部署到 Linux 服务器

### English

- **Protocol Translation** — Real-time bidirectional conversion between Anthropic Messages API and Cloud Code API formats, with full streaming support
- **Multi-Account Management** — Configure multiple Google accounts with intelligent sticky routing + automatic failover; bind primary/backup accounts per user
- **Anti-Detection Engine** — Session fingerprint rotation (every 2–6 hours), telemetry event simulation, heartbeat simulation, and header randomization to mimic genuine IDE behavior
- **WebUI Management Panel** — Chinese-language admin interface for one-stop account management, status monitoring, and usage tracking
- **Token Usage Dashboard** — Real-time per-account/per-user token consumption statistics with daily request limit management
- **Intelligent Rate Limiting** — Token-bucket rate limiting with human-like random jitter delays that mimic natural coding rhythm
- **Connection Pooling** — Reuses underlying connections to reduce anomalous fingerprints from frequent new connections
- **One-Click Deployment** — Installation script and systemd service file for rapid deployment to Linux servers

---

## 快速开始 / Quick Start

### 一键安装 / One-Line Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/user/repo/main/install.sh)
```

### 手动安装 / Manual Install

```bash
# 1. 克隆项目 / Clone the repository
git clone https://github.com/user/antigravity-stealth-proxy.git
cd antigravity-stealth-proxy

# 2. 安装依赖 / Install dependencies
npm install

# 3. 创建配置文件 / Create configuration
cp config.example.json config.json
# 编辑 config.json，填入你的账号信息
# Edit config.json with your account credentials

# 4. 添加账号（交互式） / Add account (interactive)
npm run add-account

# 5. 启动服务 / Start the server
npm start
```

### Systemd 部署 / Systemd Deployment

```bash
# 复制服务文件 / Copy service file
sudo cp antigravity-proxy.service /etc/systemd/system/

# 根据实际路径修改 WorkingDirectory / Edit WorkingDirectory to match your path
sudo nano /etc/systemd/system/antigravity-proxy.service

# 启动并设为开机自启 / Enable and start
sudo systemctl daemon-reload
sudo systemctl enable antigravity-proxy
sudo systemctl start antigravity-proxy

# 查看日志 / View logs
sudo journalctl -u antigravity-proxy -f
```

---

## 配置说明 / Configuration

配置文件为项目根目录下的 `config.json`，完整字段说明如下：

The configuration file is `config.json` in the project root. Full field reference:

```jsonc
{
  // 服务端口 / Server port
  "port": 8080,

  // 监听地址（0.0.0.0 = 所有接口） / Listen address (0.0.0.0 = all interfaces)
  "host": "0.0.0.0",

  // API 密钥（用户名 → 密钥映射） / API keys (username → key mapping)
  "apiKeys": {
    "user1": "sk-user1-change-me",
    "user2": "sk-user2-change-me"
  },

  // Google 账号列表 / Google account list
  "accounts": [
    { "email": "account1@gmail.com", "refreshToken": "REFRESH_TOKEN", "enabled": true },
    { "email": "account2@gmail.com", "refreshToken": "REFRESH_TOKEN", "enabled": true }
  ],

  // 用户绑定（API 密钥 → 主/备账号） / User bindings (API key → primary/backup account)
  "userBindings": {
    "sk-user1-change-me": { "primary": "account1@gmail.com", "backup": "account2@gmail.com" },
    "sk-user2-change-me": { "primary": "account2@gmail.com", "backup": "account1@gmail.com" }
  },

  // 限速配置 / Rate limiting configuration
  "pacer": {
    "maxRequestsPerMinute": 5,    // 每分钟最大请求数 / Max requests per minute
    "burstSize": 3,               // 突发请求数 / Burst allowance
    "jitterMinMs": 1000,          // 最小随机延迟 (ms) / Min random delay (ms)
    "jitterMaxMs": 4000,          // 最大随机延迟 (ms) / Max random delay (ms)
    "dailyLimitPerAccount": 500   // 每账号每日限额 / Daily limit per account
  },

  // 会话生命周期 / Session lifecycle
  "session": {
    "minLifetimeMs": 7200000,     // 最短生命周期 2h / Min lifetime 2h
    "maxLifetimeMs": 21600000,    // 最长生命周期 6h / Max lifetime 6h
    "restartDelayMs": 10000       // 重建延迟 / Restart delay
  },

  // 心跳模拟 / Heartbeat simulation
  "heartbeat": {
    "enabled": true,
    "intervalMs": 1800000         // 间隔 30 分钟 / Interval 30 minutes
  },

  // 重试策略 / Retry strategy
  "retry": {
    "maxRetries": 2,              // 最大重试次数 / Max retries
    "waitBeforeSwitch": 60000,    // 切换前等待 (ms) / Wait before switching (ms)
    "maxWaitMs": 120000           // 最大等待时间 (ms) / Max wait time (ms)
  },

  // 版本池（用于指纹随机化） / Version pools (for fingerprint randomization)
  "versionPools": {
    "antigravity": ["1.108.0", "1.108.1", "1.109.0", "1.109.1", "1.110.0"],
    "vscode": ["1.96.0", "1.96.1", "1.96.2", "1.97.0", "1.97.1", "1.98.0"],
    "node": ["20.12.0", "20.12.2", "20.13.1", "20.14.0", "22.11.0", "22.12.0"]
  }
}
```

---

## Claude Code CLI 配置 / Claude Code CLI Setup

在使用 Claude Code CLI 之前，设置以下环境变量：

Before using Claude Code CLI, set the following environment variables:

```bash
export ANTHROPIC_BASE_URL=http://YOUR_SERVER_IP:8080
export ANTHROPIC_AUTH_TOKEN=sk-your-api-key
export ANTHROPIC_MODEL=claude-sonnet-4-6-thinking
```

### 可用模型 / Available Models

| 模型名称 / Model Name | 说明 / Description |
|---|---|
| `claude-sonnet-4-6-thinking` | Claude Sonnet 4.6（推荐 / Recommended） |
| `claude-opus-4-6-thinking` | Claude Opus 4.6（需要高级额度 / Requires premium tier） |
| `claude-sonnet-4-6` | Claude Sonnet 4.6（无扩展思考 / Without extended thinking） |
| `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-haiku-4-5` | 映射到 Sonnet 4.6 / Maps to Sonnet 4.6 |
| `gemini-2.5-pro` | Gemini 2.5 Pro |
| `gemini-2.5-flash` | Gemini 2.5 Flash |
| `gemini-2.0-flash` | Gemini 2.0 Flash |

> **提示 / Tip**: 所有 Claude 模型名称会自动映射到 Cloud Code API 中对应的可用模型。如果请求的 Claude 模型不可用，会自动降级到对应的 Gemini 模型。
>
> All Claude model names are automatically mapped to their available counterparts in the Cloud Code API. If a requested Claude model is unavailable, it falls back to the corresponding Gemini model.

---

## WebUI 管理面板 / WebUI Management Panel

### 中文

通过浏览器访问 `http://YOUR_SERVER_IP:8080` 即可打开 WebUI 管理面板。

**面板功能：**

- **状态总览** — 查看服务运行时长、账号状态、会话信息
- **账号管理** — 添加/启用/禁用 Google 账号，通过 OAuth 流程获取 Refresh Token
- **用量监控** — 实时查看各账号的 Token 消耗、每日请求数、剩余额度
- **路由状态** — 查看当前用户-账号绑定关系和故障转移状态
- **限速状态** — 查看令牌桶状态和各账号的速率限制情况

### English

Access the WebUI management panel by opening `http://YOUR_SERVER_IP:8080` in your browser.

**Panel Features:**

- **Status Overview** — View service uptime, account status, and session information
- **Account Management** — Add/enable/disable Google accounts; obtain Refresh Tokens via OAuth flow
- **Usage Monitoring** — Real-time token consumption, daily request counts, and remaining quotas per account
- **Routing Status** — View current user-account bindings and failover status
- **Rate Limit Status** — View token bucket state and per-account rate limiting details

---

## 反检测机制概述 / Anti-Detection Overview

### 中文

本项目内置多层反检测机制，模拟真实 IDE 使用模式，降低账号异常风险：

- **会话指纹轮换** — 定期更换会话标识和客户端特征，模拟自然的编辑器重启行为
- **人性化请求节奏** — 请求之间加入随机延迟抖动，避免机械化的固定间隔请求模式
- **遥测事件模拟** — 在后台发送符合预期的 IDE 遥测事件，保持正常的活动特征
- **后台心跳** — 周期性发送心跳信号，模拟 IDE 持续在线的状态
- **连接复用** — 通过连接池复用底层连接，模拟单一客户端的连接行为
- **请求头随机化** — 从版本池中随机选取客户端版本号，每个会话呈现不同但合理的客户端指纹

### English

This project includes multiple layers of anti-detection measures that simulate genuine IDE usage patterns to minimize account risk:

- **Session Fingerprint Rotation** — Periodically refreshes session identifiers and client characteristics, simulating natural editor restart behavior
- **Human-Like Request Pacing** — Introduces random jitter delays between requests, avoiding the mechanical fixed-interval patterns typical of automated tools
- **Telemetry Event Simulation** — Sends expected IDE telemetry events in the background, maintaining normal activity characteristics
- **Background Heartbeat** — Periodically sends heartbeat signals to simulate a continuously online IDE
- **Connection Reuse** — Reuses underlying connections via connection pooling, mimicking single-client connection behavior
- **Header Randomization** — Randomly selects client version numbers from version pools, presenting a different but plausible client fingerprint per session

---

## 常见问题 / FAQ

### 如何添加 Google 账号？ / How to add Google accounts?

**中文**：通过 WebUI 的 OAuth 认证流程添加账号，系统会自动获取并保存 Refresh Token。也可以使用命令行工具 `npm run add-account` 交互式添加。

**English**: Use the WebUI's OAuth authentication flow to add accounts — the system will automatically obtain and save the Refresh Token. Alternatively, use the CLI tool `npm run add-account` for interactive setup.

### 遇到速率限制怎么办？ / What if I hit rate limits?

**中文**：可以通过以下方式缓解：
1. 在 `config.json` 中调整 `pacer` 配置（降低 `maxRequestsPerMinute`，增大 `jitterMaxMs`）
2. 添加更多 Google 账号分散请求
3. 提高 `dailyLimitPerAccount` 的值

**English**: Mitigate rate limiting by:
1. Adjusting `pacer` settings in `config.json` (lower `maxRequestsPerMinute`, increase `jitterMaxMs`)
2. Adding more Google accounts to distribute requests
3. Increasing the `dailyLimitPerAccount` value

### 如何更新？ / How to update?

```bash
cd antigravity-stealth-proxy
git pull
npm install
sudo systemctl restart antigravity-proxy
```

### 如何支持多用户？ / How to support multiple users?

**中文**：在 `config.json` 中：
1. 在 `apiKeys` 中为每个用户创建唯一的 API Key
2. 在 `userBindings` 中为每个 API Key 绑定主/备账号
3. 每个用户使用自己的 API Key 配置 Claude Code CLI

**English**: In `config.json`:
1. Create a unique API key per user in `apiKeys`
2. Bind primary/backup accounts for each API key in `userBindings`
3. Each user configures their Claude Code CLI with their own API key

### 服务启动后看不到 WebUI？ / WebUI not showing after server starts?

**中文**：确认浏览器访问的是服务器 IP 和配置的端口（默认 8080），且防火墙已放行该端口。

**English**: Verify you're accessing the correct server IP and configured port (default 8080), and that the firewall allows traffic on that port.

### 支持哪些操作系统？ / Which operating systems are supported?

**中文**：支持所有运行 Node.js >= 18 的系统。推荐 Linux 服务器部署（提供 systemd 服务文件）。Windows 和 macOS 也可运行，但需自行管理进程。

**English**: Any system running Node.js >= 18 is supported. Linux server deployment is recommended (systemd service file provided). Windows and macOS work too, but you'll need to manage the process yourself.

---

## 项目结构 / Project Structure

```
antigravity-stealth-proxy/
├── src/
│   ├── index.js              # 入口 / Entry point
│   ├── server.js             # Express 服务器 / Express server
│   ├── config.js             # 配置加载 / Config loader
│   ├── auth/                 # 认证模块 / Auth module
│   ├── translator/           # 协议翻译 / Protocol translation
│   │   ├── request.js        # 请求转换 / Request conversion
│   │   ├── response.js       # 响应转换 / Response conversion
│   │   ├── streaming.js      # 流式处理 / Streaming handler
│   │   └── model-map.js      # 模型映射 / Model mapping
│   ├── routing/              # 路由管理 / Routing management
│   ├── fingerprint/          # 会话指纹 / Session fingerprinting
│   ├── pacer/                # 限速控制 / Rate limiting
│   ├── heartbeat/            # 心跳模拟 / Heartbeat simulation
│   ├── telemetry/            # 遥测模拟 / Telemetry simulation
│   ├── monitor/              # 监控模块 / Monitoring
│   ├── usage/                # 用量统计 / Usage tracking
│   └── webui/                # 管理面板 / Admin panel
├── public/                   # WebUI 静态资源 / WebUI static assets
├── scripts/                  # 工具脚本 / Utility scripts
├── config.example.json       # 配置模板 / Config template
├── antigravity-proxy.service # systemd 服务文件 / systemd service file
└── package.json
```

---

## License

MIT License

Copyright (c) 2024

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
