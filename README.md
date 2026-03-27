# Antigravity to OpenAI API 代理服务

将 Google Antigravity API 转换为 OpenAI 兼容格式的代理服务，支持流式响应、工具调用和多账号管理。

## 🌟 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=liuw1535/antigravity2api-nodejs&type=Date)](https://www.star-history.com/#liuw1535/antigravity2api-nodejs&Date)

## 功能特性

- ✅ OpenAI API 兼容格式
- ✅ 流式和非流式响应
- ✅ 结构化 JSON 输出支持（response_format）
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
- ✅ 签名透传控制（可配置是否将 thoughtSignature 透传到客户端）
- ✅ 预编译二进制文件（支持 Windows/Linux/Android，无需 Node.js 环境）
- ✅ 多 API 格式支持（OpenAI、Gemini、Claude 三种格式）
- ✅ 转换器代码复用（公共模块提取，减少重复代码）
- ✅ 动态内存阈值（根据用户配置自动计算各级别阈值）

## 环境要求

- Node.js >= 18.0.0

## 快速开始

### 方式一：一键部署脚本（推荐）

**Windows (cmd.exe)**：
```bash
curl -O https://raw.githubusercontent.com/liuw1535/antigravity2api-nodejs/main/setup.bat && setup.bat
```

**Windows (PowerShell)**：
```powershell
IwR -Uri https://raw.githubusercontent.com/liuw1535/antigravity2api-nodejs/main/setup.bat -OutFile setup.bat; .\setup.bat
```

**Linux/macOS**：
```bash
wget https://raw.githubusercontent.com/liuw1535/antigravity2api-nodejs/main/setup.sh && chmod +x setup.sh && ./setup.sh
```

或使用 curl：
```bash
curl -O https://raw.githubusercontent.com/liuw1535/antigravity2api-nodejs/main/setup.sh && chmod +x setup.sh && ./setup.sh
```

脚本会自动完成以下操作：
1. 克隆项目仓库
2. 安装依赖
3. 复制配置文件
4. 配置管理员凭据（交互式输入）
5. 启动服务

### 快速启动（已部署）

如果已经部署成功，可以使用启动脚本快速启动服务：

**Windows**：
```bash
start.bat
```

**Linux/macOS**：
```bash
chmod +x start.sh
./start.sh
```

### 更新项目

使用更新脚本可以安全地更新到最新版本（自动保存本地修改）：

**Windows**：
```bash
update.bat
```

**Linux/macOS**：
```bash
chmod +x update.sh
./update.sh
```

更新完成后，可以选择：
- 恢复本地修改：`git stash pop`
- 删除本地修改：`git stash drop`

### 方式二：手动部署

#### 1. 安装依赖

```bash
npm install
```

#### 2. 配置环境变量

首次启动时，如果 `.env` 和 `config.json` 不存在，系统会自动创建默认配置文件。

你也可以手动复制示例文件：

```bash
cp .env.example .env,.
cp config.json.example config.json
```

编辑 `.env` 文件配置必要参数：

```env
# 必填配置（留空则自动生成随机凭据）
API_KEY=sk-text
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
JWT_SECRET=your-jwt-secret-key-change-this-in-production

# 可选配置
# PROXY=http://127.0.0.1:7890
# SYSTEM_INSTRUCTION=你是聊天机器人
# IMAGE_BASE_URL=http://your-domain.com
```

#### 3. 登录获取 Token

```bash
npm run login
```

浏览器会自动打开 Google 授权页面，授权后 Token 会保存到 `data/accounts.json`。

#### 4. 启动服务

```bash
npm start
```

服务将在 `http://localhost:8045` 启动。

## 二进制文件部署（推荐）

无需安装 Node.js，直接下载预编译的二进制文件即可运行。

### 下载二进制文件

从 [GitHub Releases](https://github.com/ZhaoShanGeng/antigravity2api-nodejs/releases) 下载对应平台的二进制文件：

| 平台 | 文件名 |
|------|--------|
| Windows x64 | `antigravity2api-win-x64.exe` |
| Linux x64 | `antigravity2api-linux-x64` |
| Linux ARM64 | `antigravity2api-linux-arm64` |
| macOS x64 | `antigravity2api-macos-x64` |
| macOS ARM64 | `antigravity2api-macos-arm64` |

### 准备配置文件

将以下文件放在二进制文件同目录下：

```
├── antigravity2api-win-x64.exe  # 二进制文件
├── .env                          # 环境变量配置（可选，首次启动自动创建）
├── config.json.example           # 配置示例文件（必需）
├── public/                       # 静态文件目录（必需）
│   ├── index.html
│   ├── style.css
│   ├── assets/
│   │   └── bg.jpg
│   └── js/
│       ├── auth.js
│       ├── config.js
│       ├── main.js
│       ├── quota.js
│       ├── tokens.js
│       ├── ui.js
│       └── utils.js
└── data/                         # 数据目录（自动创建）
    └── accounts.json
```

### 配置环境变量

创建 `.env` 文件：

```env
API_KEY=sk-your-api-key
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
JWT_SECRET=your-jwt-secret-key-change-this-in-production
# IMAGE_BASE_URL=http://your-domain.com
# PROXY=http://127.0.0.1:7890
```

### 运行

**Windows**：
```bash
# 直接双击运行，或在命令行执行
antigravity2api-win-x64.exe
```

**Linux/macOS**：
```bash
# 添加执行权限
chmod +x antigravity2api-linux-x64

# 运行
./antigravity2api-linux-x64
```

### 二进制部署说明

- **无需 Node.js**：二进制文件已包含 Node.js 运行时
- **自动配置**：首次启动时自动从 `config.json.example` 创建 `config.json`
- **配置文件**：`config.json.example` 必须与二进制文件在同一目录
- **静态文件**：`public/` 目录必须与二进制文件在同一目录
- **数据持久化**：`data/` 目录会自动创建，用于存储 Token 数据
- **跨平台**：支持 Windows、Linux、macOS（x64 和 ARM64）

### 作为系统服务运行（Linux）

创建 systemd 服务文件 `/etc/systemd/system/antigravity2api.service`：

```ini
[Unit]
Description=Antigravity2API Service
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/antigravity2api
ExecStart=/opt/antigravity2api/antigravity2api-linux-x64
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable antigravity2api
sudo systemctl start antigravity2api
```

## Docker 部署

### 使用 Docker Compose（推荐）

1. **一键构建**

```bash
npm run docker:build
```

该命令会自动：
- 从 `.env.example` 创建 `.env`（如果不存在）
- 从 `config.json.example` 创建 `config.json`（如果不存在）
- 创建必要的目录（`data/`、`public/images/`）
- 执行 `docker-compose build` 构建镜像

2. **启动服务**

```bash
docker compose up -d
```

3. **查看日志**

```bash
docker compose logs -f
```

4. **停止服务**

```bash
docker compose down
```

### 手动构建

如果需要手动构建，请先准备配置文件：

```bash
# 复制配置文件
cp .env.example .env
cp config.json.example config.json

# 创建必要目录
mkdir -p data public/images

# 构建镜像
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

基础配置文件，包含服务器、API 和默认参数设置。

首次启动时，如果 `config.json` 不存在，系统会自动从 `config.json.example` 复制一份默认配置。

配置示例：

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
    "useNativeAxios": false,   // 使用原生 axios 而非 AntigravityRequester
    "useContextSystemPrompt": false, // 是否将请求中的 system 消息合并到 SystemInstruction
    "passSignatureToClient": false   // 是否将 thoughtSignature 透传到客户端
  }
}
```

### 轮询策略说明

| 策略 | 说明 |
|------|------|
| `round_robin` | 均衡负载：每次请求后切换到下一个 Token |
| `quota_exhausted` | 额度耗尽才切换：持续使用当前 Token 直到额度用完（高性能优化） |
| `request_count` | 自定义次数：每个 Token 使用指定次数后切换（默认策略） |

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

# 构建 Docker 镜像
npm run docker:build
```

## 项目结构

```
.
├── data/
│   ├── accounts.json       # Token 存储（自动生成）
│   └── quotas.json         # 额度缓存（自动生成）
├── public/
│   ├── assets/             # 静态资源
│   ├── images/             # 生成的图片存储目录
│   ├── index.html          # Web 管理界面
│   ├── js/                 # 前端逻辑
│   │   ├── auth.js
│   │   ├── config.js
│   │   ├── logs.js         # 日志管理
│   │   ├── main.js
│   │   ├── quota.js
│   │   ├── tokens.js
│   │   ├── ui.js
│   │   └── utils.js
│   └── style.css           # 界面样式
├── scripts/
│   ├── build-docker.js     # Docker 构建脚本
│   ├── build.js            # 项目构建脚本
│   ├── oauth-server.js     # OAuth 登录服务
│   └── refresh-tokens.js   # Token 刷新脚本
├── src/
│   ├── api/
│   │   ├── client.js       # API 调用逻辑（含模型列表缓存）
│   │   └── stream_parser.js # 流式响应解析（对象池优化）
│   ├── auth/
│   │   ├── jwt.js          # JWT 认证
│   │   ├── token_manager.js # Token 管理（含轮询策略）
│   │   ├── token_store.js  # Token 文件存储（异步读写）
│   │   └── quota_manager.js # 额度缓存管理
│   ├── bin/
│   │   ├── antigravity_requester_android_arm64   # Android ARM64 TLS 请求器
│   │   ├── antigravity_requester_linux_amd64     # Linux AMD64 TLS 请求器
│   │   └── antigravity_requester_windows_amd64.exe # Windows AMD64 TLS 请求器
│   ├── config/
│   │   ├── config.js       # 配置加载
│   │   └── init-env.js     # 环境变量初始化
│   ├── constants/
│   │   ├── index.js        # 应用常量定义
│   │   └── oauth.js        # OAuth 常量
│   ├── routes/
│   │   ├── admin.js        # 管理接口路由
│   │   ├── claude.js       # Claude 路由
│   │   ├── gemini.js       # Gemini 路由
│   │   ├── openai.js       # OpenAI 路由
│   │   └── sd.js           # SD WebUI 兼容接口
│   ├── server/
│   │   ├── handlers/       # 请求处理器
│   │   │   ├── claude.js
│   │   │   ├── gemini.js
│   │   │   └── openai.js
│   │   ├── index.js        # 主服务器（含内存管理和心跳）
│   │   └── stream.js       # 流式响应处理
│   ├── utils/
│   │   ├── configReloader.js # 配置热重载
│   │   ├── converters/     # 格式转换器
│   │   │   ├── claude.js
│   │   │   ├── common.js
│   │   │   ├── gemini.js
│   │   │   └── openai.js
│   │   ├── deepMerge.js    # 深度合并工具
│   │   ├── envParser.js    # 环境变量解析
│   │   ├── errors.js       # 统一错误处理
│   │   ├── httpClient.js   # HTTP 客户端
│   │   ├── idGenerator.js  # ID 生成器
│   │   ├── imageStorage.js # 图片存储
│   │   ├── ipBlockManager.js # IP 封禁管理
│   │   ├── logger.js       # 日志模块
│   │   ├── memoryManager.js # 智能内存管理
│   │   ├── parameterNormalizer.js # 统一参数处理
│   │   ├── paths.js        # 路径工具（支持 pkg 打包）
│   │   ├── thoughtSignatureCache.js # 签名缓存
│   │   ├── toolConverter.js # 工具定义转换
│   │   ├── toolNameCache.js # 工具名称缓存
│   │   └── utils.js        # 工具函数（重导出）
│   └── AntigravityRequester.js # TLS 指纹请求器封装
├── test/
│   ├── test-request.js     # 请求测试
│   ├── test-image-generation.js # 图片生成测试
│   ├── test-token-rotation.js # Token 轮换测试
│   └── test-transform.js   # 转换测试
├── .env                    # 环境变量配置（敏感信息，自动生成）
├── .env.example            # 环境变量配置示例
├── config.json             # 基础配置文件（自动生成）
├── config.json.example     # 基础配置示例
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

## 多 API 格式支持

本服务支持三种 API 格式，每种格式都有完整的参数支持：

### OpenAI 格式 (`/v1/chat/completions`)

```json
{
  "model": "gemini-2.0-flash-thinking-exp",
  "max_tokens": 16000,
  "temperature": 0.7,
  "top_p": 0.9,
  "top_k": 40,
  "thinking_budget": 10000,
  "reasoning_effort": "high",
  "messages": [...]
}
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `max_tokens` | 最大输出 token 数 | 32000 |
| `temperature` | 温度 (0.0-1.0) | 1 |
| `top_p` | Top-P 采样 | 1 |
| `top_k` | Top-K 采样 | 50 |
| `thinking_budget` | 思考预算 (1024-32000) | 1024 |
| `reasoning_effort` | 思考强度 (`low`/`medium`/`high`) | - |
| `response_format` | 支持响应格式 (`{ "type": "json_object" }`，仅 Gemini 模型支持) | - |

### Claude 格式 (`/v1/messages`)

```json
{
  "model": "claude-sonnet-4-5-thinking",
  "max_tokens": 16000,
  "temperature": 0.7,
  "top_p": 0.9,
  "top_k": 40,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  },
  "messages": [...]
}
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `max_tokens` | 最大输出 token 数 | 32000 |
| `temperature` | 温度 (0.0-1.0) | 1 |
| `top_p` | Top-P 采样 | 1 |
| `top_k` | Top-K 采样 | 50 |
| `thinking.type` | 思考开关 (`enabled`/`disabled`) | - |
| `thinking.budget_tokens` | 思考预算 (1024-32000) | 1024 |

### Gemini 格式 (`/v1beta/models/:model:generateContent`)

```json
{
  "contents": [...],
  "generationConfig": {
    "maxOutputTokens": 16000,
    "temperature": 0.7,
    "topP": 0.9,
    "topK": 40,
    "thinkingConfig": {
      "includeThoughts": true,
      "thinkingBudget": 10000
    }
  }
}
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `maxOutputTokens` | 最大输出 token 数 | 32000 |
| `temperature` | 温度 (0.0-1.0) | 1 |
| `topP` | Top-P 采样 | 1 |
| `topK` | Top-K 采样 | 50 |
| `thinkingConfig.includeThoughts` | 是否包含思考内容 | true |
| `thinkingConfig.thinkingBudget` | 思考预算 (1024-32000) | 1024 |

### 统一参数处理

所有三种格式的参数都会被统一规范化处理，确保一致的行为：

1. **参数优先级**：请求参数 > 配置文件默认值
2. **思考预算优先级**：`thinking_budget`/`budget_tokens`/`thinkingBudget` > `reasoning_effort` > 配置文件默认值
3. **禁用思考**：设置 `thinking_budget=0` 或 `thinking.type="disabled"` 或 `thinkingConfig.includeThoughts=false`

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

### reasoning_effort 映射

| 值 | 思考 Token 预算 |
|---|----------------|
| `low` | 1024 |
| `medium` | 16000 |
| `high` | 32000 |

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
4. **自动内存清理**：堆内存超过阈值时自动触发 GC
5. **进程精简**：移除不必要的子进程，统一在主进程处理

### 动态内存阈值

内存压力阈值根据用户配置的 `memoryThreshold`（MB）动态计算：

| 压力级别 | 阈值比例 | 默认值（100MB 配置） | 行为 |
|---------|---------|---------------------|------|
| LOW | 30% | 30MB | 正常运行 |
| MEDIUM | 60% | 60MB | 轻度清理 |
| HIGH | 100% | 100MB | 积极清理 + GC |
| CRITICAL | >100% | >100MB | 紧急清理 + 强制 GC |

### 配置

```json
{
  "server": {
    "memoryThreshold": 100
  }
}
```

- `memoryThreshold`：高压力阈值（MB），其他级别按比例自动计算

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

## 代码架构

### 转换器模块

项目支持三种 API 格式（OpenAI、Gemini、Claude），转换器代码经过优化，提取了公共模块：

```
src/utils/converters/
├── common.js      # 公共函数（签名处理、消息构建、请求体构建等）
├── openai.js      # OpenAI 格式转换器
├── claude.js      # Claude 格式转换器
└── gemini.js      # Gemini 格式转换器
```

#### 公共函数

| 函数 | 说明 |
|------|------|
| `getSignatureContext()` | 获取思维签名和工具签名 |
| `pushUserMessage()` | 添加用户消息到消息数组 |
| `findFunctionNameById()` | 根据工具调用 ID 查找函数名 |
| `pushFunctionResponse()` | 添加函数响应到消息数组 |
| `createThoughtPart()` | 创建带签名的思维 part |
| `createFunctionCallPart()` | 创建带签名的函数调用 part |
| `processToolName()` | 处理工具名称映射 |
| `pushModelMessage()` | 添加模型消息到消息数组 |
| `buildRequestBody()` | 构建 Antigravity 请求体 |
| `mergeSystemInstruction()` | 合并系统指令 |

### 参数规范化模块

```
src/utils/parameterNormalizer.js  # 统一参数处理
```

将 OpenAI、Claude、Gemini 三种格式的参数统一转换为内部格式：

| 函数 | 说明 |
|------|------|
| `normalizeOpenAIParameters()` | 规范化 OpenAI 格式参数 |
| `normalizeClaudeParameters()` | 规范化 Claude 格式参数 |
| `normalizeGeminiParameters()` | 规范化 Gemini 格式参数 |
| `toGenerationConfig()` | 转换为上游 API 格式 |

### 工具转换模块

```
src/utils/toolConverter.js  # 统一的工具定义转换
```

支持将 OpenAI、Claude、Gemini 三种格式的工具定义转换为 Antigravity 格式。

## 注意事项

1. 首次启动时会自动创建 `.env` 和 `config.json`（如果不存在）
2. 如果未配置凭据，系统会自动生成随机凭据并在启动时显示
3. 运行 `npm run login` 获取 Token
4. `.env`、`config.json` 和 `data/accounts.json` 包含敏感信息，请勿泄露
5. 支持多账号轮换，提高可用性
6. Token 会自动刷新，无需手动维护

## License

MIT
