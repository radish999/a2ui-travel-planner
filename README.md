# 云上旅行 · A2UI 生产版

一个可部署到 Vercel 的 A2UI 1.0 全栈旅行规划器：**DeepSeek 生成内容 + 高德/和风真实数据 + 账号持久化**。

- 服务端调用 DeepSeek（OpenAI 兼容接口），用 `@a2ui/agent` 把模型输出编译、校验成 A2UI wire 消息
- SSE 流式返回文本与 A2UI 消息，React 端用 `@a2ui/react` 渲染成原生交互卡片
- 邮箱密码登录（scrypt 哈希 + httpOnly session cookie），行程按 user_id 隔离
- 数据库：Vercel Postgres 优先，未配置时自动用 `.data/db.json` 本地存储（仅开发用）
- 地图/天气：高德 POI + 和风天气，缺 key 时降级为内置演示数据并在界面明确标注

## 界面设计

面向最终用户，不显示调试信息：工具调用日志、模型模式标签（"在线/演示"）、环境配置状态行都已从界面移除。只有真正的请求失败会提示用户。数据在卡片里以"数据来源：高德地图/和风天气实时查询"一行说明，保持页面干净。

## 输出一致性保护

`lib/agent.ts` 里加了一道防串台校验：模型生成 A2UI 卡片后，会检查卡片里的城市是否和用户请求一致、景点是否逐字来自工具返回数据。一旦发现模型换城市或编造景点/警告，就丢弃该输出，改用工具真实数据重新生成确定性卡片，并在界面提示"已用实时工具数据重新生成"。实测可防止"问大理、答京都"这类幻觉。

## 线上地址

**https://a2ui-travel-planner.vercel.app**

已部署在 Vercel 团队 `radishs-projects-f85d7e47`，项目名 `a2ui-travel-planner`，数据库 `a2ui-travel-db`（Neon Postgres）。线上实测：LLM / 高德 / 和风 / Postgres 四项全部可用，注册登录、真实数据对话、行程持久化全链路通过。

## 本地运行

```bash
npm install
cp .env.example .env.local   # 已填好 DeepSeek key；补齐其他项见下
npm run dev                  # http://localhost:3000
```

生产构建：`npm run build && npm run start`。

## 环境变量（`.env.local`）

| 变量 | 状态 | 说明 |
| --- | --- | --- |
| `LLM_API_KEY` | 已配置 | 复用你昨天的 DeepSeek key |
| `LLM_BASE_URL` | 已配置 | `https://api.deepseek.com` |
| `LLM_MODEL` | 已配置 | `deepseek-flash`（也验证过 `deepseek-chat` 可用） |
| `LLM_THINKING` | 已配置 | `disabled`，关闭深度思考以加快响应 |
| `AMAP_KEY` | 已配置 | Web服务类型 Key，已验证可返回实时 POI |
| `QWEATHER_KEY` | 已配置 | 和风天气 key |
| `QWEATHER_HOST` | 已配置 | 账号专属 API Host（形如 `xxxxxx.re.qweatherapi.com`），在 https://console.qweather.com/setting 查看 |
| `POSTGRES_URL` | 已配置 | Vercel Neon Postgres（数据库 `a2ui-travel-db`），连接串由集成自动注入 |
| `AUTH_SECRET` | 建议配置 | 会话签名用；当前用 cookie token 直接查库，生产建议加一层 HMAC |

### 高德地图

已配置 Web服务类型的 Key，实测 `/v3/place/text` 返回实时 POI。注意区分：Web端（JS API）Key 无法用于服务端 REST，会返回 `USERKEY_PLAT_NOMATCH`；安全密钥也只在 Web端用得到。

### 和风天气

已配置 `QWEATHER_KEY` 和账号专属 `QWEATHER_HOST`，实测实时天气接口返回 200。

这个 key 未开通 GeoAPI（城市查找接口返回 404），所以天气查询走两级坐标解析：
1. `CITY_COORDS` 内置常用城市坐标（快，少一次网络请求）
2. 不在表里的城市（如周口）用**高德地理编码 `/v3/geocode/geo`** 动态解析城市名 → 经纬度，再查和风实况

这样覆盖全国城市，不再受内置表限制。和风每个账号的专属 Host 在 https://console.qweather.com/setting 查看。

**已知局限**：
- 只支持中国城市的地理编码（高德 Web服务 key 的限制）；海外城市（如京都）天气走内置表，表外的海外城市会降级为演示数据
- 只查当前实况，不提供未来几天的预报（和风 `/v7/weather/now` 接口范围）
- 无国家级以下精细区域（区县/街道）的保证，地理编码 level 为「市」最可靠

## 部署到 Vercel

1. 代码推到 GitHub，Vercel 导入仓库（框架自动识别为 Next.js）
2. Environment Variables 里逐项填入上面的环境变量
3. 创建数据库：Vercel 控制台 → Storage → Create Database → Postgres（现在底层是 Neon），创建后 `POSTGRES_URL` 会自动注入
4. 首次部署后，数据库表会在第一次请求时自动创建（`lib/db.ts` 的 `initDb`）
5. 本地想用线上数据库：`vercel env pull .env.local`

注意：免费 Hobby 计划的函数超时为 5 分钟，本应用单次请求通常 10~30 秒，足够。DeepSeek 的 key 只存在服务端环境变量，不会下发到浏览器。

## 验证过的链路

- `npm run build` 通过（Next.js 16 + React 19）
- 注册 / 登录 / 会话 / 未登录访问 API 返回 401
- 真实 DeepSeek 调用 + 工具调用（searchAttractions / getWeather）
- `@a2ui/agent` 编译模型输出为合法 v1.0 消息（0 条被客户端拒绝）
- 行程保存 / 列出 / 删除，按用户隔离
- 无头浏览器确认首页与登录入口渲染正常

## 安全说明

- Agent 输出走官方 SDK catalog 校验，模型只能使用已注册的组件与 action
- 密码用 `crypto.scryptSync` 加盐哈希；session token 32 字节随机，存库并设 httpOnly cookie
- 所有行程查询都带 `user_id` 条件；删除操作同样校验归属
- 生产环境建议：给 `AUTH_SECRET` 配置随机值并对 cookie 做 HMAC 签名、加 CSP、对 action 参数做业务鉴权
