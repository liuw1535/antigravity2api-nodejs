# CLI 凭证中的 Project ID 与额度获取机制说明

> 本文档是**给另一个程序中的 LLM 直接使用**的技术说明。
>
> 目标不是解释某个仓库的源码，而是把“**如何获取 CLI OAuth 凭证中的 Project ID**”以及“**如何获取额度（quota）**”抽象成一套可复刻的实现方案。
>
> 因此本文档：
>
> - **不依赖源码上下文**
> - **不要求读取原项目文件**
> - **直接描述协议、流程、字段和实现策略**
> - 适合作为其他程序实现相同能力时的参考输入

---

## 1. 目标

需要解决两个问题：

1. **如何从 Google OAuth 登录后的 CLI 凭证中拿到可用的 `project_id`**
2. **如何查询该凭证对应的模型额度 / 配额信息（quota）**

这两个问题的关键点是：

- OAuth 本身通常只给你：
  - `access_token`
  - `refresh_token`
  - 过期时间
- **`project_id` 往往不是 OAuth 回调里直接返回的字段**
- `project_id` 需要在 OAuth 完成后，再调用额外接口获得
- quota 也不是本地算出来的，而是要通过服务端接口返回的模型元信息中提取

---

## 2. 先说结论

如果你要复刻该能力，核心思路如下：

### 获取 `project_id`

完整流程通常是：

1. 用户完成 Google OAuth
2. 得到 `access_token` 和 `refresh_token`
3. 用 `access_token` 调用内部接口：
   - `loadCodeAssist`
4. 如果 `loadCodeAssist` 没有返回 `project_id`
   - 再调用 `onboardUser`
5. 如果仍失败
   - 回退到 Google Cloud 项目列表接口
   - 自动选项目，或要求用户手工选择
6. 最终把拿到的 `project_id` 存入凭证

### 获取 quota

1. 准备一个可用的 Antigravity / 对应服务的 `access_token`
2. 调用：
   - `fetchAvailableModels`
3. 从每个模型返回的 `quotaInfo` 中提取：
   - 剩余额度比例
   - 重置时间

一句话概括：

- **Project ID 是 OAuth 后通过附加接口查出来或创建出来的**
- **Quota 是通过模型列表接口里的 `quotaInfo` 提取出来的**

---

## 3. 推荐的数据结构

建议把凭证保存成统一结构，至少包含以下字段：

```json
{
  "client_id": "...",
  "client_secret": "...",
  "token": "access_token_value",
  "access_token": "access_token_value",
  "refresh_token": "refresh_token_value",
  "scopes": ["..."],
  "token_uri": "https://oauth2.googleapis.com/token",
  "project_id": "your-project-id-or-resource-name",
  "expiry": "2026-03-30T17:00:00+00:00"
}
```

建议说明：

- `token` 和 `access_token` 最好同时兼容保存
- `refresh_token` 必须保留，否则后续无法自动刷新
- `project_id` 是后续调用 CLI 接口的关键字段
- `expiry` 建议保存为 ISO 8601 UTC 时间字符串

同时建议单独维护一份**运行状态**：

```json
{
  "disabled": false,
  "error_codes": [],
  "last_success": 1711111111,
  "user_email": null,
  "tier": "pro",
  "preview": true,
  "model_cooldowns": {}
}
```

用途：

- 控制凭证启用/禁用
- 记录错误和冷却信息
- 记录订阅等级
- 标记某些能力是否支持

---

## 4. OAuth 阶段应该怎么做

### 4.1 目标

先拿到：

- `access_token`
- `refresh_token`
- `expires_in`

### 4.2 授权 URL 的关键参数

OAuth 授权 URL 建议包含：

- `client_id`
- `redirect_uri`
- `scope`
- `response_type=code`
- `access_type=offline`
- `prompt=consent`
- `include_granted_scopes=true`
- `state=<random_state>`

其中最关键的是：

- `access_type=offline`：确保拿到 `refresh_token`
- `prompt=consent`：提高返回 refresh token 的概率

### 4.3 用授权码换 token

回调拿到 `code` 后，向 Google token 接口发起请求：

`POST https://oauth2.googleapis.com/token`

请求参数：

```x-www-form-urlencoded
client_id=...
client_secret=...
redirect_uri=...
code=...
grant_type=authorization_code
```

预期响应：

```json
{
  "access_token": "ya29....",
  "expires_in": 3599,
  "refresh_token": "1//0g....",
  "scope": "...",
  "token_type": "Bearer"
}
```

拿到后应立即标准化为内部凭证对象。

---

## 5. `project_id` 不是 OAuth 直接给的

这是最重要的认知点。

### 本质

Google OAuth 登录成功后，你只拿到了“用户身份”和“访问能力”，**还没有拿到业务调用所需的 CLI 项目上下文**。

因此必须继续调用额外接口，为当前用户确定：

- 当前 CLI 该绑定哪个项目
- 当前用户属于什么 tier
- 如果还没初始化，是否需要先做 onboarding

换句话说：

- OAuth 给的是“通行证”
- `project_id` 是“业务环境上下文”

---

## 6. 获取 `project_id` 的推荐流程

## 6.1 第一优先：调用 `loadCodeAssist`

使用 OAuth 得到的 `access_token` 调用：

```http
POST {api_base_url}/v1internal:loadCodeAssist
Authorization: Bearer <access_token>
User-Agent: <对应 CLI 的 User-Agent>
Content-Type: application/json
Accept-Encoding: gzip
```

请求体建议：

```json
{
  "metadata": {
    "ideType": "ANTIGRAVITY"
  }
}
```

说明：

- 不同客户端可能会额外带：
  - `platform`
  - `pluginType`
- 但最核心的是 Bearer token 和匹配的 User-Agent

### 成功时重点提取的字段

如果返回成功，重点关注：

```json
{
  "cloudaicompanionProject": "projects/xxx-or-project-id",
  "currentTier": {
    "id": "standard-tier"
  },
  "paidTier": {
    "id": "g1-ultra-tier"
  },
  "allowedTiers": [...]
}
```

从中提取：

- `cloudaicompanionProject` → 作为 `project_id`
- `paidTier.id` 或 `currentTier.id` → 作为 tier 原始值

### 推荐 tier 映射

可以做如下统一映射：

| 原始 tier                   | 统一 tier |
| --------------------------- | --------- |
| `g1-ultra-tier`             | `ultra`   |
| `ws-ai-ultra-business-tier` | `ultra`   |
| `g1-pro-tier`               | `pro`     |
| `helium-tier`               | `pro`     |
| `standard-tier`             | `pro`     |
| `free-tier`                 | `free`    |
| 其他未知值                  | `pro`     |

### `loadCodeAssist` 的结果分两种情况

#### 情况 A：已经激活

如果响应中存在：

- `currentTier`
- 同时有 `cloudaicompanionProject`

则说明该用户已经完成初始化，可以直接拿到：

- `project_id`
- `subscription_tier`

#### 情况 B：尚未激活

如果响应中：

- 没有 `currentTier`
- 或者没有 `cloudaicompanionProject`

就说明还不能直接使用，需要进入 onboarding 流程。

---

## 6.2 第二优先：调用 `onboardUser`

如果 `loadCodeAssist` 没返回 `project_id`，下一步是调用：

```http
POST {api_base_url}/v1internal:onboardUser
Authorization: Bearer <access_token>
User-Agent: <对应 CLI 的 User-Agent>
Content-Type: application/json
```

### 请求前先确定 tier

推荐先再次调用 `loadCodeAssist`，从其中的 `allowedTiers` 里选默认 tier：

示例：

```json
{
  "allowedTiers": [
    {"id": "FREE", "isDefault": false},
    {"id": "LEGACY", "isDefault": true}
  ]
}
```

选择逻辑：

1. 找 `isDefault=true` 的 tier
2. 如果没有，就回退成 `LEGACY`

### `onboardUser` 请求体示例

```json
{
  "tierId": "LEGACY",
  "metadata": {
    "ideType": "ANTIGRAVITY",
    "platform": "PLATFORM_UNSPECIFIED",
    "pluginType": "GEMINI"
  }
}
```

### `onboardUser` 可能是长任务

这个接口常见表现不是一次就完成，而是**长时间运行操作**。

返回可能类似：

```json
{
  "done": false
}
```

或者：

```json
{
  "done": true,
  "response": {
    "cloudaicompanionProject": {
      "id": "projects/xxx"
    }
  }
}
```

因此建议：

- 轮询最多 5 次
- 每次间隔 2 秒
- 最长等待约 10 秒

### 成功时提取字段

从以下任一结构中读取：

- `response.cloudaicompanionProject.id`
- `response.cloudaicompanionProject`（如果它直接是字符串）

拿到后保存为最终 `project_id`。

---

## 6.3 第三优先：回退到 Google Cloud 项目列表

如果前两步都失败，不代表凭证完全不可用，也可能只是内部接口未返回项目信息。

这时建议调用 Google Cloud Resource Manager：

```http
GET https://cloudresourcemanager.googleapis.com/v1/projects
Authorization: Bearer <access_token>
User-Agent: <CLI User-Agent>
```

从响应中筛选：

- `lifecycleState == "ACTIVE"`

并提取：

- `projectId`
- `displayName`
- `projectNumber`

### 自动选择策略

建议按如下顺序选择：

1. 如果只有一个项目 → 直接使用
2. 如果多个项目中存在名称或 ID 包含 `default` → 优先用它
3. 否则使用第一个项目
4. 如果不希望自动选择 → 把项目列表返回给上层，由用户手选

### 如果仍然失败

此时应明确返回：

- 需要用户手工输入 `project_id`

---

## 7. `project_id` 保存后如何使用

后续在真正调用 CLI 业务接口时，通常请求体里必须包含 `project` 字段。

典型请求形式：

```http
POST {code_assist_endpoint}/v1internal:streamGenerateContent?alt=sse
Authorization: Bearer <access_token>
Content-Type: application/json
User-Agent: <CLI User-Agent>
```

请求体：

```json
{
  "model": "gemini-2.5-pro",
  "project": "your_project_id",
  "request": {
    "contents": [...]
  }
}
```

这说明：

- `access_token` 用于身份认证
- `project_id` 用于指定业务上下文

如果没有 `project_id`，很多 CLI 内部接口调用会直接失败。

因此建议把它视为**必填上下文字段**，不是可选元数据。

---

## 8. token 刷新机制必须做

因为这是长期运行系统，不能只依赖首次 OAuth 拿到的 access token。

## 8.1 刷新时机建议

满足任一条件时刷新：

- 没有 `access_token`
- 没有 `expiry`
- 距离过期不足 5 分钟

## 8.2 刷新请求

使用 refresh token 调用：

`POST https://oauth2.googleapis.com/token`

请求参数：

```x-www-form-urlencoded
client_id=...
client_secret=...
refresh_token=...
grant_type=refresh_token
```

成功响应示例：

```json
{
  "access_token": "ya29....",
  "expires_in": 3599,
  "token_type": "Bearer"
}
```

刷新成功后应更新：

- `access_token`
- `token`
- `expiry`

并立即回写凭证存储。

## 8.3 失败分类建议

### 认为是永久失效的情况

符合以下任一条件，可视为凭证永久失效：

- HTTP `400`
- HTTP `401`
- HTTP `403`
- 错误文本包含：
  - `invalid_grant`
  - `refresh_token_expired`
  - `invalid_refresh_token`
  - `unauthorized_client`
  - `access_denied`

处理建议：

- 将凭证标记为 `disabled=true`
- 记录错误码
- 后续不再优先使用

### 认为是临时失败的情况

以下通常不应直接封禁凭证：

- HTTP `429`
- HTTP `500`
- HTTP `502`
- HTTP `503`
- HTTP `504`
- 网络异常 / 超时

处理建议：

- 保持凭证启用
- 做重试或冷却

---

## 9. quota 是怎么拿到的

这里说的 quota，通常是**模型可用额度**，不是传统云账单余额。

## 9.1 推荐接口

使用：

```http
POST {antigravity_url}/v1internal:fetchAvailableModels
Authorization: Bearer <access_token>
User-Agent: antigravity/...
Content-Type: application/json
Accept-Encoding: gzip
requestId: req-<uuid>
```

请求体可以为空：

```json
{}
```

## 9.2 为什么这个接口能拿 quota

因为该接口不仅返回可用模型列表，还会在每个模型对象里附带 quota 元信息。

典型结构类似：

```json
{
  "models": {
    "gemini-2.5-pro": {
      "quotaInfo": {
        "remainingFraction": 0.95,
        "resetTime": "2025-12-20T02:30:00Z"
      }
    },
    "claude-sonnet-4-6": {
      "quotaInfo": {
        "remainingFraction": 0.20,
        "resetTime": "2025-12-20T03:00:00Z"
      }
    }
  }
}
```

## 9.3 应提取哪些字段

对每个模型提取：

- `remainingFraction` → 剩余额度比例
- `resetTime` → 配额重置时间

建议整理为：

```json
{
  "success": true,
  "models": {
    "gemini-2.5-pro": {
      "remaining": 0.95,
      "resetTime": "12-20 10:30",
      "resetTimeRaw": "2025-12-20T02:30:00Z"
    }
  }
}
```

说明：

- `remaining`：建议直接保留 0~1 的比例值
- `resetTimeRaw`：保留原始 UTC 时间字符串
- `resetTime`：为了 UI 展示，转成本地时间字符串

## 9.4 时间转换建议

如果面向中国用户，建议把 `resetTimeRaw` 转成北京时间：

- 解析 UTC 时间
- 加 `8` 小时
- 格式化为：`MM-DD HH:mm`

但同时**必须保留原始时间**，方便别的程序自己决定时区处理方式。

---

## 10. quota 查询前必须先确保 token 有效

不要直接拿本地保存的 token 就查 quota。

正确顺序应该是：

1. 从存储加载凭证
2. 检查是否过期
3. 如有需要先刷新 token
4. 如果 token 刷新了，回写存储
5. 再调用 quota 接口

否则会出现：

- 本地凭证看起来存在
- 实际请求却因 access token 失效而失败

---

## 11. 运行期如何选择“可用凭证”

如果系统维护多个凭证，建议采用以下策略：

### 11.1 选择规则

每次请求前，从凭证池中选一个：

- 未禁用
- 未处于冷却中
- token 可刷新或仍有效
- 符合模型约束（如 preview / 非 preview）

### 11.2 建议流程

1. 随机或轮询选一个候选凭证
2. 检查 token 是否需要刷新
3. 刷新成功则继续使用
4. 刷新失败且属于永久错误，则禁用该凭证
5. 换下一个凭证重试

### 11.3 模型级冷却

如果请求失败时返回：

- `429` quota exhausted
- `503` temporary unavailable

建议从错误响应中解析出冷却结束时间，并只对：

- 当前凭证
- 当前模型

设置冷却，而不是把整个凭证永久封禁。

这样会更符合真实使用场景。

---

## 12. 推荐给 LLM 的实现顺序

如果你希望另一个 LLM 直接据此写代码，建议它按下面顺序实现。

## 第一步：实现 OAuth 登录

实现能力：

- 生成授权 URL
- 接收回调 code
- code 换 token
- 存储凭证

输出：

- `access_token`
- `refresh_token`
- `expiry`

## 第二步：实现 `project_id` 自动发现

实现能力：

1. `loadCodeAssist`
2. `onboardUser`
3. 项目列表回退
4. tier 解析
5. 凭证回写

输出：

- `project_id`
- `subscription_tier`

## 第三步：实现 token 自动刷新

实现能力：

- 根据过期时间刷新
- 刷新成功后回写存储
- 区分永久失败和临时失败

## 第四步：实现业务请求

实现能力：

- 读取可用凭证
- 自动刷新 token
- 把 `project_id` 注入请求体
- 处理 429 / 503 / 403

## 第五步：实现 quota 查询

实现能力：

- 调 `fetchAvailableModels`
- 解析每个模型的 `quotaInfo`
- 输出统一 quota 结构

---

## 13. 可直接复刻的伪代码

## 13.1 获取 `project_id`

```python
async def get_project_id_from_oauth_credential(access_token, api_base_url, user_agent):
    headers = {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": user_agent,
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip",
    }

    # Step 1: try loadCodeAssist
    resp = await post(
        f"{api_base_url}/v1internal:loadCodeAssist",
        json={"metadata": {"ideType": "ANTIGRAVITY"}},
        headers=headers,
    )

    if resp.status_code == 200:
        data = resp.json()
        project_id = data.get("cloudaicompanionProject")
        tier = map_tier(
            (data.get("paidTier") or {}).get("id")
            or (data.get("currentTier") or {}).get("id")
        )
        if project_id:
            return project_id, tier

    # Step 2: try onboardUser
    tier_id = await get_default_onboard_tier(api_base_url, headers)
    for _ in range(5):
        resp = await post(
            f"{api_base_url}/v1internal:onboardUser",
            json={
                "tierId": tier_id or "LEGACY",
                "metadata": {
                    "ideType": "ANTIGRAVITY",
                    "platform": "PLATFORM_UNSPECIFIED",
                    "pluginType": "GEMINI",
                },
            },
            headers=headers,
        )
        if resp.status_code == 200:
            data = resp.json()
            if data.get("done"):
                obj = (data.get("response") or {}).get("cloudaicompanionProject")
                if isinstance(obj, dict):
                    return obj.get("id"), None
                if isinstance(obj, str):
                    return obj, None
        await sleep(2)

    # Step 3: fallback to cloud project list
    projects = await list_google_cloud_projects(access_token, user_agent)
    if len(projects) == 1:
        return projects[0]["projectId"], None
    if len(projects) > 1:
        return choose_default_project(projects), None

    return None, None
```

## 13.2 获取 quota

```python
async def fetch_quota_info(access_token, antigravity_url, user_agent):
    headers = {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": user_agent,
        "Content-Type": "application/json",
        "Accept-Encoding": "gzip",
        "requestId": generate_request_id(),
    }

    resp = await post(
        f"{antigravity_url}/v1internal:fetchAvailableModels",
        json={},
        headers=headers,
    )

    if resp.status_code != 200:
        return {"success": False, "error": f"HTTP {resp.status_code}"}

    data = resp.json()
    result = {}

    for model_name, model_data in (data.get("models") or {}).items():
        quota = (model_data or {}).get("quotaInfo") or {}
        result[model_name] = {
            "remaining": quota.get("remainingFraction", 0),
            "resetTimeRaw": quota.get("resetTime", ""),
            "resetTime": format_to_local_time(quota.get("resetTime", "")),
        }

    return {"success": True, "models": result}
```

---

## 14. 另一个 LLM 最容易踩的坑

如果把本文档发给另一个 LLM，最需要提醒它避免以下错误：

### 坑 1：误以为 OAuth 响应里直接有 `project_id`

通常没有。

必须继续调用：

- `loadCodeAssist`
- `onboardUser`
- 或项目列表接口

### 坑 2：只保存 access token，不保存 refresh token

这样系统一小时左右就失效。

### 坑 3：拿到 token 后不做刷新逻辑

长期运行系统一定会出问题。

### 坑 4：把 429 当成永久失效

429 更适合冷却 / 重试，不适合直接永久封禁凭证。

### 坑 5：quota 当成本地统计值

本文中的 quota 不是本地统计，而是接口返回的模型级额度信息。

### 坑 6：不保留原始 UTC 时间

只保存本地格式字符串会让后续跨时区处理变麻烦。

### 坑 7：缺失 `project` 字段就直接发业务请求

很多 CLI 接口要求请求体里必须有 `project`。

---

## 15. 建议输出给其他程序的标准接口

如果你在别的系统中封装，建议至少提供以下函数。

### `exchange_oauth_code(code) -> credential`

输入：

- `code`

输出：

- `access_token`
- `refresh_token`
- `expiry`

### `resolve_project_id(credential) -> {project_id, tier}`

输入：

- OAuth 凭证

输出：

- `project_id`
- `tier`

### `refresh_credential_if_needed(credential) -> credential`

输入：

- 当前凭证

输出：

- 刷新后的凭证

### `call_cli_api(credential, model, request) -> response`

输入：

- 凭证
- 模型名
- 请求内容

要求内部自动：

- 刷新 token
- 注入 `project`
- 处理重试

### `fetch_model_quota(credential) -> quota_info`

输入：

- 凭证

输出：

- 每个模型的 quota 信息

---

## 16. 最终总结

要复刻“CLI 凭证中的项目 ID 与额度获取”机制，正确理解应该是：

### 项目 ID 获取

不是从 OAuth 结果里直接读，而是：

1. 先 OAuth 拿 token
2. 调 `loadCodeAssist` 获取 `cloudaicompanionProject`
3. 不行就调 `onboardUser`
4. 再不行就退回 Google Cloud 项目列表
5. 最终把结果写回凭证

### quota 获取

不是本地计算，而是：

1. 用有效 access token 调 `fetchAvailableModels`
2. 从每个模型的 `quotaInfo` 读取：
   - `remainingFraction`
   - `resetTime`
3. 转换成统一输出结构

### 运行稳定性

想让系统长期可用，必须补齐：

- refresh token 刷新
- 永久错误与临时错误区分
- 冷却与重试
- 多凭证调度
- `project_id` 持久化

如果另一个 LLM 需要据此直接写实现，优先让它完成以下 4 个能力：

1. OAuth code exchange
2. `project_id` resolve
3. token refresh
4. quota fetch

只要这四块实现正确，整个方案就能跑起来。
