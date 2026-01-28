这样，你帮我做一个实现计划，按以下几个milestone来，告诉我都需要怎么做。1. 实现transcript和会话持久化，使用你建议的 Cloudflare 架构。 2. twillio conference怎么用？如果使用，项目该如何更改。 3. 前端网页该如何做？ 

你的计划会被丢给codex来执行，请你好好写
--------------------
下面是一份**可直接丢给 Codex 执行**的实现计划，按你要求的 3 个 milestone 拆分，每个里都给出：目标、改动点、需要新增的模块/文件、接口契约、部署与验收标准。

我会以你 repo 当前形态为基线：它已经是一个 Express 服务，负责接收 OpenAI SIP connector webhook（`/openai/webhook`）、调用 `/v1/realtime/calls/{call_id}/accept` 并连接 `wss://api.openai.com/v1/realtime?call_id=...` 监听 transcript，并可选推 Discord webhook。([GitHub][1])

---

# Milestone 1 — Transcript + 会话持久化（Cloudflare：D1 + Durable Objects + Worker API）

## 1. 目标与边界

**目标**

* 把每次通话（call session）的元数据持久化：call_id、开始/结束时间、From/To、状态、（如有）conferenceName/call_token 等。
* 把 transcript 按“句子/片段”持久化（append-only），并能分页查询。
* 对 live call：网页能实时订阅 transcript 更新（WebSocket），并在 call 结束后可回放历史。

**边界**

* 本 milestone **不改你的 SIP 呼入链路**（仍由现有 Express 服务接 webhook + 接通 + 监听 WS）。
* Cloudflare 只作为：**存储 + 实时分发 API**。你的 Express 服务把 transcript/事件“转发”到 Cloudflare。

> 这样改动最小，风险最低，且为后续网页与 WebRTC 打地基。

---

## 2. Cloudflare 侧资源与定价选择（为什么这样选）

* **D1**：用作历史数据库（列表/查询/分页极友好）。D1 按 rows read / rows written / 存储计费，Paid 包含量很大，并强调用索引减少 rows read。([Cloudflare Docs][2])
* **Durable Objects（DO）**：每个 live call 一个 DO，承载 WebSocket fan-out；DO 原生 WebSocket API 支持 hibernation，可降低“空闲连接”duration 成本。([Cloudflare Docs][3])
* **Worker API**：对外提供 REST + WebSocket 入口；对内提供 ingest 接口给你的 Express 服务调用。

---

## 3. 代码结构建议（在你 repo 内新增一个 `cf/` 子项目）

在现 repo 新增目录：

```
/cf
  /src
    index.ts              # Worker入口：REST + websocket route
    callRoom.ts           # Durable Object：每call_id一个实例
    auth.ts               # 简单鉴权
    db.ts                 # D1 helpers
    types.ts              # 接口类型
  /migrations
    0001_init.sql
  wrangler.toml
  package.json
```

> Codex 执行时：直接 `npm create cloudflare@latest` 生成 Worker 模板也行，再把上面文件融合进去。

---

## 4. D1 Schema（必须按查询模式建索引，否则 rows_read 爆）

D1 计费里明确：rows read 是“扫描的行数”，无索引过滤会导致扫描更多行；并且索引能显著减少 rows read。([Cloudflare Docs][2])

### 4.1 `calls` 表

字段建议：

* `call_id TEXT PRIMARY KEY`
* `status TEXT NOT NULL`（`incoming|live|ended|failed`）
* `started_at INTEGER`（unix seconds）
* `ended_at INTEGER`
* `from_uri TEXT`、`to_uri TEXT`
* `conference_name TEXT`（可空）
* `call_token TEXT`（可空）
* `provider TEXT`（`twilio|wavix|other` 可空）
* `created_at INTEGER NOT NULL`
* `updated_at INTEGER NOT NULL`

索引：

* `INDEX calls_status_started ON calls(status, started_at DESC)`
* `INDEX calls_updated ON calls(updated_at DESC)`

### 4.2 `transcript_segments` 表（append-only）

字段建议：

* `call_id TEXT NOT NULL`
* `seq INTEGER NOT NULL`（每通话单调递增）
* `ts INTEGER NOT NULL`（unix ms 或 s）
* `speaker TEXT NOT NULL`（`caller|agent|system|tool`）
* `text TEXT NOT NULL`
* `raw_json TEXT`（可选：保存 OpenAI 原始事件片段）

约束/索引：

* `PRIMARY KEY (call_id, seq)`（用于幂等写入）
* `INDEX seg_call_seq ON transcript_segments(call_id, seq)`
* `INDEX seg_call_ts ON transcript_segments(call_id, ts)`

---

## 5. Cloudflare Worker API 设计（给网页 + 给 ingest）

### 5.1 内部 ingest（给你的 Express 服务调用）

鉴权：**共享 bearer token**（MVP），Worker 用 `wrangler secret put INGEST_TOKEN` 保存。

* `POST /ingest/call`

  * body:

    ```json
    { "event":"start|end|status",
      "call_id":"rtc_...",
      "status":"incoming|live|ended|failed",
      "ts":1730000000,
      "from_uri":"sip:...",
      "to_uri":"sip:...",
      "conference_name":"CFxxxx/CallSid",
      "call_token":"...",
      "meta":{...}
    }
    ```
  * 行为：

    * `calls` 表 UPSERT（按 call_id）
    * 若 `event=end` 同步 `ended_at/status`
    * 若 `event=start` 填充 `started_at/status`

* `POST /ingest/transcript`

  * body:

    ```json
    { "call_id":"rtc_...",
      "seq":123,
      "ts":1730000000123,
      "speaker":"caller|agent",
      "text":"...",
      "raw":{...}
    }
    ```
  * 行为：

    * `INSERT OR IGNORE` 写入 D1（依赖 `(call_id, seq)` 幂等）
    * 触发广播：把该消息转发到对应 DO（`CallRoom(call_id)`）给在线网页

> 你的 repo README 说目前是“每个 completed sentence 发 Discord webhook”，这正好对应 `seq` 一条一条写入。([GitHub][1])

### 5.2 对外查询（给网页）

* `GET /api/calls?status=live|ended&limit=50&cursor=...`

  * 返回列表 + 游标
* `GET /api/calls/:call_id`
* `GET /api/calls/:call_id/transcript?after_seq=...&limit=...`

  * 用 `(call_id, seq)` 索引分页

### 5.3 WebSocket（给网页实时订阅）

* `GET /ws/calls/:call_id`（升级到 WebSocket）

  * 内部路由到 `CallRoom` Durable Object 实例

---

## 6. Durable Object：`CallRoom(call_id)` 的职责

DO WebSocket 推荐用 Native DO WebSocket API（支持 hibernation）。([Cloudflare Docs][3])

**职责**

* 维护所有订阅该 call_id 的 WebSocket 客户端
* 缓存最近 N 条 transcript（例如 200 条），新用户连上先补齐再推实时
* 可选：推送 call status 变更（live→ended）

**关键实现点**

* 构造函数恢复 hibernation 后的 ws：按文档用 `this.ctx.getWebSockets()` + `serializeAttachment/deserializeAttachment` 维护连接元数据。([Cloudflare Docs][3])
* 广播只需要处理“入站消息”，出站不计费（成本友好；并且 DO hibernating 时不计 duration）。([The Cloudflare Blog][4])

---

## 7. 你的 Express 服务需要做的改动（最少改动）

在现 repo（Express）里新增：

* 环境变量：

  * `CF_INGEST_BASE_URL`（例如 `https://call-console-api.yourdomain.workers.dev`）
  * `CF_INGEST_TOKEN`（与 Worker secret 一致）
* 在以下位置加“转发”逻辑：

  1. `/openai/webhook` 收到 `realtime.call.incoming`：

     * 解析 `call_id`、sip headers（OpenAI 文档示例里在 webhook `data.sip_headers` 里给出 From/To/Call-ID；你可以顺便解析自定义 `X-conferenceName`）。([OpenAI Platform][5])
     * `POST /ingest/call` event=start/status=incoming
  2. 成功 `/accept` + WS “open” 时：

     * `POST /ingest/call` status=live
  3. WS 收到一句 transcript（你目前已经能发 Discord）：

     * 同时 `POST /ingest/transcript`
     * `seq` 生成策略：用内存 `Map<call_id, seq>` 单调递增即可；或从 OpenAI 事件里提取 item index（如果你已存在可复用）
  4. WS close / 收到 hangup lifecycle：

     * `POST /ingest/call` event=end/status=ended

**验收标准**

* D1 中 `calls` 能看到通话记录；`transcript_segments` 能按 seq 连续增长。
* `GET /api/calls`、`GET /api/calls/:id/transcript` 返回正确分页。
* 打一通电话，打开网页详情页，能实时看到 transcript 滚动；挂机后仍能查询回放。

---

## 8. Cloudflare 部署步骤（Codex 可照做）

* `wrangler login`
* 创建 D1：按 D1 get started / wrangler 命令流程创建并绑定 Worker。([Cloudflare Docs][6])
* migrations：每个 migration 一个 `.sql` 文件，wrangler 支持 `d1 migrations apply`。([Cloudflare Docs][7])
* 创建 DO namespace + 绑定到 Worker（在 `wrangler.toml`）
* `wrangler secret put INGEST_TOKEN`
* `wrangler deploy`

---

# Milestone 2 — Twilio Conference：怎么用？用了以后项目怎么改？

你 repo README 已经写了 warm transfer 的方向：需要把 conference metadata 通过 SIP header 传到 OpenAI webhook，便于把 `call_id` 映射到 Twilio conference，然后用 Twilio REST API 邀请 human agent。([GitHub][1])

## 1) Twilio Conference 基础

* Twilio 用 `<Dial><Conference>` 把参与者接入同名会议室；这是 TwiML 的标准用法。([Twilio][8])
* Voice Conference 支持 2～250 参与者（适合 caller + AI + human + web）。([Twilio][9])
* 会议与参与者状态推荐用 `statusCallback` webhook 监控，而不是轮询 REST API。([Twilio][10])

## 2) 推荐的会议编排方式（贴近 Twilio 官方 warm transfer tutorial）

> 核心：**Twilio 成为“会议控制面”**；OpenAI SIP connector 作为其中一个 SIP 参与者。

**呼入流程改造（高层）**

1. PSTN 来电 → Twilio number → Twilio Webhook（你的 `/twilio/incoming-call`）
2. 你的服务生成 `conferenceName = <incoming CallSid>`（tutorial 常用做法）([Twilio][11])
3. 你的服务先用 Twilio REST API 创建/加入 AI 参与者（Dial 到 OpenAI SIP connector）：

   * `to = sip:...@sip.api.openai.com;transport=tls?X-conferenceName=<conferenceName>`
   * 关键点：把 `X-conferenceName` 作为自定义 header 注入 SIP URI，这样 OpenAI `realtime.call.incoming` webhook 的 `sip_headers` 里能带回来，你就能把 `call_id ↔ conferenceName` 映射起来。([OpenAI Platform][5])
4. 你的服务再返回 TwiML 给 Twilio，让 caller 也加入同一个 `<Conference>`。
5. 后续：当模型触发 `transfer_to_human` tool 时，你用 Twilio REST `participants.create` 邀请 `HUMAN_AGENT_NUMBER` 加入会议（你 README 已经有这套 env/config 的入口）。([GitHub][1])

**项目改动点（Codex checklist）**

* 新增 endpoint：`POST /twilio/incoming-call`（处理 Twilio webhook）

  * 返回 TwiML：`<Dial><Conference>conferenceName</Conference></Dial>`
* 新增 Twilio REST client 模块：

  * `createOrJoinConference(conferenceName)`
  * `inviteSipParticipant(conferenceName, openaiSipUriWithHeader)`
  * `inviteHumanParticipant(conferenceName, HUMAN_AGENT_NUMBER)`
* 新增 Twilio Conference 状态回调 endpoint（建议）：

  * `POST /twilio/conference-callback`
  * 用于更新 Cloudflare D1 的 call status/participants（配合 Milestone 1 的 `/ingest/call`）

**验收标准**

* 来电后：caller 与 AI 都在同一个 conference；模型正常说话。
* 模型触发 transfer tool：human 加入 conference（warm transfer）。
* conference 状态变化能通过 callback 更新到 Cloudflare（网页 live 列表能实时显示状态/参与者）。

---

# Milestone 3 — 前端网页怎么做（列表 + 历史 + Live 实时 + 未来 WebRTC join）

## 1) 技术栈建议（最小实现 + 可扩展）

* Cloudflare Pages 部署一个前端（React/Next.js/SvelteKit 都行）
* 后端 API：

  * 优先复用 Milestone 1 的 Worker API（`/api/*` + `/ws/*`）
  * Twilio token 发放等“敏感逻辑”放在 Worker 或你现有 Express 服务（看你是否想完全 Cloudflare 化）

## 2) 页面与交互设计（MVP）

### A. 会话列表页 `/calls`

* 数据源：`GET /api/calls?status=live`（默认）
* 功能：

  * live/ended filter
  * 按 started_at 倒序
  * 显示：状态、from/to、开始时间、最后一句话更新时间、按钮“查看详情”
* 实时刷新：

  * MVP 先轮询（例如 3s）
  * 更优：新增一个全局 `CallsIndex` DO 广播“call status changed”事件（可选）

### B. 会话详情页 `/calls/:call_id`

* 初始加载：

  * `GET /api/calls/:call_id`
  * `GET /api/calls/:call_id/transcript?after_seq=0&limit=200`
* 实时：

  * 连接 `wss://.../ws/calls/:call_id`
  * 收到 `transcript.segment` 就 append + auto-scroll
* 功能：

  * transcript 搜索（前端过滤）
  * “导出 JSON/CSV”（调用后端导出或前端生成）
  * 显示参与者（如果你接入 Twilio conference callback）

**验收标准**

* 历史通话可完整回放 transcript
* Live 通话能实时滚动显示（延迟接近你 Discord webhook 的实时性）

---

## 3) 未来：网页加入语音（WebRTC）怎么落到工程上

如果你采用 Twilio Conference 路线，网页 WebRTC join 是最自然的：

* 浏览器用 **Twilio Voice JavaScript SDK**：它通过 `Twilio.Device` + Access Token 建立通话。([Twilio][12])
* Access Token 必须由服务端签发（短时有效，最长可配到 24h，但最佳实践是尽量短）。([Twilio][13])
* Browser 端发起 `device.connect()` 后，Twilio 会去请求你配置的 TwiML App `VoiceUrl`，你返回 TwiML 控制它加入 conference（Twilio 文档明确：SDK 调用会触发 Twilio 请求 VoiceUrl，然后执行你返回的 TwiML）。([Twilio][14])

**工程改动（Codex checklist）**

1. 新增后端 endpoint：`GET /twilio/token?identity=<user>`

   * 生成 Access Token（Twilio IAM Access Tokens 文档）([Twilio][13])
2. 新增后端 endpoint：`POST /twilio/voice`（TwiML App VoiceUrl）

   * 从请求参数读 `conferenceName`
   * 返回 TwiML：`<Dial><Conference>conferenceName</Conference></Dial>` 或通过 `<Client>` 进行更精细路由（如需）([Twilio][8])
3. 前端加 “Join audio” 按钮：

   * 点击后：拉 token → `new Device(token)` → `device.connect({ params: { conferenceName }})`
   * 处理 UI：mute/unmute、hangup、网络状态

**验收标准**

* 在 live call 的详情页点击 Join：网页作为新的 participant 加入同一 conference，可听到 caller+AI（并可说话，取决于你是否允许）

---

# 给 Codex 的执行顺序（强建议）

1. **先做 Milestone 1**（数据落盘 + websocket 实时）
2. 再做 Milestone 3 的“纯看板”（列表/详情/实时 transcript）
3. 然后做 Milestone 2（Twilio conference 编排 + callback），最后再把 Milestone 3 加上 WebRTC join

这样每一步都有可验收的可见产物，不会把电话链路一次性改炸。

---

如果你希望我把 **API 返回 JSON 结构、WebSocket 消息类型、以及 D1 migration SQL** 再进一步写成“可直接复制进代码的规范文档”，我也可以按 Codex 友好格式给一个更硬核的接口契约版本（相当于 mini RFC）。

[1]: https://github.com/liangts/twillio_phone_agent "GitHub - liangts/twillio_phone_agent"
[2]: https://developers.cloudflare.com/d1/platform/pricing/ "Pricing · Cloudflare D1 docs"
[3]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/?utm_source=chatgpt.com "Use WebSockets · Cloudflare Durable Objects docs"
[4]: https://blog.cloudflare.com/workers-pricing-scale-to-zero/?utm_source=chatgpt.com "New Workers pricing — never pay to wait on I/O again"
[5]: https://platform.openai.com/docs/guides/realtime-sip?utm_source=chatgpt.com "Realtime API with SIP"
[6]: https://developers.cloudflare.com/d1/get-started/?utm_source=chatgpt.com "Getting started · Cloudflare D1 docs"
[7]: https://developers.cloudflare.com/d1/reference/migrations/?utm_source=chatgpt.com "Migrations · Cloudflare D1 docs"
[8]: https://www.twilio.com/docs/voice/twiml/conference?utm_source=chatgpt.com "TwiML™ Voice: <Conference>"
[9]: https://www.twilio.com/docs/voice/conference?utm_source=chatgpt.com "Voice Conference"
[10]: https://www.twilio.com/docs/voice/api/conference-resource?utm_source=chatgpt.com "Conferences resource"
[11]: https://www.twilio.com/en-us/blog/developers/tutorials/product/warm-transfer-openai-realtime-programmable-sip?utm_source=chatgpt.com "Perform a Warm Transfer to a Human Agent from the ..."
[12]: https://www.twilio.com/docs/voice/sdks/javascript/twiliodevice?utm_source=chatgpt.com "Voice JavaScript SDK: Twilio.Device"
[13]: https://www.twilio.com/docs/iam/access-tokens?utm_source=chatgpt.com "Access Tokens"
[14]: https://www.twilio.com/docs/voice/sdks/javascript?utm_source=chatgpt.com "Voice JavaScript SDK: Twilio in the browser"

下面给你一份“mini RFC / 接口契约”版本（**可以直接丢给 Codex 按规格实现**）。它覆盖：

* Cloudflare Worker API（REST + WebSocket）
* Durable Object（每个 call_id 一个房间）行为
* D1 schema + migration SQL
* 你现有 Express 服务 → Cloudflare 的 ingest 协议
* （为 Milestone 2/3 预留）Twilio Conference + WebRTC（Voice JS SDK）所需的 token/TwiML 端点契约

> 关键参考：
>
> * OpenAI SIP Realtime：`realtime.call.incoming` webhook、`POST /v1/realtime/calls/{call_id}/accept`、以及 server-side WebSocket 连接方式。([OpenAI Platform][1])
> * Cloudflare D1：bindings、migrations、wrangler 命令。([Cloudflare Docs][2])
> * Durable Objects WebSocket + hibernation + attachments：最佳实践与示例。([Cloudflare Docs][3])
> * Twilio Conference / Participants / statusCallback：TwiML + REST 建议。([Twilio][4])
> * Twilio Voice SDK Access Token：identity + VoiceGrant；SDK 需要 token vending endpoint。([Twilio][5])

---

# RFC-0001: Call Console Data Plane

**Status**: Draft (for Codex execution)
**Version**: 0.1
**Owner**: Tianshu
**Goals**:

1. 通话会话 + transcript 持久化
2. Live transcript 实时推送到网页（WebSocket）
3. 为后续 Twilio Conference / WebRTC join 预留字段与端点

---

## 0. 名词与 ID

* **call_id**：OpenAI SIP `realtime.call.incoming` webhook 提供的 call identifier（字符串）。([OpenAI Platform][6])
* **seq**：同一个 call_id 内 transcript 片段的单调递增序号（整数）。
* **segment**：一次“可显示的文本片段”，推荐按你现有实现的“completed sentence”粒度（写入频率低，便于存储与分页）。
* **status**：`incoming | live | ended | failed`

---

## 1. 安全模型（MVP）

* `POST /ingest/*`：**Bearer token** 鉴权（共享密钥），Worker 从 secret `INGEST_TOKEN` 读取。
* `GET /api/*`、`GET /ws/*`：MVP 可先不鉴权（内网/自用），后续再加 session/JWT。

---

## 2. D1 数据库模型（Source of Truth）

D1 是 SQLite 语义；migrations 用 `.sql` 文件版本化，wrangler 支持 `d1 migrations apply`。([Cloudflare Docs][2])

### 2.1 Tables

#### calls

* `call_id TEXT PRIMARY KEY`
* `status TEXT NOT NULL`
* `started_at INTEGER` (unix seconds)
* `ended_at INTEGER` (unix seconds)
* `from_uri TEXT`
* `to_uri TEXT`
* `provider TEXT` (e.g., `twilio`, `wavix`)
* `conference_name TEXT` (Milestone 2)
* `call_token TEXT` (optional)
* `last_seq INTEGER NOT NULL DEFAULT 0`
* `created_at INTEGER NOT NULL`
* `updated_at INTEGER NOT NULL`

#### transcript_segments

* `call_id TEXT NOT NULL`
* `seq INTEGER NOT NULL`
* `ts INTEGER NOT NULL` (unix ms recommended)
* `speaker TEXT NOT NULL` (`caller|agent|system|tool`)
* `text TEXT NOT NULL`
* `raw_json TEXT` (optional)
* **Primary key**: `(call_id, seq)`

### 2.2 Indices（强制）

> D1 的计费与性能会受到 “rows read（扫描行数）” 影响；必须用索引减少扫描。([Cloudflare Docs][7])

* `CREATE INDEX calls_status_started ON calls(status, started_at DESC);`
* `CREATE INDEX calls_updated ON calls(updated_at DESC);`
* `CREATE INDEX seg_call_seq ON transcript_segments(call_id, seq);`
* `CREATE INDEX seg_call_ts ON transcript_segments(call_id, ts);`

---

## 3. Cloudflare Worker / Durable Object 绑定与目录结构

### 3.1 wrangler.toml（示例骨架）

> D1 binding 与 Durable Objects binding 在 wrangler 配置中声明。([Cloudflare Docs][8])

```toml
name = "call-console-api"
main = "src/index.ts"
compatibility_date = "2025-12-01"

[[d1_databases]]
binding = "DB"
database_name = "call_console"
database_id = "REPLACE_ME"

[durable_objects]
bindings = [
  { name = "CALL_ROOM", class_name = "CallRoom" }
]

# Optional: Durable Object class migrations if you ever rename/add classes
#migrations = [
#  { tag = "v1", new_classes = ["CallRoom"] }
#]
```

### 3.2 项目结构（建议）

* `src/index.ts` Worker entry（REST + WS router）
* `src/callRoom.ts` DO class: `CallRoom`
* `src/db.ts` D1 helpers
* `migrations/0001_init.sql`

> DO WebSocket 建议走 hibernation API（server-side），可降低 duration charge；并可以用 attachments 保存 per-connection 元数据。([Cloudflare Docs][9])

---

## 4. REST API（外部：网页读取）

### 4.1 通用响应格式

* 成功：`2xx` + JSON
* 失败：`4xx/5xx` + JSON

  * `{ "error": { "code": "bad_request", "message": "...", "details": {...} } }`

### 4.2 GET /api/calls

**用途**：会话列表（live/历史）
**Query**

* `status`（可选）: `incoming|live|ended|failed`
* `limit`（可选）: 默认 50，最大 200
* `cursor`（可选）: 分页游标（见下）

**Cursor 规范（稳定分页）**

* `cursor` 是 base64(json)：

  * `{ "started_at": 1730000000, "call_id": "rtc_..." }`
* 排序：`started_at DESC, call_id DESC`
* 下一页条件：

  * `(started_at < cursor.started_at) OR (started_at = cursor.started_at AND call_id < cursor.call_id)`

**Response**

```json
{
  "items": [
    {
      "call_id": "rtc_...",
      "status": "live",
      "started_at": 1730000000,
      "ended_at": null,
      "from_uri": "sip:...",
      "to_uri": "sip:...",
      "conference_name": null,
      "last_seq": 128,
      "updated_at": 1730000123
    }
  ],
  "next_cursor": "base64..."
}
```

### 4.3 GET /api/calls/:call_id

**Response**

```json
{
  "call": {
    "call_id": "rtc_...",
    "status": "ended",
    "started_at": 1730000000,
    "ended_at": 1730000300,
    "from_uri": "sip:...",
    "to_uri": "sip:...",
    "provider": "twilio",
    "conference_name": "CFxxxx",
    "last_seq": 245,
    "created_at": 1730000000,
    "updated_at": 1730000301
  }
}
```

### 4.4 GET /api/calls/:call_id/transcript

**Query**

* `after_seq`（可选）: 默认 0（返回 `seq > after_seq`）
* `limit`（可选）: 默认 200，最大 1000

**Response**

```json
{
  "call_id": "rtc_...",
  "after_seq": 120,
  "items": [
    { "seq": 121, "ts": 1730000000123, "speaker": "caller", "text": "..." },
    { "seq": 122, "ts": 1730000000789, "speaker": "agent", "text": "..." }
  ],
  "last_seq": 245
}
```

---

## 5. Ingest API（内部：你的 Express 服务写入）

> OpenAI SIP：你需要从 `realtime.call.incoming` webhook 拿 `call_id`，然后 `POST /v1/realtime/calls/{call_id}/accept` 接听；并用 `wss://api.openai.com/v1/realtime?call_id=...` 建 server-side WebSocket 监听 transcript。([OpenAI Platform][1])

### 5.1 鉴权

Header:

* `Authorization: Bearer <INGEST_TOKEN>`
* `Content-Type: application/json`

### 5.2 POST /ingest/call

**用途**：Upsert 会话元数据与状态

**Request**

```json
{
  "event": "start",
  "call_id": "rtc_...",
  "status": "incoming",
  "ts": 1730000000,
  "from_uri": "sip:+1...",
  "to_uri": "sip:+1...",
  "provider": "twilio",
  "conference_name": "CFxxxx",
  "call_token": null,
  "meta": { "sip_headers": { "Call-ID": "..." } }
}
```

**语义**

* `event=start`：

  * 若不存在：insert（`created_at=ts`, `started_at=ts`）
  * 若存在：仅更新空字段 + `updated_at`
* `event=status`：更新 `status`，必要时更新 `updated_at`
* `event=end`：`status=ended`，`ended_at=ts`

**Response**

```json
{ "ok": true }
```

### 5.3 POST /ingest/transcript

**用途**：append transcript segment（幂等）

**Request**

```json
{
  "call_id": "rtc_...",
  "seq": 123,
  "ts": 1730000000123,
  "speaker": "caller",
  "text": "I need help with my order.",
  "raw": { "openai_event_type": "..." }
}
```

**幂等规则**

* 以 `(call_id, seq)` 为幂等键：重复写入必须不产生副作用
* D1 写入：`INSERT OR IGNORE`
* 若 `INSERT` 成功：

  * 更新 `calls.last_seq = max(calls.last_seq, seq)`
  * 更新 `calls.updated_at = now`

**Response**

```json
{ "ok": true, "inserted": true }
```

或（重复）

```json
{ "ok": true, "inserted": false }
```

---

## 6. WebSocket（外部：网页实时订阅）

Durable Objects 作为 **WebSocket server**，并建议用 hibernation + attachments 管理连接与元数据。([Cloudflare Docs][3])

### 6.1 GET /ws/calls/:call_id

* Worker 将请求路由到 DO：`CALL_ROOM.idFromName(call_id)`

### 6.2 连接握手与补齐策略（必须）

客户端在 URL query 带：

* `?after_seq=<N>`（可选，默认 0）

服务器在 `onopen` 后立即发送：

1. `snapshot`（包含 call meta + last_seq + 可能的 tail segments）
2. 然后再实时推送 `transcript.segment`

### 6.3 WebSocket 消息类型（JSON）

#### server → client: snapshot

```json
{
  "type": "snapshot",
  "call": {
    "call_id": "rtc_...",
    "status": "live",
    "started_at": 1730000000,
    "ended_at": null,
    "last_seq": 245
  },
  "segments": [
    { "seq": 201, "ts": 1730000012345, "speaker": "caller", "text": "..." }
  ]
}
```

#### server → client: transcript.segment

```json
{
  "type": "transcript.segment",
  "segment": { "seq": 246, "ts": 1730000099999, "speaker": "agent", "text": "..." }
}
```

#### server → client: call.status

```json
{
  "type": "call.status",
  "call_id": "rtc_...",
  "status": "ended",
  "ended_at": 1730000300
}
```

#### client → server: ping（可选）

```json
{ "type": "ping", "t": 1730000000123 }
```

#### server → client: pong（可选）

```json
{ "type": "pong", "t": 1730000000123 }
```

### 6.4 DO 广播触发点

* Worker 在处理 `/ingest/transcript` **插入成功**后，将该 segment 广播给当前 DO 内所有 ws clients。
* Worker 在处理 `/ingest/call` 状态变化后，同步广播 `call.status`。

---

## 7. Durable Object 实现要求（Codex Checklist）

1. DO 必须支持 hibernation（仅 server-side ws 可 hibernate；outgoing ws 不行）。([Cloudflare Docs][3])
2. 连接元数据（例如 user/session、after_seq）通过 `serializeAttachment()` 持久化；重启/hibernate 之后用 `getWebSockets()` 恢复。([Cloudflare Docs][10])
3. 补齐策略：

   * DO `fetch()` 收到 ws upgrade 后：

     * 解析 `after_seq`
     * 从 D1 查询 `seq > after_seq` 的最近 `limit`（例如 200）条，发送 `snapshot`
   * 后续只推新 segment
4. D1 查询与广播要避免阻塞：可在 Worker 中用 `ctx.waitUntil()` 做非关键路径（例如更新 `calls.updated_at`），但**插入 segment**与**决定 inserted/not**必须同步完成以保持幂等。

---

## 8. D1 Migration SQL（migrations/0001_init.sql）

（直接复制用）

```sql
-- 0001_init.sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  from_uri TEXT,
  to_uri TEXT,
  provider TEXT,
  conference_name TEXT,
  call_token TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS calls_status_started
  ON calls(status, started_at DESC);

CREATE INDEX IF NOT EXISTS calls_updated
  ON calls(updated_at DESC);

CREATE TABLE IF NOT EXISTS transcript_segments (
  call_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  text TEXT NOT NULL,
  raw_json TEXT,
  PRIMARY KEY (call_id, seq)
);

CREATE INDEX IF NOT EXISTS seg_call_seq
  ON transcript_segments(call_id, seq);

CREATE INDEX IF NOT EXISTS seg_call_ts
  ON transcript_segments(call_id, ts);
```

---

# RFC-0002（预留）：Twilio Conference + WebRTC Join 所需接口契约

> Twilio 推荐用 conference 的 `statusCallback` 来监控会议与参与者状态，而不是持续轮询 REST。([Twilio][11])
> Voice JS SDK 需要服务端下发 Access Token（identity + VoiceGrant）。([Twilio][5])

## A) Twilio inbound：POST /twilio/incoming-call  (TwiML)

**输入**：Twilio webhook（`application/x-www-form-urlencoded`）
**输出**：TwiML，将 caller 加入 conference（name = CallSid 或你生成的 conferenceName）

关键 TwiML（示例）：

* `<Dial><Conference statusCallback=... statusCallbackEvent=...>conferenceName</Conference></Dial>` ([Twilio][4])

> 注意：Twilio 文档明确 `statusCallback` 以**第一个加入会议的 participant 设置为准**，后续设置会被忽略；所以要保证你期望的 callback URL 是第一个 participant 设置。([Twilio][4])

## B) Twilio token vending：GET /twilio/token

**用途**：网页端获取 Voice JS SDK token
**Response**

```json
{ "token": "<JWT>", "expires_at": 1730001234 }
```

token 必须包含 `identity` + `VoiceGrant`。([Twilio][5])

## C) Twilio VoiceUrl（给 JS SDK connect 使用）：POST /twilio/voice  (TwiML)

**用途**：网页端 `device.connect({ params: { conferenceName } })` 后，Twilio 回调到 VoiceUrl，你返回 TwiML 让该 WebRTC client 加入同一 conference。
**输出**：与 inbound 类似的 `<Dial><Conference>...</Conference></Dial>`

---

# 给 Codex 的“实现优先级”

1. 完整实现 RFC-0001（D1 + ingest + /api + /ws + DO）
2. 在你现有 Express 服务里，把 Discord webhook 同时改为调用 `/ingest/transcript` 和 `/ingest/call`
3. 前端按 `/api` + `/ws` 做列表/详情/实时滚动
4. 再推进 RFC-0002（Twilio conference 编排 + statusCallback + WebRTC join）

如果你愿意，我下一条可以把 **Worker/DO 的 TypeScript 伪代码骨架**（路由、D1 prepare、ws upgrade、broadcast、hibernation attachments）也按“可直接落文件”的颗粒度写出来，让 Codex 基本只需要补细节就能跑。

[1]: https://platform.openai.com/docs/guides/realtime-sip?utm_source=chatgpt.com "Realtime API with SIP"
[2]: https://developers.cloudflare.com/d1/reference/migrations/?utm_source=chatgpt.com "Migrations · Cloudflare D1 docs"
[3]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/?utm_source=chatgpt.com "Use WebSockets · Cloudflare Durable Objects docs"
[4]: https://www.twilio.com/docs/voice/twiml/conference?utm_source=chatgpt.com "TwiML™ Voice: <Conference>"
[5]: https://www.twilio.com/docs/iam/access-tokens?utm_source=chatgpt.com "Access Tokens"
[6]: https://platform.openai.com/docs/api-reference/realtime-calls?utm_source=chatgpt.com "Calls | OpenAI API Reference"
[7]: https://developers.cloudflare.com/d1/wrangler-commands/?utm_source=chatgpt.com "Wrangler commands - D1"
[8]: https://developers.cloudflare.com/d1/best-practices/local-development/?utm_source=chatgpt.com "Local development - D1"
[9]: https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/?utm_source=chatgpt.com "Build a WebSocket server with WebSocket Hibernation"
[10]: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/?utm_source=chatgpt.com "Rules of Durable Objects"
[11]: https://www.twilio.com/docs/voice/api/conference-resource?utm_source=chatgpt.com "Conferences resource"
