# Antigravity to OpenAI API 代理服务

将 Google Antigravity API 转换为 OpenAI 兼容格式的代理服务，支持流式响应、工具调用和多账号管理。

## 功能特性

- ✅ OpenAI API 兼容格式
- ✅ 流式和非流式响应
- ✅ 工具调用（Function Calling）支持
- ✅ 多账号自动轮换（支持多种轮询策略）
- ✅ Token 自动刷新
- ✅ API Key 认证
- ✅ 思维链（Thinking）输出，兼容 OpenAI reasoning_effort 参数和 DeepSeek reasoning_content 格式
- ✅ 图片输入支持（Base64 编码）
- ✅ 图片生成支持（gemini-3-pro-image 模型）
- ✅ Pro 账号随机 ProjectId 支持
- ✅ 模型额度查看（实时显示剩余额度和重置时间）
- ✅ SD WebUI API 兼容（支持 txt2img/img2img）
- ✅ 心跳机制（防止 Cloudflare 超时断连）
- ✅ 模型列表缓存（减少 API 请求）
- ✅ 资格校验自动回退（无资格时自动生成随机 ProjectId）
- ✅ 真 System 消息合并（开头连续多条 system 与 SystemInstruction 合并）
- ✅ 隐私模式（自动隐藏敏感信息）
- ✅ 内存优化（从 8+ 进程减少为 2 个进程，内存占用从 100MB+ 降为 50MB+）
- ✅ 对象池复用（减少 50%+ 临时对象创建，降低 GC 频率）

## 环境要求

- Node.js >= 18.0.0

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env` 并编辑配置：

```bash
cp .env.example .env
```

编辑 `.env` 文件配置必要参数：

```env
# 必填配置
API_KEY=sk-text
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
JWT_SECRET=your-jwt-secret-key-change-this-in-production

# 可选配置
# PROXY=http://127.0.0.1:7890
# SYSTEM_INSTRUCTION=你是聊天机器人
# IMAGE_BASE_URL=http://your-domain.com
```

### 3. 登录获取 Token

```bash
npm run login
```

浏览器会自动打开 Google 授权页面，授权后 Token 会保存到 `data/accounts.json`。

### 4. 启动服务

```bash
npm start
```

服务将在 `http://localhost:8045` 启动。

## Docker 部署

### 使用 Docker Compose（推荐）

1. **配置环境变量**

创建 `.env` 文件：

```bash
cp .env.example .env
```

编辑 `.env` 文件配置必要参数。

2. **启动服务**

```bash
docker-compose up -d
```

3. **查看日志**

```bash
docker-compose logs -f
```

4. **停止服务**

```bash
docker-compose down
```

### 使用 Docker

1. **构建镜像**

```bash
docker build -t antigravity2api .
```

2. **运行容器**

```bash
docker run -d \
  --name antigravity2api \
  -p 8045:8045 \
  -e API_KEY=sk-text \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=admin123 \
  -e JWT_SECRET=your-jwt-secret-key \
  -e IMAGE_BASE_URL=http://your-domain.com \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/public/images:/app/public/images \
  -v $(pwd)/.env:/app/.env \
  -v $(pwd)/config.json:/app/config.json \
  antigravity2api
```

3. **查看日志**

```bash
docker logs -f antigravity2api
```

### Docker 部署说明

- 数据持久化：`data/` 目录挂载到容器，保存 Token 数据
- 图片存储：`public/images/` 目录挂载到容器，保存生成的图片
- 配置文件：`.env` 和 `config.json` 挂载到容器，支持热更新
- 端口映射：默认映射 8045 端口，可根据需要修改
- 自动重启：容器异常退出会自动重启

## Zeabur 部署

### 使用预构建镜像部署

1. **创建服务**

在 Zeabur 控制台创建新服务，使用以下镜像：

```
ghcr.io/liuw1535/antigravity2api-nodejs
```

2. **配置环境变量**

在服务设置中添加以下环境变量：

| 环境变量 | 说明 | 示例值 |
|--------|------|--------|
| `API_KEY` | API 认证密钥 | `sk-your-api-key` |
| `ADMIN_USERNAME` | 管理员用户名 | `admin` |
| `ADMIN_PASSWORD` | 管理员密码 | `your-secure-password` |
| `JWT_SECRET` | JWT 密钥 | `your-jwt-secret-key` |
| `IMAGE_BASE_URL` | 图片服务基础 URL | `https://your-domain.zeabur.app` |

可选环境变量：
- `PROXY`：代理地址
- `SYSTEM_INSTRUCTION`：系统提示词

3. **配置持久化存储**

在服务的「Volumes」设置中添加以下挂载点：

| 挂载路径 | 说明 |
|---------|------|
| `/app/data` | Token 数据存储 |
| `/app/public/images` | 生成的图片存储 |

⚠️ **重要提示**：
- 只挂载 `/app/data` 和 `/app/public/images` 这两个目录
- 不要挂载其他目录（如 `/app/.env`、`/app/config.json` 等），否则会导致必要配置文件被清空，项目无法启动

4. **绑定域名**

在服务的「Networking」设置中绑定域名，然后将该域名设置到 `IMAGE_BASE_URL` 环境变量中。

5. **启动服务**

保存配置后，Zeabur 会自动拉取镜像并启动服务。访问绑定的域名即可使用。

### Zeabur 部署说明

- 使用预构建的 Docker 镜像，无需手动构建
- 通过环境变量配置所有必要参数
- 持久化存储确保 Token 和图片数据不丢失

## Web 管理界面

服务启动后，访问 `http://localhost:8045` 即可打开 Web 管理界面。

### 功能特性

- 🔐 **安全登录**：JWT Token 认证，保护管理接口
- 📊 **实时统计**：显示总 Token 数、启用/禁用状态统计
- ➕ **多种添加方式**：
  - OAuth 授权登录（推荐）：自动完成 Google 授权流程
  - 手动填入：直接输入 Access Token 和 Refresh Token
- 🎯 **Token 管理**：
  - 查看所有 Token 的详细信息（Access Token 后缀、Project ID、过期时间）
  - 📊 查看模型额度：按类型分组显示（Claude/Gemini/其他），实时查看剩余额度和重置时间
  - 一键启用/禁用 Token
  - 删除无效 Token
  - 实时刷新 Token 列表
- ⚙️ **配置管理**：
  - 在线编辑服务器配置（端口、监听地址）
  - 调整默认参数（温度、Top P/K、最大 Token 数）
  - 修改安全配置（API 密钥、请求大小限制）
  - 配置代理、系统提示词等可选项
  - 热重载配置（部分配置需重启生效）

### 使用流程

1. **登录系统**
   - 使用 `.env` 中配置的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录
   - 登录成功后会自动保存 JWT Token 到浏览器

2. **添加 Token**
   - **OAuth 方式**（推荐）：
     1. 点击「OAuth登录」按钮
     2. 在弹窗中点击「打开授权页面」
     3. 在新窗口完成 Google 授权
     4. 复制浏览器地址栏的完整回调 URL
     5. 粘贴到输入框并提交
   - **手动方式**：
     1. 点击「手动填入」按钮
     2. 填写 Access Token、Refresh Token 和过期时间
     3. 提交保存

3. **管理 Token**
   - 查看 Token 卡片显示的状态和信息
   - 点击「📊 查看额度」按钮查看该账号的模型额度信息
     - 自动按模型类型分组（Claude/Gemini/其他）
     - 显示剩余额度百分比和进度条
     - 显示额度重置时间（北京时间）
     - 支持「立即刷新」强制更新额度数据
   - 使用「启用/禁用」按钮控制 Token 状态
   - 使用「删除」按钮移除无效 Token
   - 点击「刷新」按钮更新列表

4. **隐私模式**
   - 默认开启，自动隐藏 Token、Project ID 等敏感信息
   - 点击「显示敏感信息」切换显示/隐藏状态
   - 支持逐个查看或批量显示

5. **配置轮询策略**
   - 支持三种轮询策略：
     - `round_robin`：均衡负载，每次请求切换 Token
     - `quota_exhausted`：额度耗尽才切换
     - `request_count`：自定义请求次数后切换
   - 可在「设置」页面配置

6. **修改配置**
   - 切换到「设置」标签页
   - 修改需要调整的配置项
   - 点击「保存配置」按钮应用更改
   - 注意：端口和监听地址修改需要重启服务
   - 支持的设置项：
     - 编辑 Token 信息（Access Token、Refresh Token）
     - 思考预算（1024-32000）
     - 图片访问地址
     - 轮询策略
     - 内存阈值
     - 心跳间隔
     - 字体大小

### 界面预览

- **Token 管理页面**：卡片式展示所有 Token，支持快速操作
- **设置页面**：分类展示所有配置项，支持在线编辑
- **响应式设计**：支持桌面和移动设备访问
- **字体优化**：采用 MiSans + Ubuntu Mono 字体，增强可读性

## API 使用

服务提供 OpenAI 兼容的 API 接口，详细使用说明请查看 [API.md](API.md)。

### 快速测试

```bash
curl http://localhost:8045/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-text" \
  -d '{
    "model": "gemini-2.0-flash-exp",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

## 多账号管理

`data/accounts.json` 支持多个账号，服务会自动轮换使用：

```json
[
  {
    "access_token": "ya29.xxx",
    "refresh_token": "1//xxx",
    "expires_in": 3599,
    "timestamp": 1234567890000,
    "enable": true
  },
  {
    "access_token": "ya29.yyy",
    "refresh_token": "1//yyy",
    "expires_in": 3599,
    "timestamp": 1234567890000,
    "enable": true
  }
]
```

- `enable: false` 可禁用某个账号
- Token 过期会自动刷新
- 刷新失败（403）会自动禁用并切换下一个账号

## 配置说明

项目配置分为两部分：

### 1. config.json（基础配置）

基础配置文件，包含服务器、API 和默认参数设置：

```json
{
  "server": {
    "port": 8045,              // 服务端口
    "host": "0.0.0.0",         // 监听地址
    "maxRequestSize": "500mb", // 最大请求体大小
    "heartbeatInterval": 15000,// 心跳间隔（毫秒），防止 Cloudflare 超时
    "memoryThreshold": 100     // 内存阈值（MB），超过时触发 GC
  },
  "rotation": {
    "strategy": "round_robin", // 轮询策略：round_robin/quota_exhausted/request_count
    "requestCount": 50         // request_count 策略下每个 Token 的请求次数
  },
  "defaults": {
    "temperature": 1,          // 默认温度参数
    "topP": 1,                 // 默认 top_p
    "topK": 50,                // 默认 top_k
    "maxTokens": 32000,        // 默认最大 token 数
    "thinkingBudget": 1024     // 默认思考预算（仅对思考模型生效，范围 1024-32000）
  },
  "cache": {
    "modelListTTL": 3600000    // 模型列表缓存时间（毫秒），默认 1 小时
  },
  "other": {
    "timeout": 300000,         // 请求超时时间（毫秒）
    "skipProjectIdFetch": false,// 跳过 ProjectId 获取，直接随机生成（仅 Pro 账号有效）
    "useNativeAxios": false    // 使用原生 axios 而非 AntigravityRequester
  }
}
```

### 轮询策略说明

| 策略 | 说明 |
|------|------|
| `round_robin` | 均衡负载：每次请求后切换到下一个 Token |
| `quota_exhausted` | 额度耗尽才切换：持续使用当前 Token 直到额度用完 |
| `request_count` | 自定义次数：每个 Token 使用指定次数后切换 |

### 2. .env（敏感配置）

环境变量配置文件，包含敏感信息和可选配置：

| 环境变量 | 说明 | 必填 |
|--------|------|------|
| `API_KEY` | API 认证密钥 | ✅ |
| `ADMIN_USERNAME` | 管理员用户名 | ✅ |
| `ADMIN_PASSWORD` | 管理员密码 | ✅ |
| `JWT_SECRET` | JWT 密钥 | ✅ |
| `PROXY` | 代理地址（如：http://127.0.0.1:7890），也支持系统代理环境变量 
|`HTTP_PROXY`/`HTTPS_PROXY` | ❌ |
| `SYSTEM_INSTRUCTION` | 系统提示词 | ❌ |
| `IMAGE_BASE_URL` | 图片服务基础 URL | ❌ |

完整配置示例请参考 `.env.example` 文件。

## 开发命令

```bash
# 启动服务
npm start

# 开发模式（自动重启）
npm run dev

# 登录获取 Token
npm run login
```

## 项目结构

```
.
├── data/
│   ├── accounts.json       # Token 存储（自动生成）
│   └── quotas.json         # 额度缓存（自动生成）
├── public/
│   ├── index.html          # Web 管理界面
│   ├── app.js              # 前端逻辑
│   ├── style.css           # 界面样式
│   └── images/             # 生成的图片存储目录
├── scripts/
│   ├── oauth-server.js     # OAuth 登录服务
│   └── refresh-tokens.js   # Token 刷新脚本
├── src/
│   ├── api/
│   │   └── client.js       # API 调用逻辑（含模型列表缓存）
│   ├── auth/
│   │   ├── jwt.js          # JWT 认证
│   │   ├── token_manager.js # Token 管理（含轮询策略）
│   │   └── quota_manager.js # 额度缓存管理
│   ├── routes/
│   │   ├── admin.js        # 管理接口路由
│   │   └── sd.js           # SD WebUI 兼容接口
│   ├── bin/
│   │   ├── antigravity_requester_android_arm64   # Android ARM64 TLS 请求器
│   │   ├── antigravity_requester_linux_amd64     # Linux AMD64 TLS 请求器
│   │   └── antigravity_requester_windows_amd64.exe # Windows AMD64 TLS 请求器
│   ├── config/
│   │   ├── config.js       # 配置加载
│   │   └── init-env.js     # 环境变量初始化
│   ├── constants/
│   │   └── oauth.js        # OAuth 常量
│   ├── server/
│   │   └── index.js        # 主服务器（含内存管理和心跳）
│   ├── utils/
│   │   ├── configReloader.js # 配置热重载
│   │   ├── deepMerge.js    # 深度合并工具
│   │   ├── envParser.js    # 环境变量解析
│   │   ├── idGenerator.js  # ID 生成器
│   │   ├── imageStorage.js # 图片存储
│   │   ├── logger.js       # 日志模块
│   │   └── utils.js        # 工具函数
│   └── AntigravityRequester.js # TLS 指纹请求器封装
├── test/
│   ├── test-request.js     # 请求测试
│   ├── test-image-generation.js # 图片生成测试
│   ├── test-token-rotation.js # Token 轮换测试
│   └── test-transform.js   # 转换测试
├── .env                    # 环境变量配置（敏感信息）
├── .env.example            # 环境变量配置示例
├── config.json             # 基础配置文件
├── Dockerfile              # Docker 构建文件
├── docker-compose.yml      # Docker Compose 配置
└── package.json            # 项目配置
```

## Pro 账号随机 ProjectId

对于 Pro 订阅账号，可以跳过 API 验证直接使用随机生成的 ProjectId：

1. 在 `config.json` 文件中设置：
```json
{
  "other": {
    "skipProjectIdFetch": true
  }
}
```

2. 运行 `npm run login` 登录时会自动使用随机生成的 ProjectId

3. 已有账号也会在使用时自动生成随机 ProjectId

注意：此功能仅适用于 Pro 订阅账号。官方已修复免费账号使用随机 ProjectId 的漏洞。

## 资格校验自动回退

当 OAuth 登录或添加 Token 时，系统会自动检测账号的订阅资格：

1. **有资格的账号**：正常使用 API 返回的 ProjectId
2. **无资格的账号**：自动生成随机 ProjectId，避免添加失败

这一机制确保了：
- 无论账号是否有 Pro 订阅，都能成功添加 Token
- 自动降级处理，无需手动干预
- 不会因为资格校验失败而阻止登录流程

## 真 System 消息合并

本服务支持将开头连续的多条 system 消息与全局 SystemInstruction 合并：

```
请求消息：
[system] 你是助手
[system] 请使用中文回答
[user] 你好

合并后：
SystemInstruction = 全局配置的系统提示词 + "\n\n" + "你是助手\n\n请使用中文回答"
messages = [{role: user, content: 你好}]
```

这一设计：
- 兼容 OpenAI 的多 system 消息格式
- 充分利用 Antigravity 的 SystemInstruction 功能
- 确保系统提示词的完整性和优先级

## 思考预算（Thinking Budget）

对于支持思考能力的模型（如 gemini-2.0-flash-thinking-exp），可以通过以下方式控制思考深度：

### 方式一：使用 reasoning_effort 参数（OpenAI 兼容）

```json
{
  "model": "gemini-2.0-flash-thinking-exp",
  "reasoning_effort": "high",
  "messages": [...]
}
```

| 值 | 思考 Token 预算 |
|---|----------------|
| `low` | 1024 |
| `medium` | 16000 |
| `high` | 32000 |

### 方式二：使用 thinking_budget 参数（精确控制）

```json
{
  "model": "gemini-2.0-flash-thinking-exp",
  "thinking_budget": 24000,
  "messages": [...]
}
```

- 范围：1024 - 32000
- 优先级：`thinking_budget` > `reasoning_effort` > 配置文件默认值

### DeepSeek 思考格式兼容

本服务自动适配 DeepSeek 的 `reasoning_content` 格式，将思维链内容单独输出，避免与正常内容混淆：

```json
{
  "choices": [{
    "message": {
      "content": "最终答案",
      "reasoning_content": "这是思考过程..."
    }
  }]
}
```

## 内存优化

本服务经过深度内存优化：

### 优化效果

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| 进程数 | 8+ | 2 |
| 内存占用 | 100MB+ | 50MB+ |
| GC 频率 | 高 | 低 |

### 优化手段

1. **对象池复用**：流式响应对象通过对象池复用，减少 50%+ 临时对象创建
2. **预编译常量**：正则表达式、格式字符串等预编译，避免重复创建
3. **LineBuffer 优化**：高效的流式行分割，避免频繁字符串操作
4. **自动内存清理**：堆内存超过阈值（默认 100MB）时自动触发 GC
5. **进程精简**：移除不必要的子进程，统一在主进程处理

### 配置

```json
{
  "server": {
    "memoryThreshold": 100
  }
}
```

- `memoryThreshold`：触发 GC 的堆内存阈值（MB）

## 心跳机制

为防止 Cloudflare 等 CDN 因长时间无响应而断开连接，本服务实现了 SSE 心跳机制：

- 在流式响应期间，定期发送心跳包（`: heartbeat\n\n`）
- 默认间隔 15 秒，可配置
- 心跳包符合 SSE 规范，客户端会自动忽略

### 配置

```json
{
  "server": {
    "heartbeatInterval": 15000
  }
}
```

- `heartbeatInterval`：心跳间隔（毫秒），设为 0 禁用心跳

## 注意事项

1. 首次使用需要复制 `.env.example` 为 `.env` 并配置
2. 运行 `npm run login` 获取 Token
3. `.env` 和 `data/accounts.json` 包含敏感信息，请勿泄露
4. 支持多账号轮换，提高可用性
5. Token 会自动刷新，无需手动维护

## License

MIT
