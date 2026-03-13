# Antigravity Stealth Proxy — 逆向工程经验记录

> 本文档记录了逆向 Google Cloud Code (Antigravity) API 过程中的关键发现、踩坑记录和设计决策，
> 供日后版本迭代时参考，避免重复踩坑。

---

## 一、核心架构理解

### 1.1 请求链路

```
Claude Code CLI (Anthropic Messages API)
  → 反代 (协议翻译: Anthropic → Google Cloud Code)
    → Google Cloud Code API (v1internal:streamGenerateContent)
      → 实际模型 (Claude / Gemini)
    ← Google SSE 响应
  ← 反代 (协议翻译: Google → Anthropic SSE)
← Claude Code CLI 消费 SSE 流
```

### 1.2 关键端点

| 端点 | 用途 | 备注 |
|------|------|------|
| `v1internal:streamGenerateContent?alt=sse` | AI 对话（流式） | 主端点，所有 AI 请求走这里 |
| `v1internal:loadCodeAssist` | IDE 检测代码助手可用性 | 心跳用 |
| `v1internal:fetchAvailableModels` | 获取可用模型列表 | 查询配额/模型用 |
| `v1internal:logEvents` | IDE 遥测事件上报 | cclog scope |
| `v1internal:getExperimentConfigs` | 获取实验配置 | experimentsandconfigs scope |

### 1.3 API 基地址

- 生产: `https://cloudcode-pa.googleapis.com`
- 日更: `https://daily-cloudcode-pa.googleapis.com`

---

## 二、关键踩坑记录

### 2.1 User-Agent 模型家族分歧（严重）

**发现**: Claude 模型和 Gemini 模型对 User-Agent 有**完全相反的要求**。

| 模型家族 | 要求的 UA | 错误的 UA 结果 |
|----------|----------|---------------|
| Claude | `antigravity/{version} {platform}` | 404 Not Found |
| Gemini | `vscode/{version}` | 404 Not Found |

**教训**: 必须在 `buildHeaders()` 中根据模型名动态选择 UA。不能使用固定 UA。

```javascript
const userAgent = isClaudeModel
  ? `antigravity/${fp.antigravityVersion} ${fp.platformString}`
  : `vscode/${fp.vscodeVersion}`;
```

### 2.2 平台字符串格式（重要）

**错误**: 使用 `macos/arm64`、`linux/amd64` 等友好名称
**正确**: 使用 Node.js 的 `os.platform()` + `process.arch` 格式

| 错误格式 | 正确格式 |
|----------|----------|
| `macos/arm64` | `darwin/arm64` |
| `linux/amd64` | `linux/x64` |
| `windows/x64` | `win32/x64` |

**来源**: 真实 Antigravity 二进制的 `version-detector.js` 使用 `process.platform + '/' + process.arch`。

### 2.3 JSON Schema 白名单（关键）

**问题**: Claude Code CLI 发送的工具定义包含大量 JSON Schema 高级字段，
Google Cloud Code 的 protobuf Schema 只支持有限字段，不支持的字段会导致 400 错误。

**报错示例**:
```
Unknown name "propertyNames" at 'request.tools[0].function_declarations[13]...'
Unknown name "exclusiveMinimum" at 'request.tools[0].function_declarations[37]...'
```

**解决方案**: 白名单模式，只保留 Google protobuf 官方定义的 22 个字段：

```javascript
const SUPPORTED_KEYS = new Set([
  "type", "format", "title", "description", "nullable", "enum",
  "items", "maxItems", "minItems", "properties", "required",
  "minProperties", "maxProperties", "minimum", "maximum",
  "minLength", "maxLength", "pattern", "example", "anyOf",
  "propertyOrdering", "default"
]);
```

**来源**: `googleapis/googleapis` 仓库的 `google/ai/generativelanguage/v1beta/content.proto`

**不支持的常见字段**:
`$schema`, `$ref`, `$defs`, `additionalProperties`, `oneOf`, `allOf`, `not`,
`if/then/else`, `const`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`,
`uniqueItems`, `propertyNames`, `patternProperties`, `contentMediaType`,
`contentEncoding`, `deprecated`, `readOnly`, `writeOnly`

### 2.4 Thinking 配置的大小写差异

**Claude thinking 模型**: 使用 **snake_case**
```json
{
  "thinkingConfig": {
    "include_thoughts": true,
    "thinking_budget": 32000
  }
}
```

**Gemini thinking 模型**: 使用 **camelCase**
```json
{
  "thinkingConfig": {
    "includeThoughts": true,
    "thinkingBudget": 24576
  }
}
```

**教训**: 必须按模型家族分别处理 thinking config 字段命名。

### 2.5 Claude Thinking 需要 anthropic-beta 头

当模型名包含 `thinking` 且是 Claude 模型时，必须添加:
```
anthropic-beta: interleaved-thinking-2025-05-14
```
否则 thinking block 不会交错返回（会被合并为一大块或丢失）。

### 2.6 Thinking Signature 必须传递

Claude 的 thinking block 带有 `signature` 字段（≥50 字符），
后续对话必须原封不动传回 `thoughtSignature`，否则模型无法延续推理链。

```javascript
if (cleanBlock.thinking && cleanBlock.signature && cleanBlock.signature.length >= 50) {
  parts.push({
    text: cleanBlock.thinking,
    thought: true,
    thoughtSignature: cleanBlock.signature
  });
}
```

### 2.7 maxOutputTokens 必须大于 thinking_budget

如果 `maxOutputTokens <= thinking_budget`，API 会报错。
解决: 自动调整 `maxOutputTokens = budget + 8192`。

### 2.8 cache_control 字段必须剥离

Anthropic 格式的消息块可能带有 `cache_control` 字段，Google Cloud Code 不认识这个字段。
必须在转换消息时清除:
```javascript
const { cache_control, ...cleanBlock } = block;
```

### 2.9 Cloud Code 请求信封结构

外层信封不是标准 Gemini API 格式，是 Cloud Code 特有的:
```json
{
  "project": "project-id",
  "model": "claude-sonnet-4-6",
  "request": { /* 内层 Google Generative AI 请求 */ },
  "userAgent": "antigravity",
  "requestType": "agent",
  "requestId": "agent-{uuid}"
}
```

### 2.10 Project ID 动态发现

**错误**: 硬编码 project ID
**正确**: 每个账户的 project ID 不同，需要通过 `loadCodeAssist` 接口动态发现。

响应中包含 `projectId` 和 `tier`（如 `standard-tier`），tier 决定可用模型。

---

## 三、反检测策略

### 3.1 检测向量分析

| 检测向量 | 参考反代（badrisnarayanan） | 本项目解决方案 |
|----------|---------------------------|---------------|
| 静态请求头 | 所有请求头完全相同 | 每会话随机化指纹，会话轮转时更换 |
| 硬编码系统指令 | 注入固定 system prompt | 完全透传客户端 system prompt |
| 真实服务器平台 | 暴露实际 OS (linux/x64) | 从池中随机选取平台 |
| 零遥测 | 不发送任何 IDE 遥测事件 | 模拟 IDE 遥测 + 实验配置查询 |
| 无心跳 | 不发送心跳 | 定时 loadCodeAssist / fetchModels |
| 固定版本号 | 单一版本号 | 14+ 版本号随机池 |
| 无作息规律 | 24小时均匀请求 | 静默时段(0-7am)降低活动 |

### 3.2 指纹轮转策略

- 每个会话（`apiKey:accountEmail`）维护独立指纹
- 指纹在会话生命周期内保持一致（模拟同一 IDE 实例）
- 会话生命周期: 2-6 小时（随机），到期后轮转指纹（模拟 IDE 重启）
- 指纹包含: Antigravity 版本、VS Code 版本、Node.js 版本、gRPC 版本、平台

### 3.3 请求频率控制

- Token Bucket 限速: 默认 5 req/min
- 正态分布抖动: 1000-4000ms（避免等间隔请求的机器人特征）
- 突发允许: 3 个请求可以快速连发

### 3.4 遥测模拟

真实 Antigravity IDE 通过 `cclog` scope 和 `experimentsandconfigs` scope 发送遥测。
只发 AI 请求 + 心跳但零遥测是明显的自动化指纹。

模拟事件类型:
- `editor.file.open/close/save`
- `codeAssist.completion.shown/accepted/dismissed`
- `codeAssist.chat.open/send`
- `codeAssist.agent.start/complete`
- `editor.search.open`, `editor.terminal.open`, `editor.debug.start`

每 10-20 分钟发送一批，每批 1-4 组，每组 2-7 个事件。
静默时段(0-7am)跳过 90% 的遥测周期。

### 3.5 心跳模拟

- 每 30 分钟（含抖动）对所有账户发送心跳
- 70% `loadCodeAssist` / 30% `fetchAvailableModels`
- 静默时段跳过 80% 的心跳
- 账户间交错 2-8 秒

---

## 四、OAuth 认证

### 4.1 客户端凭据

Antigravity 使用固定的 Google OAuth Client:
- Client ID: `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`
- Client Secret: `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`

### 4.2 所需 Scopes

```
https://www.googleapis.com/auth/cloud-platform
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/cclog
https://www.googleapis.com/auth/experimentsandconfigs
```

注意: `cclog` 和 `experimentsandconfigs` 是遥测相关 scope，
大多数反代没有请求这些 scope，导致遥测请求失败（虽然不影响核心功能）。

### 4.3 Token 刷新

使用 Refresh Token 获取 Access Token，Access Token 有效期约 1 小时。
必须在过期前自动刷新。

---

## 五、响应翻译要点

### 5.1 Cloud Code SSE 格式

Google 的 SSE 事件有 Cloud Code 信封:
```json
{
  "response": {
    "candidates": [{ "content": { "parts": [...] }, "finishReason": "STOP" }],
    "usageMetadata": { "promptTokenCount": 100, "candidatesTokenCount": 50 }
  },
  "traceId": "...",
  "metadata": { ... }
}
```

### 5.2 Thinking Block 映射

Google 的 thought part:
```json
{ "text": "thinking content", "thought": true, "thoughtSignature": "..." }
```
→ Anthropic 的 thinking block:
```json
{ "type": "thinking", "thinking": "thinking content" }
```

### 5.3 Tool Use 映射

Google 的 functionCall:
```json
{ "functionCall": { "name": "tool_name", "args": {...}, "id": "..." } }
```
→ Anthropic 的 tool_use:
```json
{ "type": "tool_use", "id": "toolu_xxx", "name": "tool_name", "input": {...} }
```

### 5.4 Stop Reason 映射

| Google finishReason | Anthropic stop_reason |
|----|-----|
| STOP | end_turn |
| MAX_TOKENS | max_tokens |
| SAFETY | end_turn |
| RECITATION | end_turn |

---

## 六、部署注意事项

### 6.1 Nginx 反代配置关键点

```nginx
# SSE 流式传输必须关闭缓冲
proxy_buffering off;
proxy_cache off;

# AI 请求可能很长（10 分钟+）
proxy_read_timeout 600s;
proxy_send_timeout 600s;

# 大 prompt 需要较大的 body 限制
client_max_body_size 10m;
```

### 6.2 SSH 通过 Cloudflare Tunnel 不稳定

长时间运行的 SSH 命令（>30s）可能因 tunnel 超时断开。
解决: 使用 systemd service 管理进程，不依赖 SSH 会话。

### 6.3 Systemd 服务配置

```ini
[Service]
Type=simple
Restart=always
RestartSec=5
Environment=NODE_ENV=production
```

`RestartSec=5` 保证崩溃后 5 秒自动重启。

---

## 七、版本迭代检查清单

每次 Antigravity 更新时需要检查:

- [ ] 版本号池是否需要更新（ANTIGRAVITY_VERSIONS, VSCODE_VERSIONS, NODE_VERSIONS）
- [ ] 新的 API 端点或字段变化
- [ ] 模型名称变化（fetchAvailableModels 返回值）
- [ ] UA 格式要求是否变化
- [ ] 新的遥测事件类型
- [ ] OAuth scope 变化
- [ ] protobuf Schema 支持的字段是否新增
- [ ] Thinking config 字段格式变化
- [ ] Cloud Code 信封结构变化

---

## 八、调试技巧

1. **查看实际请求**: `journalctl -u antigravity-proxy -f` 实时日志
2. **测试特定模型**: `curl -X POST /v1/messages` 指定 model 字段
3. **检查模型可用性**: `curl /v1/models` 查看当前可用模型列表
4. **Schema 问题**: 400 错误中 `Unknown name "xxx"` 指出不支持的字段名
5. **UA 问题**: 404 错误通常是 UA 和模型不匹配
6. **Token 问题**: 401 后自动 invalidate 并重试

---

*最后更新: 2026-03-12*
*项目地址: https://github.com/hanfengchui/antigravity-stealth-proxy-new*
