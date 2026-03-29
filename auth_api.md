# Auth API 文档

本文档说明管理后台中与 OAuth 授权相关的 API 接口，用于获取授权链接以及提交授权码完成登录 / Token 交换。

## 1. 适用范围

当前支持两种模式：

- `antigravity`
- `geminicli`

所有接口均位于管理后台路由下，支持以下两种鉴权方式之一：

- 已登录后台，自动携带 Cookie
- 直接传管理员密码 `password`

---

## 2. 获取授权链接

### 接口

`GET /admin/oauth/url`

### Query 参数

| 参数       | 类型   | 必填 | 说明                                             |
| ---------- | ------ | ---: | ------------------------------------------------ |
| `mode`     | string |   否 | `antigravity` 或 `geminicli`，默认 `antigravity` |
| `count`    | number |   否 | 返回授权链接数量，范围 `1~100`，默认 `1`         |
| `password` | string |   否 | 未携带后台 Cookie 时，可直接传管理员密码进行调用 |

### 示例

```http
GET /admin/oauth/url?mode=geminicli&count=2&password=your-admin-password
```

### 返回示例

```json
{
  "success": true,
  "data": {
    "mode": "geminicli",
    "count": 2,
    "urls": [
      {
        "port": 53120,
        "url": "https://accounts.google.com/o/oauth2/v2/auth?..."
      },
      {
        "port": 53121,
        "url": "https://accounts.google.com/o/oauth2/v2/auth?..."
      }
    ],
    "submit": {
      "method": "POST",
      "url": "/admin/oauth/exchange",
      "contentType": "application/json",
      "body": {
        "code": "从回调URL中提取的code",
        "port": "回调URL中的本地端口",
        "mode": "geminicli",
        "password": "可选，未携带Cookie时可直接传管理员密码"
      }
    }
  }
}
```

### 说明

- 接口会随机生成本地回调端口
- 每条授权链接都与一个本地 `port` 对应
- 返回中的 `submit` 字段用于指导后续如何提交授权码

---

## 3. 提交授权码并交换 Token

### 接口

`POST /admin/oauth/exchange`

### 请求头

```http
Content-Type: application/json
```

### 请求体

| 字段          | 类型   | 必填 | 说明                                             |
| ------------- | ------ | ---: | ------------------------------------------------ |
| `code`        | string |   是 | Google OAuth 回调地址中的授权码                  |
| `port`        | number |   是 | 回调地址中的本地端口                             |
| `mode`        | string |   否 | `antigravity` 或 `geminicli`，默认 `antigravity` |
| `password`    | string |   否 | 未携带后台 Cookie 时，可直接传管理员密码进行调用 |
| `callbackUrl` | string |   否 | 完整回调 URL；提供后可自动解析 `code` 与 `port`  |

### 示例

```json
{
  "code": "4/0AQSTgQ...",
  "port": 53120,
  "mode": "antigravity",
  "password": "your-admin-password"
}
```

### 使用完整回调 URL 的示例

```json
{
  "callbackUrl": "http://localhost:53120/oauth-callback?code=4/0AQSTgQ...&scope=...",
  "mode": "antigravity",
  "password": "your-admin-password"
}
```

说明：

- 当提供 [`callbackUrl`](auth_api.md) 时，服务端会自动解析出 `code` 与 `port`
- 如果同时传了 `code` / `port`，则优先使用显式传入值

### Antigravity 返回示例

```json
{
  "success": true,
  "data": {
    "access_token": "...",
    "refresh_token": "...",
    "expires_in": 3600,
    "email": "user@example.com",
    "projectId": "project-id",
    "hasQuota": true,
    "enable": true
  },
  "message": "Token添加成功",
  "fallbackMode": false
}
```

### Gemini CLI 返回示例

```json
{
  "success": true,
  "data": {
    "access_token": "...",
    "refresh_token": "...",
    "expires_in": 3600,
    "email": "user@example.com",
    "enable": true
  },
  "message": "Gemini CLI Token添加成功"
}
```

---

## 4. 使用流程建议

### 普通流程

1. 调用 `GET /admin/oauth/url`
2. 打开返回的授权链接
3. 完成 Google 登录与授权
4. 从回调 URL 中提取 `code` 和 `port`
5. 调用 `POST /admin/oauth/exchange`
6. 将返回的账号信息保存到对应 Token 列表

### 批量流程

1. 调用 `GET /admin/oauth/url?count=N`
2. 依次打开多条授权链接
3. 收集多条回调 URL
4. 逐条提取 `code` 与 `port`
5. 多次调用 `POST /admin/oauth/exchange`

---

## 5. 错误说明

### 常见错误

#### 缺少参数

```json
{
  "success": false,
  "message": "code和port必填"
}
```

#### OAuth 认证失败

```json
{
  "success": false,
  "message": "具体错误信息"
}
```

#### 未登录后台

接口会因未通过后台认证，且 `password` 未提供或错误，而返回 `401`。

---

## 6. 相关实现位置

- OAuth URL 接口：`src/routes/admin.js`
- OAuth 授权码交换接口：`src/routes/admin.js`
- 授权 URL 生成逻辑：`src/auth/oauth_manager.js`
- 前端普通 OAuth：`public/js/auth.js`
- 前端 Gemini CLI OAuth：`public/js/geminicli.js`
