/**
 * @dsh-external/dsh-feishu-bridge — 飞书机器人 ↔ DSH 对话桥（DSH 进程内 Cordis 插件）。
 *
 * 从独立进程 bridge.mjs（1343 行）移植：原「web BFF HTTP RPC + events.mux
 * WebSocket」的 DSH 访问层（bridge.mjs M5/M6/M7/M8）替换为进程内 ctx 服务直调
 * （ctx.get('agents') + ctx.on('session/event') + agent.followup/steer/cancel），
 * 其余业务逻辑照搬：飞书 Channel 收发与流式卡片（M4/M12）、每 chat 串行队列与
 * 插队（M9/M13）、看门狗（M16，超时改为 cancel + 错误卡片，**不退出进程**）、
 * @提及剥离/截断/token 格式化（M10）、handle 入口（M15）、斜杠命令子集（M17）。
 *
 * 明确不做：RUNTIME=local 模式（M8）、任何 UI/client 代码与模型工具注册。
 * M18 提问/问答卡片系统见 src/questions.ts（进程内 api.respond，不注册
 * userQuestions provider）；/workspace /model /resume 命令见 src/commands.ts。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { Context } from 'cordis'
import z from 'schemastery'
import { createBatcher } from './batching.js'
import { registerApproval } from './approval.js'
import { registerCommands } from './commands.js'
import { registerQuestions } from './questions.js'
import { buildChannel } from './lark.js'
import { loadState, saveState, sessionIdFor, type BridgeState } from './state.js'
import { formatTokens, stripMentions, truncate } from './text.js'
import type {
  BridgeAgent,
  BridgeAgentRegistry,
  BridgeModelPreference,
  BridgeSessionEvent,
  BridgeSessionPersistence,
  BridgeTokenMeter,
  BridgeTokenUsage,
  BridgeWorkspaceRegistry,
} from './types.js'

/** Source tag stamped on every user message the bridge injects. */
const PLUGIN_SOURCE = 'dsh-feishu-bridge'

export const name = '@dsh-external/dsh-feishu-bridge'
export const inject = ['agents']

export interface Config {
  /** 飞书应用 ID（缺省读 FEISHU_APP_ID）。 */
  feishuAppId: string
  /** 飞书应用密钥（缺省读 FEISHU_APP_SECRET）。 */
  feishuAppSecret: string
  /** 流式卡片总开关（每会话 /stream 可覆盖）。 */
  stream: boolean
  /** 看门狗时长：单回合超过该毫秒数则 cancel 该回合并回错误卡片。 */
  maxTurnMs: number
  /** 插队阈值：运行中回合超过该毫秒数，新消息打断它优先处理。 */
  interruptAfterMs: number
  /** 飞书流式卡片推送节流间隔（ms）。 */
  streamThrottleMs: number
  /** 飞书流式卡片推送触发字符数。 */
  streamThrottleChars: number
  /** 非流式回复截断阈值（字符）。 */
  maxReplyChars: number
  /** 消息突发批处理窗口（ms）：窗口内同一聊天的连续普通消息合并为一条进 DSH；0 = 禁用。 */
  batchWindowMs: number
}

export const Config = z.object({
  feishuAppId: z.string().default(''),
  feishuAppSecret: z.string().default(''),
  stream: z.boolean().default(true),
  maxTurnMs: z.number().default(600_000),
  interruptAfterMs: z.number().default(10_000),
  streamThrottleMs: z.number().default(40),
  streamThrottleChars: z.number().default(12),
  maxReplyChars: z.number().default(4000),
  batchWindowMs: z.number().min(0).default(800),
})

/** One-line error text from any thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: Context, config: Config): void {
  // Credentials: Config wins, environment as fallback (bridge.mjs M2 env semantics).
  const appId = config.feishuAppId !== '' ? config.feishuAppId : (process.env.FEISHU_APP_ID ?? '')
  const appSecret = config.feishuAppSecret !== '' ? config.feishuAppSecret : (process.env.FEISHU_APP_SECRET ?? '')
  if (appId === '' || appSecret === '') {
    throw new Error(`${name}: FEISHU_APP_ID / FEISHU_APP_SECRET are required (Config or environment)`)
  }
  const channel = buildChannel({
    appId,
    appSecret,
    streamThrottleMs: config.streamThrottleMs,
    streamThrottleChars: config.streamThrottleChars,
  })
  const runtime = createRuntime(ctx, channel, config, appId)
  // One effect owns the whole bridge lifetime: channel listeners, the global
  // session/event feed, the (re)connect loop, and the teardown disposer.
  ctx.effect(() => {
    const offs: Array<() => void> = []
    offs.push(ctx.on('session/event', (session, event) => {
      if (!session.id.startsWith('feishu-')) return
      runtime.onGlobalSessionEvent(session.id, event)
    }))
    offs.push(channel.on('error', (err) => runtime.log('channel error:', err.code, err.message)))
    offs.push(channel.on('reconnecting', () => runtime.log('channel reconnecting…')))
    offs.push(channel.on('reconnected', () => runtime.log('channel reconnected')))
    offs.push(channel.on('message', (msg) => {
      void runtime.handle(msg).catch((error) => runtime.log('message handling failed:', errorMessage(error)))
    }))
    void runtime.connectChannel()
    return () => {
      for (const off of offs) {
        try { off() } catch { /* already gone */ }
      }
      runtime.dispose()
    }
  }, `${name}: channel + session events`)
}

/** Public surface of the bridge runtime, consumed by the apply effect. */
interface BridgeRuntime {
  log(...args: unknown[]): void
  onGlobalSessionEvent(sessionId: string, event: BridgeSessionEvent): void
  handle(msg: NormalizedMessage): Promise<void>
  connectChannel(): Promise<void>
  dispose(): void
}

function createRuntime(ctx: Context, channel: LarkChannel, config: Config, appId: string): BridgeRuntime {
  // ------------------------------------------------------------ persistent state (M3)
  const state: BridgeState = loadState()
  const chatEpochs = new Map(Object.entries(state.chatEpochs))
  const chatSessionList = new Map(Object.entries(state.chatSessionList))
  const chatWorkspaces = new Map(Object.entries(state.chatWorkspaces))

  /** Stable base epoch (web-mode semantics: session ids survive restarts). */
  const EPOCH = '0'
  const STARTED_AT = Date.now()

  function log(...args: unknown[]): void {
    console.error(`[${name} ${new Date().toISOString().slice(11, 19)}]`, ...args)
  }

  /** Refresh the in-memory maps into `state` and write the file (bridge.mjs saveState). */
  function persist(): void {
    state.chatEpochs = Object.fromEntries(chatEpochs)
    state.chatSessionList = Object.fromEntries(chatSessionList)
    state.chatWorkspaces = Object.fromEntries(chatWorkspaces)
    saveState(state)
  }

  /** Register an epoch in the chat's history list (bridge.mjs rememberSession). */
  function appendEpoch(chatId: string, epoch: string): void {
    const list = chatSessionList.get(chatId) ?? []
    if (!list.includes(epoch)) {
      list.push(epoch)
      chatSessionList.set(chatId, list)
      persist()
    }
  }

  /** Current epoch for a chat, minting '0' on first contact (bridge.mjs sessionIdFor/rememberSession). */
  function epochFor(chatId: string): string {
    const existing = chatEpochs.get(chatId)
    if (existing !== undefined) return existing
    chatEpochs.set(chatId, EPOCH)
    appendEpoch(chatId, EPOCH)
    return EPOCH
  }

  /** DSH session id for a Feishu chat, stable per chat+epoch. */
  function sessionIdForChat(chatId: string): string {
    return sessionIdFor(chatId, epochFor(chatId))
  }

  // ------------------------------------------------------------ session/event feed
  const sessionListeners = new Map<string, Set<(ev: BridgeSessionEvent) => void>>()
  const usageBySession = new Map<string, { billed: number; output: number }>()

  /** Register a per-session event listener; returns its disposer (bridge.mjs onSessionEvent). */
  function onSessionEvent(sessionId: string, fn: (ev: BridgeSessionEvent) => void): () => void {
    const set = sessionListeners.get(sessionId) ?? new Set()
    set.add(fn)
    sessionListeners.set(sessionId, set)
    return () => {
      set.delete(fn)
      if (set.size === 0) sessionListeners.delete(sessionId)
    }
  }

  /** Accumulate per-session billed/output tokens from assistant/message usage. */
  function accumulateUsage(sessionId: string, usage: BridgeTokenUsage): void {
    const cur = usageBySession.get(sessionId) ?? { billed: 0, output: 0 }
    cur.billed += (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    cur.output += usage.outputTokens ?? 0
    usageBySession.set(sessionId, cur)
  }

  /** Global session/event dispatch: usage bookkeeping + per-session fan-out (replaces mux). */
  function onGlobalSessionEvent(sessionId: string, event: BridgeSessionEvent): void {
    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      accumulateUsage(sessionId, event.data.usage)
    }
    const fns = sessionListeners.get(sessionId)
    if (fns === undefined) return
    for (const fn of fns) {
      try { fn(event) } catch (error) { log('session listener failed:', errorMessage(error)) }
    }
  }

  // ------------------------------------------------------------ agent driving (M7 in-process)
  const agents = ctx.get('agents') as BridgeAgentRegistry | undefined

  /**
   * Resolve the deployment's default model route. agents.create does NOT
   * auto-apply the default model: the headless pattern passes
   * `agentOptions: { provider, model }` explicitly, otherwise the persona's
   * `{{model}}` template variable assembles empty and the turn errors out.
   */
  function defaultModelSelection(): BridgeModelPreference | undefined {
    const dm = ctx.get('agentDefaultModel') as { currentSelection(): BridgeModelPreference } | undefined
    const sel = dm?.currentSelection()
    if (sel !== undefined && sel.provider !== '' && sel.model !== '') {
      return { provider: sel.provider, model: sel.model }
    }
    return undefined
  }

  /**
   * Ensure the chat's live agent exists; creates it lazily with the standard
   * preset (bridge.mjs ensureSession). Command wiring: /model's preference is
   * passed as agentOptions, and /resume's epoch lands on a persisted session
   * that is resumed (live → persistence → create fallback, like the web BFF).
   */
  async function ensureAgent(chatId: string, sessionId: string): Promise<BridgeAgent> {
    if (agents === undefined) throw new Error(`${name}: agents service is unavailable`)
    await ctx.get('loader')?.await()
    const live = agents.get(sessionId)
    if (live !== undefined) return live
    const agentOptions = chatModelPrefs.get(chatId) ?? defaultModelSelection()
    const persistence = ctx.get('sessionPersistence') as BridgeSessionPersistence | undefined
    if (persistence !== undefined) {
      const persisted = await persistence.list().then((list) => list.some((h) => h.id === sessionId)).catch(() => false)
      if (persisted) {
        const { agent } = await agents.resume({
          resumeSessionId: sessionId,
          ...(agentOptions === undefined ? {} : { agentOptions }),
        })
        // Let the loop reach quiescence before the first followup (headless pattern).
        await agent.whenIdle()
        return agent
      }
    }
    // /workspace binding: create the session in the bound workspace's directory
    // and attach it, so the workspace's sessionIds membership stays accurate
    // (web BFF session.create derives cwd from workspaceId the same way).
    const workspaceId = chatWorkspaces.get(chatId)
    const workspace = workspaceId !== undefined
      ? (ctx.get('workspaceRegistry') as BridgeWorkspaceRegistry | undefined)?.get(workspaceId)
      : undefined
    const cwd = workspace?.path ?? process.cwd()
    // Follow the deployment's default agent preset (settings agent-presets.default),
    // falling back to the standard preset when the roster is not mounted.
    const presetId = (ctx.get('agentPresets') as { defaultId: string } | undefined)?.defaultId ?? 'standard'
    const { agent } = await agents.create({
      sessionId,
      meta: { cwd, agentPreset: presetId },
      ...(agentOptions === undefined ? {} : { agentOptions }),
    })
    if (workspace !== undefined) {
      try { await workspace.attachSession(sessionId) } catch (error) {
        log(`workspace attach failed for ${sessionId}:`, errorMessage(error))
      }
    }
    // Let the loop reach quiescence before the first followup (headless pattern).
    await agent.whenIdle()
    return agent
  }

  // ------------------------------------------------------------ queue / watchdog (M9/M13/M16)
  const queues = new Map<string, Promise<unknown>>() // chatId -> message chain
  const chatPending = new Map<string, number>() // chatId -> queued+running turn count
  const commandQueues = new Map<string, Promise<unknown>>() // chatId -> command chain

  interface TurnEntry {
    startedAt: number
    interrupted: boolean
    cancel(): void
  }
  const chatTurns = new Map<string, TurnEntry>() // chatId -> running turn handle

  /** Marker error for a watchdog timeout. */
  class TurnTimeoutError extends Error {
    constructor() {
      super(`turn exceeded ${Math.round(config.maxTurnMs / 60_000)} min`)
      this.name = 'TurnTimeoutError'
    }
  }

  /** Slash commands run on their own per-chat chain (bridge.mjs enqueueCommand). */
  function enqueueCommand(chatId: string, task: () => Promise<void>): Promise<void> {
    const prev = commandQueues.get(chatId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(task)
    commandQueues.set(chatId, next.catch(() => {}))
    return next
  }

  /** Serialize one turn per chat; a timeout rejects with TurnTimeoutError (bridge.mjs enqueue). */
  function enqueue<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    chatPending.set(chatId, (chatPending.get(chatId) ?? 0) + 1)
    const prev = queues.get(chatId) ?? Promise.resolve()
    const next: Promise<T> = prev
      .catch(() => {})
      .then(() => runWithWatchdog(task))
      .finally(() => {
        const n = (chatPending.get(chatId) ?? 1) - 1
        if (n <= 0) chatPending.delete(chatId)
        else chatPending.set(chatId, n)
      })
    queues.set(chatId, next.catch(() => {}))
    return next
  }

  /** Race one turn against MAX_TURN_MS (bridge.mjs runWithWatchdog). */
  async function runWithWatchdog<T>(task: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        task(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new TurnTimeoutError()), config.maxTurnMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * One in-process turn: ensure the agent, subscribe to its session events,
   * followup/steer the message, settle at turn/end (bridge.mjs thinkWeb).
   * @param mode - 'queue' waits for the current turn; 'steer' injects into it.
   */
  async function thinkTurn(
    chatId: string,
    text: string,
    onChunk?: (delta: string) => void,
    mode: 'queue' | 'steer' = 'queue',
  ): Promise<{ text: string; interrupted: boolean; blocked: boolean }> {
    const sessionId = sessionIdForChat(chatId)
    const agent = await ensureAgent(chatId, sessionId)
    const collected: string[] = []
    let blocked = false
    const entry: TurnEntry = {
      startedAt: Date.now(),
      interrupted: false,
      cancel: () => {
        entry.interrupted = true
        try {
          agent.cancel({ kind: 'user' }, { keepInbox: true })
        } catch (error) {
          log('interrupt cancel failed:', errorMessage(error))
        }
      },
    }
    chatTurns.set(chatId, entry)
    try {
      const done = new Promise<void>((resolve) => {
        // Cancel shortly before the queue watchdog so the turn settles via a
        // normal turn/end instead of the watchdog firing mid-stream.
        let timer: NodeJS.Timeout | undefined = setTimeout(() => {
          entry.cancel()
        }, Math.max(10_000, config.maxTurnMs - 10_000))
        const unsub = onSessionEvent(sessionId, (ev) => {
          if (ev.type === 'assistant/chunk' && ev.data.chunk.type === 'text-delta') {
            const delta = ev.data.chunk.text
            if (delta !== undefined && delta !== '') {
              collected.push(delta)
              try { onChunk?.(delta) } catch { /* stream best-effort */ }
            }
          } else if (ev.type === 'turn/end') {
            if (timer !== undefined) clearTimeout(timer)
            unsub()
            if (ev.data.reason.kind === 'blocked') blocked = true
            resolve()
          }
        })
      })
      if (mode === 'steer') {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: PLUGIN_SOURCE },
        }))
      } else {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: PLUGIN_SOURCE },
        }))
      }
      await done
      return { text: collected.join(''), interrupted: entry.interrupted, blocked }
    } finally {
      if (chatTurns.get(chatId) === entry) chatTurns.delete(chatId)
    }
  }

  /** Interrupt a slow running turn so the new message gets processed promptly (M13). */
  async function interruptIfSlow(chatId: string): Promise<void> {
    const running = chatTurns.get(chatId)
    if (running === undefined) return
    if (Date.now() - running.startedAt < config.interruptAfterMs) return
    log(`interrupting slow turn on ${chatId} (${Math.round((Date.now() - running.startedAt) / 1000)}s)`)
    running.cancel()
  }

  // ------------------------------------------------------------ usage / reply cards (M11)
  /**
   * Cumulative per-session usage: event-accumulated tokens first, falling back
   * to ctx.tokenMeter when it is present (task: 判空兜底).
   */
  function readCumulativeUsage(chatId: string): { billed: number; output: number } | null {
    const sessionId = sessionIdForChat(chatId)
    const acc = usageBySession.get(sessionId)
    if (acc !== undefined && (acc.billed > 0 || acc.output > 0)) return acc
    const meter = ctx.get('tokenMeter') as BridgeTokenMeter | undefined
    const agent = agents?.get(sessionId)
    if (meter !== undefined && agent !== undefined) {
      try {
        const m = meter.measure(agent.session)
        if (m.totalTokens > 0) return { billed: m.totalTokens, output: 0 }
      } catch { /* measure failed — no footer */ }
    }
    return null
  }

  /** Build the reply card JSON: markdown body + optional interrupt note + token footer. */
  function replyCard(
    body: string,
    interrupted: boolean,
    usage: { billed: number; output: number } | null,
  ): object {
    const elements: object[] = [{ tag: 'markdown', element_id: 'stream_md', content: body }]
    if (interrupted) {
      elements.push({
        tag: 'div',
        text: { tag: 'plain_text', content: '⏸️ 已打断（你发了新消息，已优先处理）', text_size: 'notation', text_color: 'grey' },
      })
    }
    if (usage !== null) {
      elements.push({ tag: 'hr' })
      elements.push({
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: `📊 本会话累计 · 输入 ${formatTokens(usage.billed)} · 输出 ${formatTokens(usage.output)}`,
          text_size: 'notation',
          text_color: 'grey',
        },
      })
    }
    return { schema: '2.0', config: { streaming_mode: false }, body: { elements } }
  }

  /** Patch the finished streaming card with interrupt note + token footer. */
  async function appendTokenFooter(chatId: string, messageId: string, body: string, interrupted: boolean): Promise<void> {
    try {
      const usage = readCumulativeUsage(chatId)
      if (!interrupted && usage === null) return
      await channel.updateCard(messageId, replyCard(body, interrupted, usage))
      log(usage !== null ? `footer patched: billed=${usage.billed} out=${usage.output}` : 'footer patched: interrupt note only')
    } catch (error) {
      log('footer patch failed (skipped):', errorMessage(error))
    }
  }

  // ------------------------------------------------------------ streaming answer (M12)
  /** Streaming reply card fed live from DSH chunk events. */
  async function streamAnswer(msg: NormalizedMessage, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<void> {
    try {
      let streamed = ''
      let interrupted = false
      let blocked = false
      const { messageId } = await channel.stream(msg.chatId, {
        markdown: async (controller) => {
          const onChunk = (delta: string) => { void controller.append(delta).catch(() => {}) }
          try {
            const result = await thinkTurn(msg.chatId, text, onChunk, mode)
            streamed = result.text
            interrupted = result.interrupted
            blocked = result.blocked
            recordTranscript(msg.chatId, 'assistant', streamed)
          } catch (error) {
            if (error instanceof TurnTimeoutError) throw error
            log('turn failed:', errorMessage(error))
            await controller.append(`\n\n⚠️ 处理失败：${errorMessage(error).slice(0, 200)}`)
            return
          }
          if (interrupted) {
            await controller.append('\n\n⏸️ 已打断（你发了新消息，已优先处理）')
          } else if (blocked) {
            await controller.append('\n\n⚠️ 该请求需要交互，请在 Web GUI 处理。')
          } else if (streamed.trim() === '') {
            await controller.setContent('⚠️ DSH 没有产生回复（可能出错了）。')
          }
        },
      }, { replyTo: msg.messageId })
      // Completed turn: patch interrupt note + token footer onto the card.
      if (streamed.trim() !== '') {
        await appendTokenFooter(msg.chatId, messageId, streamed, interrupted)
      }
    } catch (error) {
      if (error instanceof TurnTimeoutError) throw error
      log('stream failed:', errorMessage(error))
      try {
        await channel.send(msg.chatId, { text: `⚠️ 处理失败：${errorMessage(error).slice(0, 300)}` }, { replyTo: msg.messageId })
      } catch { /* already tried */ }
    }
  }

  // ------------------------------------------------------------ watchog timeout (M16 in-process)
  /** Watchdog timeout: cancel the turn and reply an error card — never exit the process. */
  async function handleTimeout(msg: NormalizedMessage): Promise<void> {
    log('watchdog: turn timed out, cancelling the turn')
    const running = chatTurns.get(msg.chatId)
    if (running !== undefined) running.cancel()
    try {
      await channel.send(msg.chatId, { text: '⚠️ 处理超时（单回合超过时限），已取消该回合，可以继续对话。' }, { replyTo: msg.messageId })
    } catch { /* already tried */ }
  }

  // ------------------------------------------------------------ message entry (M15)
  const chatStreamPrefs = new Map<string, boolean>()
  const chatQueuePrefs = new Map<string, boolean>()
  /** Per-chat model preference set by /model; applied on the next create/resume. */
  const chatModelPrefs = new Map<string, BridgeModelPreference>()
  /** Per-chat YOLO 免审批开关（/yolo 设置；内存态，重启自动关闭，不持久化）。 */
  const chatYoloPrefs = new Map<string, boolean>()

  /** Per-chat queue preference: true = queue, false/absent = steer (bridge.mjs messageMode). */
  function messageMode(chatId: string, forced: 'queue' | 'steer' | undefined): 'queue' | 'steer' {
    if (forced === 'queue' || forced === 'steer') return forced
    return chatQueuePrefs.get(chatId) === true ? 'queue' : 'steer'
  }

  async function cmdReply(msg: NormalizedMessage, text: string): Promise<void> {
    await channel.send(msg.chatId, { text }, { replyTo: msg.messageId })
  }

  /**
   * One plain message through the existing reply pipeline: queue/steer mode,
   * interrupt-if-slow, user transcript, then the streaming or one-shot card
   * branch. Shared by immediate (forced-mode / /ai / batching-disabled)
   * messages and by batched flushes.
   */
  async function processNormalText(
    msg: NormalizedMessage,
    text: string,
    forced: 'queue' | 'steer' | undefined,
  ): Promise<void> {
    const mode = messageMode(msg.chatId, forced)
    // Queue mode: never interrupt the running turn. Steer mode (default): cut in line.
    if (mode === 'steer') await interruptIfSlow(msg.chatId)

    recordTranscript(msg.chatId, 'user', text)

    const streaming = chatStreamPrefs.get(msg.chatId) ?? config.stream
    if (streaming) {
      try {
        await enqueue(msg.chatId, () => streamAnswer(msg, text, mode))
      } catch (error) {
        if (error instanceof TurnTimeoutError) await handleTimeout(msg)
      }
      return
    }

    // Non-streaming fallback: one-shot card (no typewriter), keeps interrupt note
    // and cumulative-token footer.
    try {
      const result = await enqueue(msg.chatId, () => thinkTurn(msg.chatId, text, undefined, mode))
      const answer = result.text
      recordTranscript(msg.chatId, 'assistant', answer)
      if (answer.trim() === '') {
        await channel.send(msg.chatId, { text: '⚠️ DSH 没有产生回复（可能出错了）。' }, { replyTo: msg.messageId })
      } else {
        const usage = readCumulativeUsage(msg.chatId)
        const body = result.blocked
          ? `${truncate(answer, config.maxReplyChars)}\n\n⚠️ 该请求需要交互，请在 Web GUI 处理。`
          : truncate(answer, config.maxReplyChars)
        await channel.send(msg.chatId, { card: replyCard(body, result.interrupted, usage) }, { replyTo: msg.messageId })
      }
    } catch (error) {
      if (error instanceof TurnTimeoutError) { await handleTimeout(msg); return }
      log('turn failed:', errorMessage(error))
      try {
        await channel.send(msg.chatId, { text: `⚠️ 处理失败：${errorMessage(error).slice(0, 300)}` }, { replyTo: msg.messageId })
      } catch { /* already tried */ }
    }
  }

  /**
   * Message burst batching: rapid plain messages in one chat merge into a
   * single turn (config.batchWindowMs; 0 = disabled). Commands and forced
   * modes never reach the batcher — see handle(). Lifecycle rides the bridge
   * runtime: dispose() clears every pending window and timer.
   */
  const batcher = config.batchWindowMs > 0
    ? createBatcher<NormalizedMessage>({
        windowMs: config.batchWindowMs,
        onFlush: (chatId, text, count, msg) => {
          log(`batched ${count} message(s) into one turn (chat=${chatId})`)
          void processNormalText(msg, text, undefined).catch((error) => {
            log('batched turn failed:', errorMessage(error))
          })
        },
        log,
      })
    : undefined

  async function handle(msg: NormalizedMessage): Promise<void> {
    const botOpenId = channel.botIdentity?.openId
    if (msg.senderId === botOpenId) return
    if (msg.chatType === 'group' && !msg.mentionedBot) return

    let text = stripMentions(msg)
    if (text === '') return
    log(`message ${msg.messageId} chat=${msg.chatId} type=${msg.chatType} from=${msg.senderId}: ${text.slice(0, 80)}`)

    // M18: a pending no-option question consumes the raw text as its answer.
    if (await questions.answerPendingFreeText(msg.chatId, text)) return

    // Per-message forced mode from /squeeze <内容> (queue) or /steer <内容> (steer).
    // Forced modes and /ai are explicit intent — never batched with neighbors.
    let forced: 'queue' | 'steer' | undefined
    let batched = true
    const squeezeArg = /^\/squeeze (?=\S)/.test(text) ? text.slice('/squeeze '.length) : null
    const steerArg = /^\/steer (?=\S)/.test(text) ? text.slice('/steer '.length) : null
    if (squeezeArg !== null && squeezeArg !== 'on' && squeezeArg !== 'off') {
      forced = 'queue'
      batched = false
      text = squeezeArg.trim()
      if (text === '') { await cmdReply(msg, '用法：/squeeze <内容>（强制排队）'); return }
    } else if (steerArg !== null) {
      forced = 'steer'
      batched = false
      text = steerArg.trim()
      if (text === '') { await cmdReply(msg, '用法：/steer <内容>（强制插队）'); return }
    } else if (text.startsWith('/ai ')) {
      batched = false
      const prompt = text.slice(4).trim()
      if (prompt === '') { await cmdReply(msg, '用法：/ai <内容>'); return }
      text = prompt
    } else if (text.startsWith('/')) {
      enqueueCommand(msg.chatId, () => runCommand(msg, text))
      return
    }

    // Batch window: only plain messages (no forced mode, no /ai) enter the
    // per-chat burst window; commands and forced modes bypass it. A pending
    // window is untouched by a command and still flushes on its own timer.
    if (!batched || batcher === undefined) {
      await processNormalText(msg, text, forced)
      return
    }
    batcher.push(msg.chatId, text, msg)
  }

  // ------------------------------------------------------------ transcript + commands (M17 subset)
  interface TranscriptEntry { role: 'user' | 'assistant'; text: string; epoch: string }
  const chatTranscript = new Map<string, TranscriptEntry[]>()

  /** Recent per-chat transcript (last 20 entries), tagged by session epoch. */
  function recordTranscript(chatId: string, role: 'user' | 'assistant', text: string): void {
    const t = (text ?? '').replace(/\s+/g, ' ').trim()
    if (t === '') return
    const list = chatTranscript.get(chatId) ?? []
    list.push({ role, text: t, epoch: chatEpochs.get(chatId) ?? EPOCH })
    if (list.length > 20) list.splice(0, list.length - 20)
    chatTranscript.set(chatId, list)
  }

  function queueDepth(chatId: string): number {
    return chatPending.get(chatId) ?? 0
  }

  /** Format a provider/model pair into a label (empty provider collapses). */
  function formatModel(provider: string | undefined, model: string): string {
    return provider !== undefined && provider !== '' ? `${provider} / ${model}` : model
  }

  /**
   * Current model label of the chat's session. Precedence mirrors the web
   * GUI's session.models: the live agent's last logged request config (the
   * authoritative route), then its creation-time options, then the cold
   * session's persisted request/header log (so /status works after a restart
   * or reload when no agent is live), then the deployment default — '—' only
   * when nothing is known.
   */
  async function modelLabel(chatId: string): Promise<string> {
    const sessionId = sessionIdForChat(chatId)
    const agent = agents?.get(sessionId)
    if (agent !== undefined) {
      const config = agent.session.requestHeader?.()?.config
      if (config !== undefined && config.model !== undefined && config.model !== '') {
        return formatModel(config.provider, config.model)
      }
      const options = agent.options
      if (options !== undefined && options.model !== undefined && options.model !== '') {
        return formatModel(options.provider, options.model)
      }
    }
    const persistence = ctx.get('sessionPersistence') as BridgeSessionPersistence | undefined
    if (persistence !== undefined) {
      try {
        const { events } = await persistence.inspect(sessionId)
        for (let i = events.length - 1; i >= 0; i--) {
          const ev = events[i]
          if (ev.type !== 'request/header') continue
          const header = (ev.data as { header?: { config?: { provider?: string; model?: string } } }).header
          if (header?.config?.model !== undefined && header.config.model !== '') {
            return formatModel(header.config.provider, header.config.model)
          }
        }
      } catch { /* persistence read failed — fall through */ }
    }
    const dm = ctx.get('agentDefaultModel') as { currentSelection(): BridgeModelPreference } | undefined
    const sel = dm?.currentSelection()
    if (sel !== undefined && sel.provider !== '' && sel.model !== '') return `${sel.provider} / ${sel.model}`
    return '—'
  }

  // ------------------------------------------------------------ commands (M17 in src/commands.ts)
  // The slash-command table lives in src/commands.ts; the runtime hands
  // registerCommands every piece of state the commands touch, and the returned
  // dispatcher is what handle() enqueues for '/'-prefixed messages.
  const runCommand = registerCommands({
    ctx,
    channel,
    appId,
    EPOCH,
    STARTED_AT,
    streamDefault: config.stream,
    chatEpochs,
    chatWorkspaces,
    chatTurns,
    chatStreamPrefs,
    chatYoloPrefs,
    chatModelPrefs,
    chatTranscript,
    log,
    cmdReply,
    sessionIdForChat,
    getAgent: (chatId) => agents?.get(sessionIdForChat(chatId)),
    epochFor,
    appendEpoch,
    persist,
    queueDepth,
    modelLabel,
    restartChannel,
  }).runCommand

  // ------------------------------------------------------------ questions (M18 in src/questions.ts)
  /** Reverse-map a DSH session id back to the Feishu chat that owns it (bridge.mjs chatIdForSession 1021). */
  function chatIdForSession(sessionId: string): string | undefined {
    for (const [chatId, epochs] of chatSessionList) {
      for (const epoch of epochs) {
        if (sessionIdFor(chatId, epoch) === sessionId) return chatId
      }
    }
    return undefined
  }

  const questions = registerQuestions({ ctx, channel, chatIdForSession, log })

  /** YOLO 免审批查询：该 chat 开启 /yolo 后审批帧自动放行（approval.ts 消费）。 */
  function isYolo(chatId: string): boolean {
    return chatYoloPrefs.get(chatId) === true
  }
  const approvals = registerApproval({ ctx, channel, chatIdForSession, isYolo, log })

  // ------------------------------------------------------------ lifecycle (M19/M20 in-process)
  let connectRetryTimer: NodeJS.Timeout | undefined
  let firstConnectDone = false

  function scheduleConnectRetry(): void {
    if (connectRetryTimer !== undefined) clearTimeout(connectRetryTimer)
    connectRetryTimer = setTimeout(() => { void connectChannel() }, 30_000)
  }

  /** Connect the channel; on initial handshake failure, retry with backoff. */
  async function connectChannel(): Promise<void> {
    try {
      await channel.connect()
      log(`channel connected: bot=${channel.botIdentity?.openId} (${channel.botIdentity?.name})`)
      if (!firstConnectDone) {
        firstConnectDone = true
        void notifyRestarted()
      }
    } catch (error) {
      log('channel connect failed (will retry):', errorMessage(error))
      scheduleConnectRetry()
    }
  }

  /** /restart semantics: reconnect the channel — the process stays alive. */
  async function restartChannel(): Promise<void> {
    try { await channel.disconnect() } catch { /* already gone */ }
    await connectChannel()
  }

  /** After (re)load, announce the bridge is back to every remembered chat. */
  async function notifyRestarted(): Promise<void> {
    const chatIds = [...new Set([...chatEpochs.keys(), ...chatSessionList.keys(), ...chatWorkspaces.keys()])]
    if (chatIds.length === 0) return
    const text = '✅ bridge 已重启完成，可以继续对话。\n会话记忆已保留；发送 /help 查看可用命令。'
    await Promise.allSettled(chatIds.map(async (chatId) => {
      try { await channel.send(chatId, { text }) } catch (error) { log(`restart notice to ${chatId} failed:`, errorMessage(error)) }
    }))
    log(`restart notice sent to ${chatIds.length} chat(s)`)
  }

  /** Effect disposer: stop the retry loop and close the channel. */
  function dispose(): void {
    if (connectRetryTimer !== undefined) {
      clearTimeout(connectRetryTimer)
      connectRetryTimer = undefined
    }
    sessionListeners.clear()
    try { questions.dispose() } catch { /* already gone */ }
    try { approvals.dispose() } catch { /* already gone */ }
    batcher?.dispose()
    void channel.disconnect().catch(() => { /* already gone */ })
  }

  return { log, onGlobalSessionEvent, handle, connectChannel, dispose }
}
