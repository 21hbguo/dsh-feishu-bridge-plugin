/**
 * 工具调用审批卡片系统（进程内版，与 src/questions.ts 的 M18 提问卡片同构）。
 *
 * agent 回合内工具调用被审批策略挂起时（tools/pre-execute `{kind:'ask'}` →
 * ctx.approval.request），host 侧 api-proxy 的 approval answerer 为请求 mint
 * rpcId 并推送 `approval/requested` 帧到 events.mux（api-proxy.ts:1422-1488，
 * 帧定义 api/events.ts:72，信封 api/rpc.ts:171-176）；本模块独立订阅一条 mux 流
 * （与 questions.ts 的订阅互不干扰），按 `chatIdForSession` 反查飞书 chat，渲染
 * 「✅ 允许一次 / 🚫 拒绝」审批卡；用户点按钮后用
 * `ctx.apiProxy.respond(ClientResponse)` 把决定提交回 host
 * （api-proxy.ts:3699-3710，成功载荷见 api/approvals.ts:17-20）。host 结算后
 * 广播 `approval/resolved` 帧（api/events.ts:73，**无 rpcId**）——本模块按
 * approvalId 维护映射撤卡/禁用按钮。
 *
 * 与 questions.ts 的差异：
 * 1. 帧类型为 approval/requested|resolved（非 question/*）；resolved 帧不带
 *    rpcId，故 pending 登记键用 approvalId（按钮 value 即编码 approvalId）。
 * 2. 客户端不可提交 cancelled（ApprovalResponsePayload.outcome 只收
 *    allowed-once|rejected，approvals.ts:17-20、schema:20）→ 过期只撤卡 + log，
 *    不向 host 提交任何东西；host 侧 pending 由 agent 侧 abort 结算
 *    'cancelled'（api-proxy.ts:1419-1421、1470-1473）。
 * 3. mux 流意外结束时带退避重新订阅：断线重连后 host 以同 rpcId 重放仍 pending
 *    的 approval/requested 帧（api-proxy.ts:3447），已登记的 approvalId 跳过防
 *    重复发卡。
 *
 * 接线（由 index.ts 统一做，本文件不 import index.ts）：apply 的 effect 内调用
 * `registerApproval({ ctx, channel, chatIdForSession, log })`，把返回的 `dispose`
 * 并入 teardown。审批决定只有按钮一个入口，无需 handle() 接线点。
 */
import { randomUUID } from 'node:crypto'
import type { CardActionEvent, LarkChannel } from '@larksuiteoapi/node-sdk'
import type { Context } from 'cordis'

/** Pending 审批有效期：发卡后 10 分钟未响应即过期（与 question TTL 一致）。 */
const APPROVAL_TTL_MS = 10 * 60 * 1000
/** 过期回收扫描周期（与 question reaper 一致）。 */
const REAPER_INTERVAL_MS = 60 * 1000
/** mux 流意外结束后重新订阅的退避间隔（ms）。 */
const MUX_RETRY_MS = 2000

// ---------------------------------------------------------------------------
// apiproxy 契约的进程内视图（结构镜像，不 import @deepseek-ai/dsh-host-apiproxy
// —— 未声明的依赖；取值自 api/events.ts:69-75、api/rpc.ts:179-193、
// api/approvals.ts:17-20、api-proxy.ts:3699-3710、3447）
// ---------------------------------------------------------------------------

/** 审批按钮回调 value 编码：`appr|<approvalId>|allow|reject`（含 approvalId 与 outcome）。 */
function approvalButtonValue(approvalId: string, outcome: 'allow' | 'reject'): string {
  return `appr|${approvalId}|${outcome}`
}

/** 审批请求帧载荷（api/events.ts:72 镜像）。 */
interface BridgeApprovalRequestedFrame {
  type: 'approval/requested'
  sessionId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
}

/** 审批已结算帧载荷（api/events.ts:73 镜像；无 rpcId）。 */
interface BridgeApprovalResolvedFrame {
  type: 'approval/resolved'
  sessionId: string
  approvalId: string
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | (string & {})
}

/** mux 帧载荷：只读本模块关心的字段，其余帧原样透传（含 session/event）。 */
interface BridgeMuxPayload {
  type: string
  sessionId?: string
  approvalId?: string
  toolName?: string
  callId?: string
  reason?: string
  outcome?: string
  [key: string]: unknown
}

/** 审批应答 ClientResponse 信封（api/rpc.ts:179-183 镜像；成功载荷 api/approvals.ts:17-20）。 */
interface BridgeApprovalClientResponse {
  type: 'client-response'
  rpcId: string
  result: {
    ok: true
    value: { sessionId: string; approvalId: string; outcome: 'allowed-once' | 'rejected' }
  }
}

/** RpcReceipt（api/rpc.ts:193 镜像）。 */
type BridgeRpcReceipt = { accepted: true } | { accepted: false; reason: 'not-pending' | 'bad-response' }

/** ApiProxy 的进程内视图：只取 events.mux + respond 两个面（api/index.ts:22-42）。 */
interface BridgeApiProxy {
  events: {
    mux(request: { rpcId: string; payload: Record<string, unknown> }, signal: AbortSignal): AsyncIterable<{ rpcId: string; payload: BridgeMuxPayload }>
  }
  respond(message: BridgeApprovalClientResponse): Promise<BridgeRpcReceipt>
}

/** registerApproval 需要的运行时依赖（由 index.ts 提供；接口在此定义，不改 types.ts）。 */
export interface ApprovalRuntime {
  /** cordis 上下文：取 apiProxy / loader 服务。 */
  ctx: Context
  /** 飞书 channel：发卡/更新卡/卡片回调。 */
  channel: LarkChannel
  /** 反查拥有某 DSH sessionId 的飞书 chat（与 questions.ts 同源，index.ts chatIdForSession）。 */
  chatIdForSession(sessionId: string): string | undefined
  /** YOLO 免审批查询：true 时该 chat 的审批帧自动放行（不弹卡片；由 index.ts 提供）。 */
  isYolo(chatId: string): boolean
  /** 日志（复用 runtime.log）。 */
  log(...args: unknown[]): void
}

/** registerApproval 的返回值：供 index.ts 接线（teardown）。 */
export interface ApprovalBridge {
  /** 卸载：中止 mux 订阅、摘 cardAction 监听、停 reaper、清映射。不向 host 提交（客户端无可提交的 cancelled）。 */
  dispose(): void
}

/** 一张 pending 审批卡的本地登记（键 = approvalId，resolved 帧无 rpcId 故不用 rpcId 作键）。 */
interface PendingApprovalEntry {
  approvalId: string
  /** host mint 的稳定 server-request id：respond 必须回显（api/rpc.ts:171-176）。 */
  rpcId: string
  sessionId: string
  toolName: string
  callId?: string
  reason?: string
  chatId: string
  cardMessageId: string
  cardId: string
  expiresAt: number
}

/** 卡片终态（撤卡时的展示文案），'pending' 之外的取值都会禁用按钮。 */
type ApprovalCardStatus = 'pending' | 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | 'expired'

/** 任意抛出值的一行错误文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** reason 超长截断，避免审批卡内容过大。 */
function shorten(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** resolved 帧 outcome → 卡片终态（cancelled/unavailable 是 host 侧结算值）。 */
function resolvedOutcomeStatus(outcome: string): Exclude<ApprovalCardStatus, 'pending'> {
  if (outcome === 'allowed-once') return 'allowed-once'
  if (outcome === 'rejected') return 'rejected'
  if (outcome === 'cancelled') return 'cancelled'
  return 'unavailable'
}

/** 终态 footer 文案：allowed-once/rejected 是用户决定，cancelled/unavailable 是 host 侧结算。 */
function statusLabel(status: ApprovalCardStatus): string {
  switch (status) {
    case 'allowed-once': return '✅ 已允许（本次调用）'
    case 'rejected': return '🚫 已拒绝'
    case 'cancelled': return '已取消（回合已取消）'
    case 'unavailable': return '已结束（审批通道不可用）'
    case 'expired': return '⏰ 已过期（超时未处理）'
    default: return 'pending'
  }
}

/**
 * 装配工具审批卡片系统：订阅进程内 approval/requested → 发飞书审批卡；cardAction
 * 路由 appr/*；approval/resolved → 撤卡；10 分钟过期 reaper（撤卡 + log，不提交
 * host）；mux 流意外结束带退避重新订阅（重放帧按 approvalId 去重）。
 *
 * apiProxy 服务可能晚于本插件装配（web-app bundle 顺序不定）：先即时尝试，若
 * 未就绪则等 loader.await() 后再试一次；两种情况下都没有 apiProxy 就静默降级
 * （审批卡片功能关闭，插件其余功能不受影响）。不注册 ctx.approval answerer——
 * 会与 api-proxy 的 answerer 抢终态（waterfall 认领即抢走 web GUI 审批卡）。
 */
export function registerApproval(runtime: ApprovalRuntime): ApprovalBridge {
  const { ctx, channel, chatIdForSession, isYolo, log } = runtime

  /** pendingApprovals: approvalId -> entry（键不用 rpcId，resolved 帧无 rpcId）。 */
  const pendingApprovals = new Map<string, PendingApprovalEntry>()
  /** cardId -> 下一个更新序列号：必须从小递增，飞书拒绝 epoch 时间戳。 */
  const cardkitSequences = new Map<string, number>()

  const ac = new AbortController()
  const disposers: Array<() => void> = []
  let retryTimer: NodeJS.Timeout | undefined
  let started = false
  let disposed = false

  /** 发卡片实体 + 引用发送，之后可用 card_id 全量更新（与 questions.ts sendCardkit 同构）。 */
  async function sendCardkit(chatId: string, card: object): Promise<{ messageId: string; cardId: string }> {
    const r = await channel.rawClient.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(card) },
    })
    const cardId = r.data?.card_id
    if (cardId === undefined) throw new Error('cardkit.card.create returned no card_id')
    const { messageId } = await channel.send(chatId, { card: { type: 'card', data: { card_id: cardId } } }, {})
    return { messageId, cardId }
  }

  /** 按 card_id 全量更新卡片实体（与 questions.ts updateCardkit 同构）。 */
  async function updateCardkit(cardId: string, card: object): Promise<void> {
    const sequence = (cardkitSequences.get(cardId) ?? 0) + 1
    cardkitSequences.set(cardId, sequence)
    await channel.rawClient.cardkit.v1.card.update({
      path: { card_id: cardId },
      data: { card: { type: 'card_json', data: JSON.stringify(card) }, sequence },
    })
  }

  /** 从登记表摘除一条 pending。 */
  function dropEntry(approvalId: string): void {
    pendingApprovals.delete(approvalId)
  }

  /** 撤卡：禁用按钮 + 标记终态，卡留在聊天历史（与 questions.ts finishQuestionCard 同构）。 */
  async function finalizeApprovalCard(entry: PendingApprovalEntry, status: Exclude<ApprovalCardStatus, 'pending'>): Promise<void> {
    if (entry.cardId === '') {
      // YOLO 自动放行路径没有卡片：只记录终态，不更新 cardkit。
      log(`approval settled without card (yolo): approvalId=${entry.approvalId} status=${status}`)
      return
    }
    try {
      await updateCardkit(entry.cardId, approvalCard(entry, status))
      log(`approval card finalized: msg=${entry.cardMessageId} status=${status}`)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      log(`approval card finalize FAILED: ${typeof code === 'string' ? code : ''} ${errorMessage(error)}`)
    }
  }

  /**
   * 结算一条 pending：摘表 + 用 `api.respond(ClientResponse)` 提交决定回 host
   * （进程内直调，不走网络；api-proxy.ts:3699-3710）。outcome 只收
   * allowed-once|rejected——客户端没有 cancelled 分支。
   * @param keepRegistered - true 时保留 pending 登记（YOLO 自动放行用：重放帧按
   *   approvalId 去重、resolved 帧到达时正常清理；默认 false 与既有卡片路径一致）。
   */
  async function resolveApproval(entry: PendingApprovalEntry, outcome: 'allowed-once' | 'rejected', keepRegistered = false): Promise<void> {
    const api = ctx.get('apiProxy') as BridgeApiProxy | undefined
    if (!keepRegistered) dropEntry(entry.approvalId)
    if (api === undefined) {
      log(`approval resolve skipped (apiProxy unavailable): approvalId=${entry.approvalId} outcome=${outcome}`)
      return
    }
    const body: BridgeApprovalClientResponse = {
      type: 'client-response',
      rpcId: entry.rpcId, // 必须回显 approval/requested 帧的 rpcId
      result: { ok: true, value: { sessionId: entry.sessionId, approvalId: entry.approvalId, outcome } },
    }
    try {
      const receipt = await api.respond(body)
      const status = receipt.accepted ? 'accepted' : `rejected(${receipt.reason})`
      log(`approval resolved via respond: approvalId=${entry.approvalId} outcome=${outcome} ${status}`)
    } catch (error) {
      log('approval respond failed:', errorMessage(error))
    }
  }

  /** approval/requested 帧：反查 chat、发卡、登记（断线重放的同 approvalId 帧跳过）。 */
  async function handleApprovalRequested(frame: BridgeApprovalRequestedFrame, rpcId: string): Promise<void> {
    const { sessionId, approvalId, toolName, callId, reason } = frame
    if (approvalId === '') {
      log('approval frame without approvalId — skipping')
      return
    }
    if (rpcId === '') {
      log('approval frame without rpcId — skipping')
      return
    }
    if (pendingApprovals.has(approvalId)) {
      log(`approval frame replayed (card already sent): approvalId=${approvalId}`)
      return
    }
    const chatId = chatIdForSession(sessionId)
    if (chatId === undefined) {
      log(`approval frame for unknown chat (session ${sessionId}) — skipping`)
      return
    }
    if (isYolo(chatId)) {
      // YOLO 免审批：不发卡片，直接回 allowed-once（rpcId 回显同现有逻辑）；
      // 仍登记 pending（断线重放帧按 approvalId 去重、resolved 帧到达时正常清理），
      // 并给 chat 回一条轻量文本（reason 过长截断）。
      const entry: PendingApprovalEntry = {
        approvalId, rpcId, sessionId, toolName, callId, reason, chatId,
        cardMessageId: '', cardId: '',
        expiresAt: Date.now() + APPROVAL_TTL_MS,
      }
      pendingApprovals.set(approvalId, entry)
      log(`approval auto-allowed (yolo): approvalId=${approvalId} rpcId=${rpcId} chat=${chatId} tool=${toolName}`)
      await resolveApproval(entry, 'allowed-once', true)
      const reasonSuffix = reason !== undefined && reason !== '' ? `（${shorten(reason, 80)}）` : ''
      try {
        await channel.send(chatId, { text: `⚡ YOLO：已自动批准 ${toolName || '未知工具'}${reasonSuffix}` }, {})
      } catch (error) {
        log('approval yolo notice send failed:', errorMessage(error))
      }
      return
    }
    const entry: PendingApprovalEntry = {
      approvalId, rpcId, sessionId, toolName, callId, reason, chatId,
      cardMessageId: '', cardId: '',
      expiresAt: Date.now() + APPROVAL_TTL_MS,
    }
    const { messageId, cardId } = await sendCardkit(chatId, approvalCard(entry, 'pending'))
    entry.cardMessageId = messageId
    entry.cardId = cardId
    pendingApprovals.set(approvalId, entry)
    log(`approval card sent: approvalId=${approvalId} rpcId=${rpcId} chat=${chatId} tool=${toolName} cardId=${cardId}`)
  }

  /** approval/resolved 帧：host 已结算（用户在其他端回答或 agent 侧取消）——撤卡收尾。 */
  async function handleApprovalResolved(frame: BridgeApprovalResolvedFrame): Promise<void> {
    const entry = pendingApprovals.get(frame.approvalId)
    if (entry === undefined) return
    dropEntry(frame.approvalId)
    const status = resolvedOutcomeStatus(frame.outcome)
    log(`approval resolved: approvalId=${frame.approvalId} outcome=${frame.outcome}`)
    await finalizeApprovalCard(entry, status)
  }

  /** 卡片按钮回调路由：`appr|<approvalId>|allow|reject`（与 questions.ts onCardAction 同构）。 */
  async function onCardAction(evt: CardActionEvent): Promise<void> {
    try {
      const value = evt?.action?.value
      if (typeof value !== 'object' || value === null) return
      const key = (value as { key?: unknown }).key
      if (typeof key !== 'string') return
      const parts = key.split('|')
      if (parts[0] !== 'appr') return
      const approvalId = parts[1] ?? ''
      const outcomeToken = parts[2]
      if (approvalId === '' || (outcomeToken !== 'allow' && outcomeToken !== 'reject')) return
      const entry = pendingApprovals.get(approvalId)
      if (entry === undefined) {
        log(`approval cardAction for unknown/settled approvalId=${approvalId} — ignoring`)
        return
      }
      if (entry.expiresAt < Date.now()) {
        log(`approval cardAction after expiry — retiring card without submitting: approvalId=${approvalId}`)
        dropEntry(approvalId)
        await finalizeApprovalCard(entry, 'expired')
        return
      }
      const outcome: 'allowed-once' | 'rejected' = outcomeToken === 'allow' ? 'allowed-once' : 'rejected'
      await resolveApproval(entry, outcome)
      await finalizeApprovalCard(entry, outcome)
    } catch (error) {
      log('approval cardAction handling failed:', errorMessage(error))
    }
  }

  /** 消费 mux 流：只关心 approval/requested 与 approval/resolved，其余帧忽略。 */
  async function consumeMux(api: BridgeApiProxy): Promise<void> {
    try {
      const stream = api.events.mux({ rpcId: randomUUID(), payload: {} }, ac.signal)
      for await (const envelope of stream) {
        const rpcId = envelope.rpcId
        if (typeof rpcId !== 'string' || rpcId === '') continue
        const payload = envelope.payload
        if (payload.type === 'approval/requested') {
          const { sessionId, approvalId, toolName, callId, reason } = payload
          if (typeof sessionId !== 'string' || typeof approvalId !== 'string') continue
          void handleApprovalRequested({
            type: 'approval/requested',
            sessionId,
            approvalId,
            toolName: typeof toolName === 'string' ? toolName : '',
            ...(typeof callId === 'string' && callId !== '' ? { callId } : {}),
            ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
          }, rpcId).catch((error) => log('approval handling failed:', errorMessage(error)))
        } else if (payload.type === 'approval/resolved') {
          const { sessionId, approvalId, outcome } = payload
          if (typeof sessionId !== 'string' || typeof approvalId !== 'string') continue
          void handleApprovalResolved({
            type: 'approval/resolved',
            sessionId,
            approvalId,
            outcome: typeof outcome === 'string' ? outcome : '',
          }).catch((error) => log('approval resolved handling failed:', errorMessage(error)))
        }
      }
    } catch (error) {
      if (!ac.signal.aborted) log('approval mux stream ended:', errorMessage(error))
    }
    // 流意外结束（非主动中止）：退避后重新订阅；host 会以同 rpcId 重放仍 pending
    // 的 approval/requested 帧（api-proxy.ts:3447），handleApprovalRequested 按
    // approvalId 去重，不会重复发卡。
    if (!ac.signal.aborted && !disposed) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        void consumeMux(api).catch((error) => log('approval mux re-subscribe failed:', errorMessage(error)))
      }, MUX_RETRY_MS)
      retryTimer.unref()
    }
  }

  /** 启动本体：apiProxy 就绪后注册 cardAction 监听 + reaper + mux 消费。 */
  function start(api: BridgeApiProxy): void {
    started = true
    disposers.push(channel.on('cardAction', onCardAction))
    disposers.push(() => ac.abort())
    // 过期回收：只撤卡 + log，不向 host 提交（客户端无 cancelled 分支；host 侧
    // pending 由 agent 侧 abort 结算 'cancelled'，api-proxy.ts:1470-1473）。
    const reaper = setInterval(() => {
      const now = Date.now()
      const expired: PendingApprovalEntry[] = []
      for (const entry of pendingApprovals.values()) {
        if (entry.expiresAt < now) expired.push(entry)
      }
      for (const entry of expired) {
        dropEntry(entry.approvalId)
        log(`approval expired (card retired, host not notified): approvalId=${entry.approvalId}`)
        void finalizeApprovalCard(entry, 'expired')
      }
    }, REAPER_INTERVAL_MS)
    reaper.unref()
    disposers.push(() => clearInterval(reaper))
    void consumeMux(api)
    log('approval ready: mux subscribed, approval cards enabled')
  }

  /** apiProxy 就绪探测：即时尝试一次；未就绪则等 loader 装配完成后重试（与 questions.ts 同构）。 */
  const loader = ctx.get('loader') as { await(): Promise<void> } | undefined
  function trySetup(quiet: boolean): void {
    if (started || disposed) return
    const api = ctx.get('apiProxy') as BridgeApiProxy | undefined
    if (api === undefined) {
      if (!quiet) log('approval: apiProxy service unavailable — approval cards disabled')
      return
    }
    start(api)
  }
  trySetup(loader !== undefined)
  if (loader !== undefined) {
    void loader.await()
      .then(() => trySetup(false))
      .catch((error) => log('approval: loader await failed:', errorMessage(error)))
  }

  /** 卸载：停流、摘监听、停 reaper/重试定时器、清映射（不向 host 提交任何东西）。 */
  function dispose(): void {
    if (disposed) return
    disposed = true
    ac.abort()
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    for (const off of disposers.splice(0)) {
      try { off() } catch { /* already gone */ }
    }
    pendingApprovals.clear()
    cardkitSequences.clear()
  }

  return { dispose }
}

/** 构建一张审批卡：工具名 + 原因 + 允许一次/拒绝按钮（pending 可点，终态禁用）。 */
function approvalCard(entry: PendingApprovalEntry, status: ApprovalCardStatus): object {
  const pending = status === 'pending'
  const elements: object[] = [
    { tag: 'markdown', content: `**🔧 工具审批请求**\n<font color=grey>agent 回合内需要你的批准才能继续。</font>` },
    { tag: 'markdown', content: `**工具调用：${entry.toolName || '（未知工具）'}**` },
  ]
  if (entry.reason !== undefined && entry.reason !== '') {
    elements.push({ tag: 'markdown', content: shorten(entry.reason) })
  }
  if (entry.callId !== undefined && entry.callId !== '') {
    elements.push({ tag: 'markdown', content: `<font color=grey>工具调用 ID：${entry.callId}</font>` })
  }
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '✅ 允许一次' },
    type: 'primary',
    disabled: !pending,
    behaviors: [{ type: 'callback', value: { key: approvalButtonValue(entry.approvalId, 'allow') } }],
  })
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '🚫 拒绝' },
    type: 'default',
    disabled: !pending,
    behaviors: [{ type: 'callback', value: { key: approvalButtonValue(entry.approvalId, 'reject') } }],
  })
  elements.push({
    tag: 'markdown',
    content: `<font color=grey>${pending ? '此审批仅对本次工具调用生效，等待你的决定…' : statusLabel(status)}</font>`,
  })
  return { schema: '2.0', config: { update_multi: true }, body: { elements } }
}
