# dsh-lark-link 情报报告

> 源码级深度分析报告 · 供 DSH 飞书桥接插件选择性吸收借鉴
> 分析对象：`amlyczz/dsh-lark-link` v0.3.0（浅克隆 /tmp/dsh-lark-link，未安装依赖、未运行测试，纯只读源码分析）
> 分析范围：全部 33 个 src/ 源文件（8334 行 TypeScript）+ .spec 设计文档 + README + CHANGELOG + 27 个测试文件（24 单元 + 3 集成，156 处 test() 调用）

---

## 1. 项目概况

| 项 | 值 |
| --- | --- |
| 仓库 | [amlyczz/dsh-lark-link](https://github.com/amlyczz/dsh-lark-link)（MIT，TypeScript） |
| 版本 | v0.3.0（npm 包名 `dsh-lark-link`，`main: dist/index.js`，`exports["./client"]`） |
| ⭐ Star / Fork | ⭐11 / 4（gh API 实测，2026-08-16） |
| 创建 / 最近推送 | 2026-08-13 / 2026-08-15（**极早期新项目，但迭代极快**：CHANGELOG 显示 0.1.0 → 0.1.1（未发布，实机修复轮）→ 0.3.0，两周内完成） |
| 维护状态 | 活跃，未 archived；GitHub Issues 0 条（未启用/无反馈沉淀） |
| 形态 | **进程内 Cordis bundle 插件**（`dsh.bundle` + `cordis.patch.yml`，`dsh plugin add` 安装），无独立 daemon |
| 定位 | DeepSeek Harness × 飞书/Lark 双向桥接：扫码 30 秒上线、消息零丢失、卡片化交互、每飞书会话独立 Agent |
| 架构血统 | 移植自 pi-feishu-link（0.2.2，262 测试全绿），吸收 pi-feishu-lark / pi-remote-feishu / pi-lark-notify 三个参考项目的精华；spec 自述为「pi-feishu-link 范式移植 + 三参考项目对抗性调研」的产物 |
| 测试 | 27 个测试文件（24 单元 + 3 集成：kill-9 一致性 / 分航道隔离 / 断连补偿），README 称 122 项，实际 test() 调用点 156 处 |

**关键工程特征**（对借鉴方最重要的总体判断）：
- **分层纪律极严**：L1 inbound 不 import DSH、L2 sessions 不 import 飞书 SDK、outbox 零依赖（sender 注入）、presentation 纯函数、application 只依赖 BridgeContext 接口。大量模块「harness-agnostic」——可直接剪出复用。
- **「可变依赖 getter 化 lazy resolve」铁律**（pi 版 01f978a 根因教训）：BridgeContext 所有可变字段都是 getter，禁止装配期快照。
- **TDD first + Spec first**：.spec 文档 377 行，测试镜像 src 结构。
- **实现与 spec 有 3 处偏差**（源码级分析的重要发现，见 §3.12/§3.15/§3.18）：spec ADR-5 声称的 sessionKey↔sessionId 持久映射（storage.domain KV）**未实现**，改为每运行新鲜 runNonce；gateway-lock.ts 与 lifecycle.ts **实现存在但主入口未接线**（dead code + 单测覆盖）；notification-service.ts 同样未接线。

---

## 2. 架构总览

### 2.1 分层模块图

```
┌─────────────────────────────────────────────────────────────────────┐
│ src/index.ts（2071 行 · 薄装配层）                                       │
│  ctx.effect disposer / /lark-* 命令 / 工具注册 / system-prompt section  │
│  / askUserQuestion 桥 / bridgeHandler / startBridge/stopBridge 内联    │
└───────┬─────────────────────────────────────────────────────────────┘
        │ 依赖倒置：只依赖各层接口
┌───────▼─────────────────────────────────────────────────────────────┐
│ application/（桥编排）                                                 │
│  bridge-context.ts（getter 化依赖容器）message-handler.ts（入站管道）     │
│  command-router.ts（三级分流）diagnostics-service.ts  notification-service.ts│
│  status-formatter.ts                                                   │
├─────────────────────────────────────────────────────────────────────┤
│ host/（只懂 DSH Cordis ctx）      inbound/（只懂飞书协议）                │
│  auth-setup.ts（扫码建应用）        transport.ts（事件归一化+WS 封装）       │
│  gateway-lock.ts（多宿主锁※未接线）  connection-supervisor.ts（probe 重连）  │
│  lifecycle.ts（装配器※未接线）      inbound-wal.ts（入站补发日志）           │
│  lark-client.ts（SDK 适配+凭据）     missed-compensation.ts（断连补收）      │
│                                    group-trigger.ts（群策略）             │
├─────────────────────────────────────────────────────────────────────┤
│ sessions/（只懂 DSH API）           outbound/（零 DSH 零飞书 import）      │
│  dsh-adapter.ts（★唯一 DSH 依赖点）   outbox.ts（持久可靠投递核心）          │
│  dsh-session-backend.ts（接口+内存mock）outbound-router.ts（路由表）         │
│  conversation-manager.ts（per-key 编排）event-forwarder.ts（事件分拣）      │
│  turn-supervisor.ts（看门狗）         cardkit-stream.ts（流式卡）           │
├─────────────────────────────────────────────────────────────────────┤
│ presentation/cards.ts（纯函数卡片）   common/（零外部依赖）                 │
│                                     config/quota-governor/dedupe-store/ │
│                                     reactions/connection-status/logger/types│
├─────────────────────────────────────────────────────────────────────┤
│ client/index.ts（浏览器侧 client plugin，只懂 ctx.slots + fetch）          │
│  sidebar.footer.action 入口 + 状态浮层 + setup 二维码（portal 到 body）      │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 分层职责与数据流

**入站数据流**（飞书 → DSH）：
```
飞书 WS 长连接（@larksuiteoapi/node-sdk WSClient，autoReconnect:false）
  → transport.ts handleEvent：v2.0 事件归一化 normalizeInbound（message_id 在 event.message 嵌套）
  → message-handler.handleInbound 管道：
      dedupe(messageId) → allowlist → group-trigger(open/mention/keywords/reply)
      → 随机表情回执 → command-router 三级分流
        ├─ 桥命令 → bridgeHandler → durableReply（outbox）
        ├─ DSH 注册命令 → commands.find/execute 原生执行 → outbox
        └─ 其他 → Inbound WAL accept（纯文本）→ ConversationManager（per-key FIFO）
              → DshSessionBackend.ensureAgent（create/resume）→ agent.followup()
              → 多媒体附件解析（图片→ImageBlock / 文件→有界文本）
```

**出站数据流**（DSH → 飞书）：
```
agent session/event（turn/start, assistant/chunk, assistant/message, turn/end, tool/call…）
  → dsh-adapter toSessionEventOut 归一化
  → conversation-manager onEvent fan-out → event-forwarder 分拣：
      ├─ assistant/chunk →（streaming.enabled 时）CardKit 流式卡（易失预览）
      ├─ assistant/message → Outbox.enqueue（持久，at-least-once）+ WAL delivered 标记
      └─ turn/end → 流式卡 finalize + DONE 表情（hasOutput 才打）
  → Outbox pump 分航道并行投递 → sender（Feishu REST：text/card/media/reaction）
```

**核心设计决策**（spec §0/§2.3/§4.3，与 pi 版最大差异）：
1. 进程内插件形态（无 daemon、无跨进程状态，生命周期交给 `ctx.effect()` 可逆注册）
2. 每飞书会话独立 DSH session（per-conversation-key）
3. **无审批、默认全放开**（不接 approval/request，`tools/pre-execute` 不挂钩子；仅可选 denyList 纯拒绝兜底）——这是与 pi 版 permission-bridge 的最大分叉
4. 双通道出站：LiveChannel（易失流式）+ Outbox（持久定稿）
5. 复用 DSH Web GUI：桥会话 = 原生 DSH session，client plugin 只加桥特有表面

### 2.3 状态目录布局（`<DSH_HOME>/lark-link/`，`DSH_LARK_LINK_HOME` 可覆盖）

```
config.json / runtime-overrides.json   # 配置 + 热改白名单落盘（600）
outbox/seg-*.jsonl + blobs/            # 出站持久队列（7 天终态保留 + pending 永不淘汰）
inbound-wal/seg-*.jsonl                # 入站请求补发日志
routes.json / dedupe.jsonl / conn-history.jsonl / status.json
inbound/media/                         # 入站图片/文件本地落盘
credentials → ctx.credentials（ref: LARK_LINK_APP，appSecret 唯一存放点）
```

---

## 3. 核心机制逐项分析

### 3.1 Outbox 消息零丢失

**实现**：`src/outbound/outbox.ts`（439 行，零 DSH/飞书 import，sender 注入）+ `src/outbound/outbound-router.ts`（路由表）。

**工作原理**：

- **持久化格式**：JSONL 分段文件 `outbox/seg-<epochSec>.jsonl`（`outbox.ts:117`），每次 flush 重写一个全新 segment 文件（先写 `.tmp` 再 `renameSync`，`outbox.ts:170-193`），崩溃安全；重启 `rebuildFromDisk()`（`outbox.ts:141-168`）扫描全部 seg 重建内存 Map，并把 in-flight 的 `sending` 状态**回滚为 `pending`**（崩溃恢复核心）。payload 超过 `blobThreshold`(24KB) 溢出到 `blobs/<uuid>.json`（`outbox.ts:196-218`）。终态（done/fatal）超 `retainDays`(7 天) 由 `start()` 自调度清理（约 1h，`outbox.ts:404-414`），pending 永不淘汰，`pendingCap`(10000) 硬顶拒收防无限膨胀。
- **幂等键**：每个 envelope 带 `dedupeKey`，**入队时**查 `sentKeys` Map（任何状态都算已见，`outbox.ts:234`），重启后从磁盘重建（`outbox.ts:126`）——同一逻辑消息绝不被投递两次（at-least-once 而非 per-enqueue at-most-once）。幂等键构成：`${sessionKey}:assistant:${text.length}:${Date.now()}`（event-forwarder.ts:138，防同窗口重复入队）、`${key}:cmd:${cmd}:${messageId}`（command-router.ts:108，按触发消息天然幂等）、`bridge:${cmd}:${messageId}`（index.ts:710）。
- **状态机**：`pending → sending → done | failed | fatal`。失败重试：attempts 递增，**有界指数退避** `min(60s, 1000*2^min(attempts-1,10))`（`outbox.ts:298`），`maxAttempts`(50) 耗尽或 `isFatalError`（/400|403|invalid|not found/i，`outbox.ts:92`）命中 → `fatal` 不再投递。
- **失败离队不阻塞（pi F1 根因内建）**：drain 时消息从 lane 头部 shift 出队，失败后**不重新插回队头**，而是留在 `failed` 状态由 retrySweep（`outbox.ts:322-340`）在 `nextRetryAt` 到期后追加到队尾——新消息永远不被卡死的旧消息挡住。
- **分航道并行**：`laneKey`（默认 = sessionKey）→ 每 lane 一个 FIFO + 一条 promise 链串行；pump 循环（`outbox.ts:342-379`）同时推进所有 lane（跨 lane 并行、lane 内 FIFO）；空闲时挂起等待 `idleWake` 信号（200ms 安全超时），新入队立即唤醒零轮询延迟。
- **投递结果**：sender 抛错或返回 `{ok:false,retryable:true}` → 重试；`{ok:false,retryable:false}` → fatal。

**依赖**：零第三方（node:fs/crypto/path）；配置 `outbox.*`（config.ts:36-47）；宿主仅需注入 `OutboxSender.deliver()`。

**可裁剪复用性**：**高**。纯独立模块（显式声明 ZERO DSH/Feishu import），换一个 sender 就是任何 IM 的出站可靠队列。建议直接复制改造（保留 blob spill、退避封顶、lane 隔离、self-prune——这四样是踩过坑的）。

---

### 3.2 Inbound WAL 入站补发

**实现**：`src/inbound/inbound-wal.ts`（198 行）+ 启动对账在 `src/index.ts:1456-1508` + 写入/标记在 `message-handler.ts:270-287`、`index.ts:533-540`。

**工作原理**：

- **持久化**：`inbound-wal/seg-*.jsonl`，同样 `wx`+rename 落盘纪律（`inbound-wal.ts:117-127`）。记录结构：`{messageId, sessionKey, chatId, chatType, senderOpenId, text, acceptedAt, attempts, state}`，state ∈ `accepted | delivered | replayed`（`inbound-wal.ts:32-47`）。
- **写入时机（accept）**：message-handler 在把消息交给 ConversationManager **之前**记录（`message-handler.ts:270-287`）——只记**纯文本**消息（`isText` 判断），媒体/命令不记（媒体重放不可靠、命令可重跑）；补发重放（compensated=true）**不重复 accept**（否则会重置 attempt 上限造成死循环）；text 截断 8000 字符。
- **完成标记（delivered）**：event-forwarder 把 durable 输出入队 outbox 或流式卡 finalize 成功时回调 `onDelivered`（event-forwarder.ts:130/144）→ index.ts:533-540 查 `route.lastMessageId` 调 `inboundWal.delivered()`——**「可交付输出落盘 = 该请求已答复」**是整条链路的证明点。
- **启动对账**：startBridge 末尾 fire-and-forget（`index.ts:1465-1508`）：`prune()` → `pendingReplays()`（未 delivered、attempts<上限、在时间窗内，按 acceptedAt 升序）→ 逐个 `markReplay()` → 组装 FeishuInboundMessage 走 `handleCompensated`（**跳过入站 dedupe**）→ 重新触发 agent。
- **防空转**：`maxReplayAttempts=2` + `replayRetentionMs=30min`（`inbound-wal.ts:81-82`）；`markReplay` 三条件拒绝（已交付/超次数/超窗，`inbound-wal.ts:149-159`）；prune 对「已交付」按窗口过期清理、对「从未交付」需窗口+次数双满才清（`inbound-wal.ts:171-187`）。
- **透明可见**：`/status` 与 Web 面板显示「补发 N 条」（index.ts:1446-1450、status-formatter.ts:13-14）。

**依赖**：零外部（node:fs 而已）；无配置项（常量默认 2 次/30min）。宿主集成点 3 处：accept / delivered / 启动 replay 循环。

**可裁剪复用性**：**高**。存储原语完全独立可搬；启动对账约 50 行胶水代码，任何「处理到一半崩溃会丢请求」的桥都值得照抄。注意一个边界语义：只救纯文本、且依赖「WAL 已交付」与 outbox 投递的耦合——若借鉴方输出通道不同，只需改 delivered 的触发点。

---

### 3.3 连接自愈与配额熔断

**实现**：`src/inbound/connection-supervisor.ts`（215 行）+ `src/common/quota-governor.ts`（100 行）。

**工作原理**：

- **probe 机制**：每 `probeIntervalMs`(30s) 一次 REST 探活（`getBotInfo`，与 WS 健康独立），`Promise.race` 8s 超时（`connection-supervisor.ts:150-158`）；连续失败 `probeFailThreshold`(3) 次才 degrade（瞬态错误不误杀，`ec64036` 教训）；probe 健康时**绝不重建空闲连接**（`idleKeepaliveMs` 20min 语义，ADR-2 防误判僵尸）。
- **重连退避**：WSClient 配置 `autoReconnect:false`（ADR-1，SDK 无限重试会烧配额），重连完全由 supervisor 状态机驱动：`idle → connecting → connected → degraded → reconnecting → quarantined → stopped`（`connection-supervisor.ts:70-126`）；每次失败 `reconnectAttempts++`，达 `maxReconnectAttempts`(8) 触发熔断；每次尝试都 `quota.recordConnect()`。
- **熔断阈值**：QuotaGovernor 窗口 60min 内失败 ≥12 次 → `tripped()`（`quota-governor.ts:82-85`）→ supervisor 置 `quarantined` 并停止尝试（进程内形态**不休眠不退出**，只禁用桥 + 状态上报，`connection-supervisor.ts:85-99`）；历史落盘 `conn-history.jsonl`（0600，500 条上限，`quota-governor.ts:54-63`）**跨重启生效**。
- **自动恢复**：quarantined 状态下每次 tick 检查 `resetAt()`，窗口过期即 `quota.reset()` + 自动重连（`connection-supervisor.ts:132-148`，0.3.0 修复 #5：熔断后无需手动 /lark restart）。

**依赖**：零外部；配置 `supervisor.*` / `quota.*`（config.ts:49-63、114-124）；transport 接口（start/stop/isConnected/wsReady/probe）。

**可裁剪复用性**：**高**。两者都是 harness-agnostic 纯模块，接口只有 5 个方法 + 状态回调。任何「长连接 + 配额敏感 API」的场景（包括 DSH 桥接其他 IM）直接照搬；QuotaGovernor 可单独用于任何「窗口内失败次数熔断」需求。

---

### 3.4 命令三级分流

**实现**：`src/application/command-router.ts`（141 行）+ 宿主侧 `DshCommandRegistry` 实现 `index.ts:636-695`。

**工作原理**（`command-router.ts:62-139`）：

1. **Tier 1 桥命令**：硬编码集合 `BRIDGE_COMMANDS`（`command-router.ts:41-55`）：`status / workspace / stop / support / doctor / sessions / lark-config / feishu-config / model / mode / permission / new / help` + `lark`。命中 → `bridgeHandler(cmdName, rawInput, msg)`；**处理成功即对触发消息打 DONE 表情**（`command-router.ts:74-84`）。
2. **Tier 2 DSH 注册命令**：桥命令未命中 → 查 `ctx.commands` 注册表：`commands.find(agent, name)`（agent 作用域的有效命令注册表）+ `commands.execute(agent, line, signal)` 原生执行（`index.ts:636-695`，0.1.1 修复：原调 `commands.run()` 方法不存在）。首个消息即命令时会 **lazy ensureAgent**（`command-router.ts:92-100`）。结果经 outbox 投递（`command-reply`，按 messageId 幂等），失败回落 agent。
3. **Tier 3 原生注入**：`/goal`、未知 `/xxx`、普通文本 → **原样 `agent.followup()`**，无拦截无门禁（skill 无前缀，模型自动加载）。
4. 空文本 → `skipped`。

**判定细节**：`isCommand` = `/^\//`；命令名去前导斜杠 + 小写；rawInput 为剩余 tokens。设计约束：DSH 无 `commands/pre-handle` 拦截点（spec §4.2 调研确认），分流完全在桥自己的 inbound 编排内完成。

**依赖**：BridgeContextRead + DshCommandRegistry 接口；Tier 2 与 DSH commands 服务 API 形状耦合。

**可裁剪复用性**：**中**。路由逻辑本身小而清晰可搬；但 Tier 2 深度绑定 DSH 的 `commands.find/execute(agent, line, signal)` 调用约定，借鉴方须确认自己目标 harness 的命令注册表面。

---

### 3.5 入站多媒体（图片→视觉模型 / 文件→文本提取）

**实现**：`message-handler.ts:82-196`（`resolveInboundAttachments`）+ `transport.ts:352-357` / `lark-client.ts:307-329`（下载）+ `dsh-adapter.ts:488-512`（入提示词）+ `index.ts:432-455`（attachment store 装配）。

**工作原理**：

- **图片**：从消息 content JSON 取 `image_key` → REST `GET im/v1/messages/:id/resources/:key?type=image` 流式下载为 Buffer（`lark-client.ts:315-328`）→ **magic bytes 嗅探真实类型** png/jpeg/webp/gif（`message-handler.ts:47-61`）→ 双落盘：① 本地文件 `<state>/inbound/media/feishu-<msgId>-<ts>.png`（供非视觉模型/外部工具读磁盘，`message-handler.ts:107-121`）；② `ctx.attachments.saveImage` → DSH ImageBlock ref（供视觉模型，`message-handler.ts:127-135`）→ followup 组装 content blocks `[{type:"text",text}, {type:"image",attachment}]`（`dsh-adapter.ts:496-499`）。
- **文件**：取 `file_key`/`file_name` → 下载 → 本地落盘 → **有界文本提取**：≤150KB 且 UTF-8 无替换符（`\uFFFD`）才提取，作为 `[附件 名 内容]` 前缀拼进提示词文本（`dsh-adapter.ts:499-504`）；提取失败仅标注「未能提取文本」。
- **降级铁律**：附件解析任何一步失败 → **降级为纯文本消息，绝不丢消息**（`message-handler.ts:190-195`）；`imageRef` 缺省时 `path: "feishu://image"` 占位。

**依赖**：飞书资源下载 API（type 参数区分 image/file）、DSH attachments 服务（可选，`ctx.get("attachments")`）、配置 `inboundDir`。

**可裁剪复用性**：**中**。下载→嗅探→双落盘→ImageBlock 的流程可整体搬，但绑定飞书 resource API 形状与 DSH ImageBlock/AttachmentInput 接口；文件文本提取（150KB 有界 + 替换符过滤）是通用技巧可单独取用。

---

### 3.6 出站多媒体工具 `lark_send_local_file`

**实现**：`src/index.ts:1526-1617`（工具定义与执行）+ `lark-client.ts:269-306`（上传适配）+ `transport.ts:366-377`（`extractUploadKey`）。

**工作原理**：

- **注册方式**：`ctx.tools.register(defineTool({...}))` 宿主平面全局注册（`index.ts:1526`），非 per-agent 注册——模型在任意 agent 作用域可调；同注册 `lark_config_get`（`index.ts:1618-1631`）；system-prompt section 告知模型这两个工具（`index.ts:2034-2051`）。
- **白名单**：路径解析后必须 `startsWith(workspaceRoot)`（相对路径基于工作区解析，`index.ts:1553-1559`；0.1.1 修复：`/workspace` 切换后 agent 在工作区建的文件不被 process.cwd() 误拒）。
- **大小校验**：`statSync` 后 >25MB 直接拒绝（`index.ts:1585`）。
- **格式降级**：`kind=image` 仅当扩展名匹配光栅格式 `png|jpe?g|webp|gif`，svg 等**自动按 file 发送**（`index.ts:1578-1579`）；`uploadFile` 按扩展名映射飞书合法 `file_type`（pdf/doc/docx→doc/xls/xlsx→xls/ppt/pptx→ppt/mp4/opus，其余 → `stream`，`lark-client.ts:279-291`——0.1.1 修复 234001：飞书只收 `opus|mp4|pdf|doc|xls|ppt|stream`）；`extractUploadKey` 兼容顶层与 `{data:{...}}` 双形状响应（`transport.ts:366-377`）。
- **会话定位**：`exec.agent.id`（含 runNonce 后缀）→ `backend.keyForSessionId` 反向映射，回退剥离 `lark-link:` 前缀与 nonce 尾缀（`index.ts:1564-1572`）→ routeStore 取 chatId → 上传后 `sender.sendFile`。

**依赖**：ctx.tools、FeishuSender、routeStore、backend 反向映射。

**可裁剪复用性**：**中**。工具定义 + 白名单/大小/降级三段校验是通用模板（可整体抄）；上传与 file_type 映射绑定飞书 SDK 细节，借鉴方换平台时替换 upload 层即可。

---

### 3.7 Markdown → CardKit 渲染

**实现**：`presentation/cards.ts:43-72` + `index.ts:344-371`（sendText 决策）。

**工作原理**：

- **检测**：`looksLikeMarkdown(text)`（`cards.ts:43-52`）：正则命中标题 `#{1,6}\s`、列表 `[-*+]\s|\d+\.\s`、围栏代码 ` ``` `、引用 `>\s`、粗体 `\*\*`、表格 `\|.*\|`，或含段落空行 `\n\n` → 走卡片。
- **转换**：`markdownCard`（`cards.ts:54-72`）产 schema 2.0 卡：body 单元素 `{tag:"markdown", content}`，`header` 必须是 **body 的顶层兄弟**（嵌套在 body 内报 200621，0.1.1 修复）。
- **决策点**（`index.ts:352-362`）：looksLikeMarkdown && 长度 ≤28000 → `msg_type:"interactive"` 卡片；否则纯文本消息。⚠️ 源码注释（index.ts:347-351）写「schema-1.0 卡兼容老客户端」，但实际 `markdownCard` 发出的是 `schema:"2.0"`——**以代码为准（2.0）**，注释疑似陈旧。
- 流式场景的卡片另有 `cardkit-stream.ts`（schema 2.0 真流式，见下）。

**依赖**：无第三方（纯函数）；仅飞书交互卡消息类型。

**可裁剪复用性**：**高**。纯函数 + 决策阈值，直接复制；「检测失败回退纯文本、超长回退纯文本」的降级策略一并带走。

---

### 3.8 意图确认卡片（ask_user_question → 卡片按钮）

**实现**：`index.ts:556-633`（askUserQuestion 桥）+ `index.ts:1164-1257`（handleCardAction 回调）+ `dsh-adapter.ts:244-364`（shadow 工具遮蔽）+ `cards.ts:153-219`（questionCard）。

**工作原理**（完整闭环）：

1. **工具遮蔽**：agent `setup(agentCtx)` 里注册同名 `ask_user_question` shadow 工具（`defineTool`，schema 与 DSH 原生一致），**覆盖 preset 的全局同名工具**（`dsh-adapter.ts:244-364`）；execute 转发给 `deps.askUserQuestion`。
2. **发卡**：按 question 逐张发 schema 2.0 意图确认卡（`cards.ts:153-219`）——单选 = 每选项一个 `behaviors:[{type:"callback",value:{op:"uqa:<qid>:<index>"}}]` 按钮 + 常驻「或直接发消息输入自定义答案」提示；`multiSelect:true` = `form_container` + `multi_select_static` 下拉 + onSubmit `uqam:<qid>`（0.3.0 新增，GH #5）。
3. **等待**：`pendingQuestions` Map（`index.ts:560-569`）挂 resolve + **10 分钟超时**（`index.ts:607-611`，超时回 `(超时未回答)`，防 pending 泄漏）；卡片发送失败立即 resolve 错误占位。
4. **回调**：`card.action.trigger` 事件经 transport.onEvent → handleCardAction（`index.ts:1164-1257`）：`uqam:` 多选从 `action.formValue.answer` 取 string[] 映射回选项 label；`uqa:` 单选取索引；resolve 后回执一条「已收到你的选择 ✅」文本。
5. **自定义回答**：pending 期间同 chat 的纯文本消息被 transport.onMessage 拦截（`index.ts:1398-1411`），作为 `{custom: text}` resolve——不进 agent。
6. **提交回宿主**：resolve 的答案经工具 output schema（`{answers:[{id,selected,custom}]}`）返回模型，模型继续原 turn。

**依赖**：sender（发卡/回执）、backend.keyForSessionId + routeStore（定位 chat）、DSH tools 注册表面。

**可裁剪复用性**：**中**。机制本身（shadow 工具 + pending Map + 回调 op 路由 + 文本兜底）思路完全可复制；卡片结构绑定飞书 schema 2.0，回调绑定 card.action.trigger 事件面，借鉴方换 IM 需重写卡片与回调解析层，但骨架不变。

---

### 3.9 多模式 Agent preset（/mode）

**实现**：`index.ts:1029-1075`（命令）+ `dsh-adapter.ts:580-620`（listPresets）/ `230-241`（挂载）+ `cards.ts:82-107`（AGENT_PRESETS）+ `dsh-session-backend.ts:85-90`（SHIPPED_PRESETS）+ `conversation-manager.ts:109-123`（rotate）。

**工作原理**：

- **preset 定义**：四个出厂 preset——`standard`（标准全能）/ `code`（PTC：标准 + Code Mode 多步一次执行）/ `minimal`（仅 bash+编辑）/ `cordis`（创造：+ preset 创作工具）（`cards.ts:82-107`）；`AGENT_PRESETS` 是**服务不可达时的回退目录**，真实 roster 从 DSH `agentPresets.list()` 动态读（含 GUI 里用户自建的 custom preset，`dsh-adapter.ts:580-620`）。默认 `agentPreset: "code"`（config.ts:130，`ptc` 别名兼容）。
- **切换机制**：`/mode` 无参 → 单选按钮卡（每 preset 一个 `op:"mode:<id>"` 按钮 + 「← 当前」标记）；点选/带参 → `configStore.update({agentPreset}) + saveOverrides` → **`conversations.rotate(key)`**。
- **对 DSH 会话的实际影响**：preset 在 **agent 创建时快照**——`meta.agentPreset` 写入 + `setup()` 里 `agentPresets.mount(agentCtx, presetId)` 挂载工具（`dsh-adapter.ts:230-241`、369-384）。**已存在的会话无法中途换 preset**，所以切换 = rotate 重建：mint 全新 runNonce → 下条消息开新会话行（新 preset 生效），**旧 agent 只摘除监听不 dispose**（dispose 会把旧会话从 GUI 列表删掉，`dsh-adapter.ts:632-658` 详细注释了 dispose vs rotate 的取舍），旧会话靠 TTL sweep 自然回收。

**依赖**：config（热改白名单含 agentPreset）、backend.listPresets、DSH agentPresets 服务（mount/list）。

**可裁剪复用性**：**中**。卡片 + 配置热改 + 回退目录的模式可搬；「preset 创建期快照 → 切换必须重建会话 → rotate 而非 dispose」是踩出来的 DSH 特性（GUI 会话行语义），借鉴方须对照自己的 harness 确认。

---

### 3.10 权限分级（/permission）

**实现**：`index.ts:1076-1144` + `cards.ts:110-126, 303-316` + `config.ts:65,125,131` + `index.ts:143-183`（syncDefaultPermission）。

**工作原理**：

- **等级模型**：三档——`read-only`（沙箱只读，危险需审批）/ `workspace-write`（仅工作区可写，危险需审批）/ `danger-full-access`（全访问 + 审批 never），**默认 full access**（config.ts:131）。另有 `denyList` 配置（默认空数组）：命中的命令前缀**直接拒绝并返回错误，不询问不弹卡**（纯 deny 兜底，可热改）。
- **拦截/放行位置**：桥**自身不拦截任何工具调用**——不注册 approval 应答者、`tools/pre-execute`/`post-execute` 不挂钩子（spec §4.3 用户决策，与 pi 版 permission-bridge 的最大分叉）。放行/拦截完全交给 DSH 权限子系统，桥只做两件事：
  1. `/permission` 切换：`permissionPresets.apply(agent.session, mode, setApproval → approval.setPolicy(agent, policy))`（`index.ts:1101-1136`）——作用到当前会话；
  2. `syncDefaultPermission()`（`index.ts:143-183`）：把 DSH `settings` 文档的 `permission.defaultPreset` 同步为桥配置（4 次重试退避，best-effort 非致命）——**新会话继承**切换结果，解决「新会话被 DSH 默认 workspace-write 钉死、配置被无视」的实测坑。

**依赖**：DSH permissionPresets / approval / settings 服务（全部可选，服务缺失桥仍可用）。

**可裁剪复用性**：**中**。卡片与配置层可搬；但「桥不拦截」是产品决策而非机制，真正的权限执行在 DSH 侧——借鉴方若需要桥内拦截，需自己接 `tools/pre-execute` waterfall。`syncDefaultPermission` 的「配置默认值同步进 harness 默认」技巧有普适价值。

---

### 3.11 一键诊断 /doctor

**实现**：`index.ts:789-847`（命令分支）+ `index.ts:1697-1905`（buildSessionExportZip + findLatestLarkSessionId）+ `application/diagnostics-service.ts`（57 行）+ `status-formatter.ts:40-48`（脱敏）。

**工作原理**：

- **ZIP 打包**：**fflate**（`zipSync + strToU8`，level 6，动态 import，`index.ts:1885-1894`；注释明确用 sync 版，流式 Zip 回调异步会拿到空 buffer）。
- **日志收集范围**：① 主通道 `sessionPersistence.readRaw(sessionId)` 取当前会话 `session.jsonl`（与 GUI「Session log」下载同构）+ `sessionQuery.traceSession` 递归收集**全部子代理日志**（`index.ts:1792-1823`）；② 服务缺失时文件扫描回退：`<DSH_HOME>/sessions/<ws>/<encoded-id>/session.jsonl.zstd` + **node:zlib 内置 `zstdDecompressSync` 解压**（无需系统 unzstd，`index.ts:1828-1860`）；③ `findLatestLarkSessionId` 扫描所有工作区目录找最近写入的 lark-link 会话（`index.ts:1703-1735`，`:` 编码为 `~003A`）。
- **脱敏**：`redactSecrets`（`status-formatter.ts:40-48`）：① 显式 secrets 列表逐字替换 `***`；② 正则掩码所有 ≥32 位 base64 形状 token。脱敏后的配置 JSON + 连接状态 + outbox 计数拼进 `ISSUE.md`（diagnostics-service.ts:25-55），ZIP 内含 session.jsonl + subagents/* + ISSUE.md + README.txt。
- **投递**：`uploadFile(file_type:"file")` → `sender.sendFile`；失败逐级降级：ZIP → 单 .md 文件 → 纯文本回复（`index.ts:806-845`）。

**依赖**：fflate（0.8.x）、node:zlib、DSH sessionPersistence/sessionQuery 服务（可选）、上传链路。

**可裁剪复用性**：**中**。fflate ZIP + 脱敏正则 + 三级降级是通用模板；session log 读取绑定 DSH 服务名与 `~/.dsh/sessions` 目录布局，借鉴方换 harness 需改读取层。脱敏规则（显式列表 + 32 位掩码）值得直接抄。

---

### 3.12 会话管理（conversation-manager + dsh-session-backend + /new /workspace）

**实现**：`sessions/conversation-manager.ts`（137 行）+ `sessions/dsh-session-backend.ts`（199 行，接口 + 内存 mock）+ `sessions/dsh-adapter.ts`（真实实现）+ `index.ts:863-931, 2056-2065`。

**工作原理**：

- **会话 key**：`dm:<chatId>`（p2p）/ `group:<chatId>`（群）（`conversation-manager.ts:53-54`）→ 每 key 一个 DSH agent。
- **session id 构造**：`lark-link:<key>:<runNonce>:<generation>`（`dsh-adapter.ts:166-167`）。⚠️ **关键事实（与 spec 偏差）**：spec ADR-5 声称「sessionKey↔sessionId 持久映射（ctx.storage.domain KV）」，但 **v0.3 实际未实现持久映射**——`runNonce` 每次运行**新鲜生成**（`index.ts:206-216` 大段注释说明：曾持久化 nonce 使 id 跨重启稳定，但 dsh-agent-loop 的 resume 对不匹配日志做懒校验，重启后首轮必挂「id collision」，故放弃，改为**每次重启开新会话行**、旧 log 留在磁盘）。`keyForSessionId` 反向映射仅存于内存（`dsh-adapter.ts:145, 579`）。
- **工作区绑定**：agent 创建时 `meta.cwd` 取 `workspaceRoot`（getter，`/workspace` 热换，`dsh-adapter.ts:378-381`）；`workspaceRegistry.create(cwd, basename) + attachSession(sessionId)` best-effort 归组，否则 GUI 显示「未分组」（`dsh-adapter.ts:441-482`）。
- **/new**（`index.ts:920-931`）：`conversations.rotate(key)`——fresh runNonce + 删 generation + 摘监听/追踪，**不 dispose 旧 agent**（保持 GUI 列表），下条消息开新会话行，命令本身不进 agent。
- **/workspace**（`index.ts:863-913`）：展开 `~`/`~/`，相对路径基于当前工作区 resolve，校验目录存在 → 持久化 workspaceRoot → rotate 当前会话（其他会话不受影响，各自保留）。
- **容量与回收**：`maxSessions`(32) 超限先 dispose 全部 idle、再 250ms 等槽（`conversation-manager.ts:69-77`）；`sessionIdleTtlMs`(30min) + 60s sweep 定时 dispose idle agent（`index.ts:2056-2065`）；per-key FIFO promise 链串行（无全局锁，`conversation-manager.ts:56-67`）。
- **看门狗**：turn-supervisor 10min 超时 dispose agent 解锁（0.1.1 修复 arm 死代码问题）；index.ts:1281-1337 另做「静默失败检测」——turn/end 为 aborted/rejected/failed/error 且无任何输出 → dispose + 主动发提示消息，杜绝「没回复」黑盒。

**依赖**：ctx.agents（create/dispose）、workspaceRegistry、config。

**可裁剪复用性**：**中**。per-key 编排（FIFO/容量/回收/rotate 语义）模式可搬；session id 策略深度绑定 DSH agents 存储与 GUI 会话行语义，且当前实现明确牺牲「跨重启会话连续」换「重启必干净」，借鉴方需自行权衡（本插件的 `/doctor` 用 findLatestLarkSessionId 扫描补偿了日志可查性）。

---

### 3.13 表情回执（reactions）

**实现**：`common/reactions.ts`（242 行）+ `message-handler.ts:221-233`（入站随机）+ `event-forwarder.ts:96-103,147-167`（DONE 时机）+ `bridge-context.ts:170-181`（markDone）+ `command-router.ts:74-84`（命令完成 DONE）。

**工作原理**：

- **随机表情**：入站管道第 4 步（dedupe/allowlist/group 通过后）`createReactionPicker(pool, done).pickRandom()` → `sender.addReaction(messageId, emoji)`（`message-handler.ts:221-233`）。picker 构造时**过滤掉不在 `VALID_EMOJI_TYPES`（190+ 实测有效 emoji_type 全集）里的配置项** + 排除 DONE 标记 + 全失效回退默认 8 枚池（`reactions.ts:225-242`）——陈旧配置不可能 400 桥（pi F2 教训：FIRE 无效 Fire 有效，大小写敏感；231001）。
- **DONE 触发时机**：`turn/end` 且本轮 `hasOutput===true` 且 `doneIssued===false` → `target.markDone()` → `sender.addReaction(route.lastMessageId, "DONE")`（`event-forwarder.ts:161-165`；route.lastMessageId 在入站时记录触发消息，`message-handler.ts:253`）。**空输出不打 DONE**（pi 5ac1c3d）；桥命令回复成功也打 DONE（`command-router.ts:74-84`）。
- **幂等**：每轮 `turn/start` 重置 `hasOutput/doneIssued/acc`（`event-forwarder.ts:96-103`，修复「只有第一条消息有 DONE」）；`doneIssued` 标志防同轮重复；markDone 全程 best-effort catch。

**依赖**：零外部；配置 `reactions.{enabled,pool,done}`（config.ts:27-34）。

**可裁剪复用性**：**高**。纯模块 + 明确的触发时机规则（入站随机 / 完成 DONE / 空输出不打 / 轮级重置），任何 IM 桥都能直接用；「实测有效 emoji 全集 + 配置过滤 + 回退池」防 400 的设计尤其值得原样带走。

---

### 3.14 认证（扫码建应用）

**实现**：`host/auth-setup.ts`（302 行）+ `index.ts:1907-2000`（runSetup）+ `host/lark-client.ts:58-83`（凭据存取）。

**工作原理**：

- **扫码创建应用**：`registerAppWithFetch()`（`auth-setup.ts:195-301`）——**不用 SDK 的 registerApp**（0.1.1 实测根因：SDK 共享 axios 1.19.x 在 Node ESM 下 `default.default` 平台解析错位，https 被赶进 http.request 报协议错误），用 **global fetch 复刻 RFC 8628 device-code 流**：`POST accounts.feishu.cn/oauth/v1/app/registration` begin（archetype=PersonalAgent，auth_method=client_secret）→ 返回 `verification_uri_complete` 拼 QR 参数（from/source/tp/addons）→ 轮询 poll（authorization_pending/slow_down 指数降速/access_denied）→ 拿到 client_id/client_secret。**Lark 国际版自动切换**：poll 响应 `tenant_brand==="lark"` 时一次性把 base URL 切到 accounts.larksuite.com（`auth-setup.ts:257-262`）。
- **自动订阅事件与权限**：`buildSetupAddons()`（`auth-setup.ts:36-42`）——events 显式订阅 `im.message.receive_v1`（pi 血泪教训：registerApp 默认不订阅消息事件）+ scopes `im:message / im:message.send_as_bot / im:chat / im:resource / im:message.group_msg（群聊全量免 @）/ im:message.reactions:write_only` + callbacks `card.action.trigger`；addons 编码 = `base64url(gzip(json))` 与 SDK 字节兼容（`auth-setup.ts:125-132`）。
- **凭据存储**：appId/appSecret/domain 以 JSON blob 存 **ctx.credentials**（ref `LARK_LINK_APP`，`lark-client.ts:58-83`），config.json 只存 ref 名（config.ts:11-13）——secret 永不落桥自己的配置文件；ref 校验正则 `^[A-Za-z_][A-Za-z0-9_]*$`。
- **双通道二维码**：PNG（`qrcode` 包 → 宿主路由 `/plugins/lark-link/qr` 供 GUI 面板）+ 终端 ASCII（`qrcode-terminal`）（`index.ts:1943-1970`）；**非阻塞**设计：registerApp 后台跑，30s 内有界等 QR 出现，避免 GUI「执行中…」挂死（`index.ts:1923-1989`）。
- **手动通道**：`DSH_LARK_APP_ID/SECRET` 环境变量兜底（`index.ts:1909-1922`）。

**依赖**：global fetch（Node ≥24）、qrcode、qrcode-terminal、ctx.credentials（可选）。注意 `axios` 是 package.json 依赖（SDK 传递需要），桥自身不用。

**可裁剪复用性**：**中**。fetch 版 device-code 流 + addons 编码是**完整可搬的独立模块**（不依赖 SDK 内部），飞书/Lark 双域自动切换尤其值钱；但注册协议是飞书特有的，借鉴方做同一平台可直接复用，换平台仅剩「扫码 OAuth → 存凭据」骨架可参考。

---

### 3.15 网关锁（多实例防护）

**实现**：`host/gateway-lock.ts`（130 行）。

**工作原理**（实现层面）：

- **原子抢锁**：`writeFileSync(lockFile, JSON.stringify(owner), {flag:"wx", mode:0600})`——O_EXCL 独占创建无读-写竞态（`gateway-lock.ts:59-67`）。
- **存活校验**：读取锁后 `process.kill(pid, 0)` 验证持有者 pid 存活（EPERM = 活着；ESRCH = 已死；`gateway-lock.ts:38-46`）——**僵尸锁自动清理**（pi 01f978a 根因 #2 教训：不校验 pid 的锁会把桥永久禁用）。
- **心跳与过期**：5s 心跳重写锁文件、30s staleMs（`gateway-lock.ts:83-92`、72-80）。
- **状态读取**：`readLiveGatewayOwner`（`gateway-lock.ts:119-130`）供状态展示。

**⚠️ 接线现状（源码级发现）**：`index.ts` 与 `lifecycle.ts` **均未调用 `acquireGatewayLock`**（grep 零命中）——锁模块 + 单测齐备但主入口未启用。原因可从 spec ADR-12 推断：进程内形态天然单实例，锁是为「web + CLI 双宿主同开」的边界场景设计的，v0.3 尚未接线（属于「备好武器未上膛」）。`BridgeStatus.owner` 字段（types.ts:127）同样无写入方。

**依赖**：node:fs 仅此而已。

**可裁剪复用性**：**高（模块级）**。30 行核心逻辑 + pid 存活校验是教科书级单实例锁，任何「多进程抢一个长连接/一个状态目录」的场景直接抄；但借鉴方要自行决定接线点（建议挂在 startBridge 入口，抢锁失败即 startBlocker）。

---

### 3.16 DSH Web GUI 复用

**实现**：`client/index.ts`（391 行，浏览器侧）+ 宿主侧路由 `index.ts:264-331`。

**工作原理**：

- **注册了什么**：client plugin（`inject:["slots"]`）只注册一个表面——`sidebar.footer.action` slot 的 `lark-link-entry` 入口（order 100，`client/index.ts:380-390`）。桥会话本身 = 原生 DSH session，聊天/流式/工具卡/会话列表/设置页全由 GUI 原生呈现，**零 client 开发**（spec §7「双通道视图：本地 GUI 全量会话 / 远程飞书卡片，同一批 session 的两个投影」）。
- **状态浮层**：侧栏按钮 → popover 状态机（`client/index.ts:80-103`）：未配置→显示 setup 二维码；已配置+stopped→「待启动」；connecting→「连接中」；connected→「运行中」（附 outbox 待发/失败计数）；degraded/quarantined→「连接异常」。数据源 = 3s 轮询宿主 `/plugins/lark-link/status` JSON（含 configured 标志与 BridgeStatus 全量）；QR 为宿主服务的 PNG，4s 轮询刷新（GUI markdown 图片消毒器拒绝 data: URL，且 client 无法 push，故用 host-served 路由 + 轮询，`client/index.ts:153-172`）。
- **portal 到 body**：popover 经 `react-dom.createPortal` 挂到 `document.body`，逃离共享的 sidebar footer slot 容器——同 slot 其他插件（如 dsh-cost-meter 用 MutationObserver 重排容器子节点）不会把浮层挤变形（GH #3，`client/index.ts:34-58, 373-377`）。
- **与桥会话联动**：host 侧注册两条 exact 路由 `/plugins/lark-link/qr` + `/plugins/lark-link/status`（`ctx.webServer.register`，`index.ts:264-331`，ctx.effect 注册随卸载注销）。spec 中「桥事件镜像（conversation.chat.node 插入已转发标记）」是 P1 未实现。

**依赖**：react/react-dom（optional peer）、ctx.slots（inject）、ctx.webServer（host）。

**可裁剪复用性**：**中**。「状态路由 + 轮询浮层 + 二维码 host 服务」是 DSH client 体系下的成熟模板（含 portal 避坑），借鉴方做 DSH 桥接 UI 可直接仿制；若不做 DSH 插件而做独立 GUI，则只有「轮询 + 状态机」思想可参考。

---

### 3.17 去重与幂等

**实现**：`common/dedupe-store.ts`（100 行）+ 入站管道 `message-handler.ts:206-209` + 出站幂等（见 3.1）。

**工作原理**：

- **入站去重键**：飞书 `messageId`（消息级，跨 WS 重投/重复推送天然去重）。`dedupe.add(messageId)` 返回 false = 已见 → 直接 drop（`message-handler.ts:206-209`）；**补偿/补发回放跳过去重**（`compensated=true` 参数，`message-handler.ts:206`）——这是「断连补收」与「崩溃补发」能工作的前提。
- **持久化**：`dedupe.jsonl`（JSON 数组文件），`MAX_RECORDS=10000` 上限 + `prune(ttlMs)` 过期清理（`dedupe-store.ts:18-55`）——重启后跨进程去重仍然有效。
- **跨进程安全**：`acquireDirLock`——原子 mkdir 目录锁 + owner.json + TTL 破锁（`dedupe-store.ts:62-95`），供多进程/测试场景。
- **出站幂等**：outbox `dedupeKey` 入队时判重（3.1 已述）。注意：outbox 接口的 `skipDedupe` 参数（outbox.ts:50,234）**在 v0.3 无实际调用者**——「补偿回放跳过出站去重」实际由入站侧 compensated 标志 + 新 dedupeKey 自然实现（missed-compensation 的 reinject 只重注入入站，输出是新 turn 的新 key）。

**依赖**：零外部。

**可裁剪复用性**：**高**。入站 messageId 去重 + 回放跳过语义 + 持久化是任何桥的必备三件套，模块独立直接搬；「补偿路径跳过去重」的调用约定（compensated 标志贯穿管道）是设计要点。

---

### 3.18 会话对账与启动恢复

**实现**：`index.ts:1357-1509`（startBridge 内联序列）+ `index.ts:2054-2070`（ctx.effect 装配）+ `host/lifecycle.ts`（112 行，**未接线**——index.ts 未 import createLifecycle，start/stop 内联实现）。

**启动顺序**（startBridge，`index.ts:1357-1509`）：

```
1. resolveCredentials（缺凭据 → startBlocker，桥存活但不启动，非致命）
2. buildLarkClient（SDK 懒加载 + defaultHttpInstance.proxy=false 规避环境代理坑）
3. 装配依赖：setConversations/Outbox/Forwarder/Compensation
4. outbox.rebuildFromDisk()（sending→pending 崩溃恢复）+ outbox.start()
5. turnSupervisor.start()（10min 看门狗）
6. createTransport（WS 事件接线：onMessage 先查 pendingQuestions 自定义回答 → handleInbound；onEvent 转 handleCardAction）
7. createQuotaGovernor + createConnectionSupervisor → supervisor.start()（probe 循环）
8. status 计数刷新（outbox + inboundPending）
9. Inbound WAL 启动对账（fire-and-forget 补发，不阻塞启动）
10. setStarted(true)
```

**恢复语义**：
- 出站：outbox 磁盘重建 + 续投（零丢失）；
- 入站：WAL 补发（处理到一半的请求重触发，2 次/30min 防空转）；
- 会话：**不跨重启恢复**（每运行新 runNonce → 新会话行，旧 log 留盘；GUI 显示新对话，`/doctor` 用目录扫描补偿日志可查性）——这是「可靠回复」与「会话连续性」之间的明确取舍（index.ts:206-216 注释为证）；
- 连接：quota 历史落盘跨重启，熔断状态延续。

**卸载**：`ctx.effect(() => { startBridge; 60s sweep; return async disposer → stopBridge })`（`index.ts:2054-2070`）——插件热更新/卸载自动 teardown（turnSupervisor.stop → supervisor.stop → outbox.stop（等在飞投递）→ conversations.disposeAll），幂等可重入。状态目录保留（配置/密钥不误删），`/lark uninstall-clean` 显式清理。

**依赖**：Cordis ctx.effect、ctx.credentials、ctx.webServer、DSH 各服务（均 lazy getter 读取）。

**可裁剪复用性**：**中**。启动序列与 disposer 模式（effect 注册 + 幂等 teardown）是 Cordis 插件的标准范式可仿；服务名与装配细节绑定 DSH；「lifecycle.ts 未接线」提示借鉴方：装配层要么内联要么真正接上，二选一，避免死代码。

---

## 4. 对外能力与已知限制

### 4.1 对外承诺的能力边界（README + CHANGELOG 实证）

**DSH 侧命令**：`/lark setup`（扫码建应用）/ `start` / `stop` / `restart` / `status`（全链路健康）/ `uninstall-clean`（清凭据+状态目录）。

**飞书侧命令**（全部可卡片操作）：
- 选择类：`/mode`（4 preset + 用户自定义，单选卡）/ `/permission`（三档，单选卡）/ `/model`（按供应商分组的单选卡，`provider/model` 或裸 model 切换，会话不中断）
- 状态类：`/status`（连接/outbox 深度/熔断/补发计数）/ `/sessions` / `/help`
- 会话类：`/new`（当前工作区新会话，不进 agent）/ `/stop`（只停本会话）/ `/workspace <路径>`（`~` 展开，热切换）
- 诊断：`/doctor`（ZIP：session log + 子代理日志 + 脱敏配置 + ISSUE.md）
- 热改：`/lark-config key=value`（白名单 10 项：groupPolicy/groupKeywords/alsoOnReply/workspaceRoot/agentPreset/permissionMode/streaming/reactions/denyList/allowlist，禁改 appId/appSecret）
- DSH 注册命令（`/goal` 等）原生执行回飞书；未知命令/普通消息/skill 描述原样注入 agent
- 多媒体：图片→视觉模型；文件→有界文本提取；`lark_send_local_file` 回传（工作区白名单 + 25MB + 格式降级）

**可靠性承诺**：at-least-once 出站（kill -9 重启续投）、入站请求补发（2 次/30min）、断连补收（10min 窗口回放）、配额熔断自动恢复、表情回执（只打实测有效 emoji）、每轮输出逐条投递（空输出不发不打 DONE）。

**默认策略**：groupPolicy=open（群聊免 @）、agentPreset=code（PTC）、permissionMode=danger-full-access（无审批全放开）、streaming 默认关（省流量，热改开）、反应回执默认开。

### 4.2 已知限制（README 未设专章，散见 spec §13 Boundaries / CHANGELOG / 代码注释）

1. **会话不跨重启连续**：重启后桥会话开新 GUI 会话行（旧 log 留盘）——「id 冲突 vs 会话连续」取舍中选了可靠性（index.ts:206-216）。
2. **入站补发仅纯文本**：媒体/命令不纳入 WAL（重放不可靠/可重跑，inbound-wal.ts:16-18）。
3. **流式默认关闭**：CardKit 流式卡是可选增强，默认每轮直发完整回复（省流量决策）。
4. **markdown 卡片 schema 注释与代码不一致**：注释称 schema 1.0 兼容老客户端，代码实际发 2.0（cards.ts:59）——老客户端兼容性存疑但未实测声明。
5. **多宿主锁未启用**：gateway-lock 实现齐备但主入口未接线，web+CLI 同开会各自起桥（当前形态下是已知灰色地带）。
6. **DSH resume 不可用**：dsh-agent-loop 的 resume 对不匹配日志做懒校验，桥被迫放弃复用（dsh-adapter.ts:392-400）。
7. **SDK 兼容坑（已规避但需知晓）**：SDK registerApp 的 axios ESM 平台 bug → fetch 复刻；环境代理变量 → `defaultHttpInstance.proxy=false`（会连带禁用 SDK 全局代理）。
8. **飞书平台硬约束**：emoji 大小写敏感（Fire≠FIRE）、file_type 白名单（非 `opus|mp4|pdf|doc|xls|ppt|stream` 一律 stream）、图片上传仅光栅格式、schema 2.0 header 必须顶层（200621）、按钮不能有 tag:action 容器（200861）。
9. **never 清单**（spec §13）：不 pin SDK 版本、不用 SDK autoReconnect、不 fire-and-forget 吞错、不在 .env 写 DSH_*、不注册 approval 应答者、不删用户状态目录除非显式命令。

---

## 5. 同类项目快扫

DSH 生态 2026-08 正处于「IM 桥接插件爆发期」，GitHub 搜索到一批**同周创建**的竞品，但普遍处于 v0.x 早期、star 个位数、无成熟头部。按相关度排序：

### 候选 1：BiBoyang/dsh-im-bridge ⭐4
- **定位**：DSH→IM 桥（v0.1 微信/iLink 落地；钉钉/飞书/Telegram 预留）。方向与 lark-link 不同：主打 **turn/approval 推送 + 远程批准/注入**（远程看到工具调用并批准/否决），而非对话式桥接。
- **核心特性**：持久去重 / 收敛分段 / 合并窗口（长输出分段推送控制）。
- **维护状态**：2026-08-13 创建即最后推送（1 天内无后续），无 license。
- **可借鉴点**：①「远程审批/注入」是 lark-link 明确放弃的方向（无审批决策）——若你的桥需要审批面，这是唯一参照系；② 合并窗口/收敛分段是长输出推送的通用技巧。

### 候选 2：LosEcher/dsh-channel-telegram ⭐0（MIT）
- **定位**：**薄** Telegram 桥：Bot API long-poll（无 WS）、allowlist、per-chat agent sessions。
- **核心特性**：DSH bundle 格式、以「薄」为设计原则（long-poll 免长连接运维）。
- **维护状态**：2026-08-15 创建（2 天前），1 次推送。
- **可借鉴点**：① long-poll 替代 WS 的简化路径（如果你的平台没有 WS 事件订阅）；② allowlist 的最小实现。

### 候选 3：One1turn/dsh-omnibridge ⭐0
- **定位**：AstrBot 风格多平台桥：QQ(OneBot)/Telegram/Discord/KOOK/Slack/Feishu/WeCom/DingTalk/LINE/webchat 等 **19 平台一插件**。
- **核心特性**：平台抽象层 + 统一事件模型。
- **维护状态**：2026-08-14 创建，仅 1 次推送，无 license。
- **可借鉴点**：平台适配器抽象（如果你计划多平台，其 adapter 分层可参考；但 19 平台铺开通常意味着每平台深度不足，与 lark-link「单平台做深」路线相反）。

### 其他（低相关度）
- yansenlei/dsh-plugin-telegram-bridge ⭐0（TG 桥，npx 一键装，2026-08-16 创建）
- kazecreator/dsh-plugins ⭐1（monorepo 含 dsh-im：Telegram+WeChat）
- awesome-dsh-plugin/awesome-dsh-plugin ⭐3108（DSH 插件精选列表，IM 桥接是其中新分类；dsh-lark-link 已提交收录草案 ISSUE-awesome-dsh-plugins.md）

### 快扫结论
**DSH×IM 桥接生态处于「同一周内各自从零起跑」的状态，无垄断性成熟项目**；star 数据（11/4/1/0/0）证明尚无可验证的社区选择。dsh-lark-link 是本类目中完成度最高的（spec 先行 + 156 测试 + 分层纪律 + 从 pi 系移植的成熟可靠性机制），其余候选均在「最小可用」粒度。借鉴方的策略建议：**机制层以 dsh-lark-link 为主基准**（尤其可靠性五件套：outbox/WAL/配额熔断/断连补偿/三级分流），若目标平台是 Telegram 类无 WS 的，参考 LosEcher 的 long-poll 简化；若需要审批面，参考 BiBoyang 的方向（但注意与 lark-link「无审批全放开」的产品决策直接冲突，二选一）。

---

## 附录 A：18 项机制可裁剪复用性速查

| # | 机制 | 复用性 | 一句话理由 |
| --- | --- | --- | --- |
| 1 | Outbox 零丢失 | **高** | 零依赖独立模块，换 sender 即通用可靠投递队列 |
| 2 | Inbound WAL 补发 | **高** | 存储原语独立 + 对账胶水仅 50 行，任何桥都值得抄 |
| 3 | 连接自愈+配额熔断 | **高** | harness-agnostic 纯模块，5 方法接口，场景无关 |
| 4 | 命令三级分流 | 中 | 路由逻辑可搬，Tier2 绑定 DSH commands API 形状 |
| 5 | 入站多媒体 | 中 | 下载/嗅探/双落盘流程可搬，绑定飞书资源 API + DSH ImageBlock |
| 6 | lark_send_local_file | 中 | 工具+白名单+大小+降级是通用模板，上传细节飞书特有 |
| 7 | Markdown→CardKit | **高** | 纯函数 + 阈值决策，直接复制 |
| 8 | 意图确认卡片 | 中 | shadow 工具+pending Map 骨架可搬，卡片/回调绑定飞书 |
| 9 | /mode preset | 中 | 卡片+热改可搬；preset 快照→rotate 重建是 DSH 特性 |
| 10 | /permission | 中 | 卡片可搬；拦截/放行全在 DSH 侧，桥只是配置同步器 |
| 11 | /doctor | 中 | fflate ZIP+脱敏+三级降级是模板，日志读取绑定 DSH 布局 |
| 12 | 会话管理 | 中 | per-key 编排可搬；session id 策略绑定 DSH 且牺牲跨重启连续 |
| 13 | 表情回执 | **高** | 纯模块+明确触发规则+实测 emoji 全集防 400 |
| 14 | 认证 | 中 | fetch 版 device-code 流可整搬（同平台）；协议飞书特有 |
| 15 | 网关锁 | **高（模块级）** | 30 行原子锁+pid 存活校验教科书实现；但主入口未接线，需自定接线点 |
| 16 | Web GUI 复用 | 中 | 状态路由+轮询浮层是 DSH client 模板；绑定 slots/webServer |
| 17 | 去重与幂等 | **高** | 独立模块 +「补偿路径跳过去重」调用约定清晰 |
| 18 | 会话对账与启动恢复 | 中 | 启动序列/disposer 模式可仿；服务名绑定 DSH；lifecycle.ts 未接线 |

## 附录 B：借鉴优先级建议（Top 5）

1. **Outbox 持久队列**（#1）——零丢失是桥的核心卖点，模块零依赖可整包搬；
2. **Inbound WAL 入站补发**（#2）——「处理到一半崩溃」是真实高频故障，成本极低收益极高；
3. **QuotaGovernor + 连接自愈**（#3）——防配额烧穿/断线自愈，纯模块可搬；
4. **表情回执 + 实测 emoji 全集**（#13）——低成本高感知的 UX 细节，防 400 的过滤器设计值得原样带走；
5. **Markdown 检测 + 卡片降级**（#7）——纯函数直抄，配合同样抄「超长/失败回退纯文本」的降级链。
