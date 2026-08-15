/**
 * @dsh-external/dsh-feishu-bridge — 飞书机器人 ↔ DSH 对话桥（DSH 进程内 Cordis 插件）。
 *
 * DSH 访问走进程内 ctx 服务直调（ctx.get('agents') + ctx.on('session/event') +
 * agent.followup/steer/cancel）。业务逻辑：飞书 Channel 收发与流式卡片、每 chat
 * 串行队列与插队、看门狗（超时 cancel + 错误卡片，**不退出进程**）、@提及剥离/
 * 截断/token 格式化、handle 入口、斜杠命令子集。
 *
 * 明确不做：RUNTIME=local 模式、任何 UI/client 代码与模型工具注册。
 * 提问/问答卡片系统见 src/questions.ts（进程内 api.respond，不注册 userQuestions
 * provider）；/workspace /model /resume 命令见 src/commands.ts。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { Context } from 'cordis'
import z from 'schemastery'
import { createBatcher } from './batching.js'
import { registerApproval } from './approval.js'
import { registerCommands, renderStatus, type CommandRuntime } from './commands.js'
import { registerQuestions } from './questions.js'
import { buildChannel } from './lark.js'
import { loadState, saveState, sessionIdFor, type BridgeState } from './state.js'
import { formatTokens, stripMentions, truncate } from './text.js'
import type {
  BridgeAgent,
  BridgeAgentRegistry,
  BridgeLogEvent,
  BridgeModelPreference,
  BridgeSessionEvent,
  BridgeSessionPersistence,
  BridgeTokenMeter,
  BridgeTokenUsage,
  BridgeWorkspaceRegistry,
} from './types.js'

// Injected user messages keep source.kind='user' (the old bridge's
// session.prompt RPC did the same): the title / lastPromptAt systems only
// treat kind='user' as human input, so kind='plugin' left every Feishu
// session untitled (web shows the cwd basename) and never-prompted.

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
  /** 插队阈值：运行中回合超过该毫秒数，新消息打断它优先处理（0 = 立即打断）。 */
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
  interruptAfterMs: z.number().default(0),
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
  // Credentials: Config wins, environment as fallback.
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
  // ------------------------------------------------------------ persistent state
  const state: BridgeState = loadState()
  const chatEpochs = new Map(Object.entries(state.chatEpochs))
  const chatSessionList = new Map(Object.entries(state.chatSessionList))
  const chatWorkspaces = new Map(Object.entries(state.chatWorkspaces))
  /** Per-chat current-session override: a web session (session-<uuid>) resumed into the chat. */
  const chatSessionOverride = new Map(Object.entries(state.chatSessionOverride))

  /** Stable base epoch (web-mode semantics: session ids survive restarts). */
  const EPOCH = '0'
  const STARTED_AT = Date.now()

  function log(...args: unknown[]): void {
    console.error(`[${name} ${new Date().toISOString().slice(11, 19)}]`, ...args)
  }

  /** Refresh the in-memory maps into `state` and write the file. */
  function persist(): void {
    state.chatEpochs = Object.fromEntries(chatEpochs)
    state.chatSessionList = Object.fromEntries(chatSessionList)
    state.chatWorkspaces = Object.fromEntries(chatWorkspaces)
    state.chatSessionOverride = Object.fromEntries(chatSessionOverride)
    saveState(state)
  }

  /** Register an epoch in the chat's history list. */
  function appendEpoch(chatId: string, epoch: string): void {
    const list = chatSessionList.get(chatId) ?? []
    if (!list.includes(epoch)) {
      list.push(epoch)
      chatSessionList.set(chatId, list)
      persist()
    }
  }

  /** Current epoch for a chat, minting '0' on first contact. */
  function epochFor(chatId: string): string {
    const existing = chatEpochs.get(chatId)
    if (existing !== undefined) return existing
    chatEpochs.set(chatId, EPOCH)
    appendEpoch(chatId, EPOCH)
    return EPOCH
  }

  /** DSH session id for a Feishu chat: the resumed web session override, else `feishu-<epoch>-<slug>`. */
  function sessionIdForChat(chatId: string): string {
    const over = chatSessionOverride.get(chatId)
    if (over !== undefined) return over
    return sessionIdFor(chatId, epochFor(chatId))
  }

  // ------------------------------------------------------------ session/event feed
  const sessionListeners = new Map<string, Set<(ev: BridgeSessionEvent) => void>>()
  const usageBySession = new Map<string, { billed: number; output: number }>()

  /** Register a per-session event listener; returns its disposer. */
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

  /** Global session/event dispatch: usage bookkeeping + per-session fan-out. */
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

  // ------------------------------------------------------------ agent driving
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
   * preset. Command wiring: /model's preference is passed as agentOptions, and
   * /resume's epoch lands on a persisted session that is resumed (live →
   * persistence → create fallback).
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
    // and attach it, so the workspace's sessionIds membership stays accurate.
    const workspaceId = chatWorkspaces.get(chatId)
    const workspace = workspaceId !== undefined
      ? (ctx.get('workspaceRegistry') as BridgeWorkspaceRegistry | undefined)?.get(workspaceId)
      : undefined
    const cwd = workspace?.path ?? process.cwd()
    // Follow the deployment's default agent preset, falling back to the
    // standard preset when the roster is not mounted.
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

  // ------------------------------------------------------------ queue / watchdog
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

  /** Slash commands run on their own per-chat chain. */
  function enqueueCommand(chatId: string, task: () => Promise<void>): Promise<void> {
    const prev = commandQueues.get(chatId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(task)
    commandQueues.set(chatId, next.catch(() => {}))
    return next
  }

  /** Serialize one turn per chat; a timeout rejects with TurnTimeoutError. */
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

  /** Race one turn against maxTurnMs. */
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
   * followup/steer the message, settle at turn/end.
   * @param mode - 'queue' waits for the current turn; 'steer' injects into it.
   * @param onStatus - optional live progress callback (tool calls) so multi-step
   * turns show activity on the streaming card instead of a static "思考中".
   */
  async function thinkTurn(
    chatId: string,
    text: string,
    onChunk?: (delta: string) => void,
    mode: 'queue' | 'steer' = 'queue',
    onStatus?: (toolName: string) => void,
  ): Promise<{ text: string; interrupted: boolean; blocked: boolean }> {
    const sessionId = sessionIdForChat(chatId)
    const agent = await ensureAgent(chatId, sessionId)
    // A session shared with the web GUI: when another driver is running its
    // turn right now and the bridge did not start it, tell the user the
    // message is queued instead of waiting silently (then timing out).
    if (agent.status === 'running' && chatTurns.get(chatId) === undefined) {
      try {
        await channel.send(chatId, {
          text: '⚠️ 该会话正在 web 端使用中，你的消息已排队，处理完当前回合后会自动回复。',
        })
      } catch { /* best-effort notice */ }
    }
    const collected: Array<{ turn: number; delta: string }> = []
    let endedTurn = 0
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
        // normal turn/end instead of the watchdog firing mid-stream, then
        // hard-settle even if the agent never emits turn/end (e.g. another
        // driver holds the loop on a shared session): cleanup runs and the
        // per-chat queue can never wedge on a silent turn.
        let timer: NodeJS.Timeout | undefined = setTimeout(() => {
          entry.cancel()
          resolve()
        }, Math.max(10_000, config.maxTurnMs - 10_000))
        const unsub = onSessionEvent(sessionId, (ev) => {
          if (ev.type === 'assistant/chunk' && ev.data.chunk.type === 'text-delta') {
            const delta = ev.data.chunk.text
            if (delta !== undefined && delta !== '') {
              collected.push({ turn: ev.data.turn, delta })
              try { onChunk?.(delta) } catch { /* stream best-effort */ }
            }
          } else if (ev.type === 'tool/call' && !entry.interrupted) {
            try { onStatus?.(ev.data.name) } catch { /* status best-effort */ }
          } else if (ev.type === 'turn/end') {
            if (timer !== undefined) clearTimeout(timer)
            unsub()
            endedTurn = ev.data.turn
            if (ev.data.reason.kind === 'blocked') blocked = true
            resolve()
          }
        })
      })
      if (mode === 'steer') {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
      } else {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))
      }
      await done
      // An aborted turn's in-flight stream can keep delivering after it ended
      // (the output was already generated); those late chunks belong to the
      // old turn and must not bleed into this turn's answer — filter by the
      // turn number that actually ended. Fall back to unfiltered when the
      // end event carried no turn.
      const resultText = endedTurn > 0
        ? collected.filter((c) => c.turn === endedTurn).map((c) => c.delta).join('')
        : collected.map((c) => c.delta).join('')
      return { text: resultText, interrupted: entry.interrupted, blocked }
    } finally {
      if (chatTurns.get(chatId) === entry) chatTurns.delete(chatId)
    }
  }

  /** Interrupt a running turn so the new message gets processed promptly; threshold 0 = always. */
  async function interruptIfSlow(chatId: string): Promise<void> {
    const running = chatTurns.get(chatId)
    if (running === undefined) return
    if (config.interruptAfterMs > 0 && Date.now() - running.startedAt < config.interruptAfterMs) return
    log(`interrupting slow turn on ${chatId} (${Math.round((Date.now() - running.startedAt) / 1000)}s)`)
    running.cancel()
  }

  // ------------------------------------------------------------ usage / reply cards
  /**
   * Cumulative per-session usage: event-accumulated tokens first, falling back
   * to ctx.tokenMeter when it is present.
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

  // ------------------------------------------------------------ streaming answer
  /** Streaming reply card fed live from DSH chunk events. */
  async function streamAnswer(msg: NormalizedMessage, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<void> {
    try {
      let streamed = ''
      let interrupted = false
      let blocked = false
      const { messageId } = await channel.stream(msg.chatId, {
        markdown: async (controller) => {
          const onChunk = (delta: string) => { void controller.append(delta).catch(() => {}) }
          const onStatus = (toolName: string) => {
            void controller.append(`\n\n> 🔧 正在调用工具：${toolName}…`).catch(() => {})
          }
          try {
            const result = await thinkTurn(msg.chatId, text, onChunk, mode, onStatus)
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

  // ------------------------------------------------------------ watchdog timeout
  /** Watchdog timeout: cancel the turn and reply an error card — never exit the process. */
  async function handleTimeout(msg: NormalizedMessage): Promise<void> {
    log('watchdog: turn timed out, cancelling the turn')
    const running = chatTurns.get(msg.chatId)
    if (running !== undefined) running.cancel()
    try {
      await channel.send(msg.chatId, { text: '⚠️ 处理超时（单回合超过时限），已取消该回合，可以继续对话。' }, { replyTo: msg.messageId })
    } catch { /* already tried */ }
  }

  // ------------------------------------------------------------ message entry
  const chatStreamPrefs = new Map<string, boolean>()
  const chatQueuePrefs = new Map<string, boolean>()
  /** Per-chat model preference set by /model; applied on the next create/resume. */
  const chatModelPrefs = new Map<string, BridgeModelPreference>()
  /** Per-chat YOLO 免审批开关（/yolo 设置；内存态，重启自动关闭，不持久化）。 */
  const chatYoloPrefs = new Map<string, boolean>()

  /** Per-chat queue preference: true = queue, false/absent = steer. */
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

    // A pending no-option question consumes the raw text as its answer.
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

  // ------------------------------------------------------------ transcript + commands
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

  /**
   * The agent preset the chat's session runs on. Durable, same resolution as
   * the agent-presets service's resolveSessionPreset: the latest logged
   * `agent-preset/selected` event wins, else the creation header's
   * `agentPreset` (written from create meta by dsh-session). Live session
   * first, persisted-log fallback so /status works after a restart when no
   * agent is live; undefined when the deployment composes no preset.
   */
  async function agentPreset(chatId: string): Promise<string | undefined> {
    const resolve = (header: { agentPreset?: string } | undefined, events: readonly BridgeLogEvent[]): string | undefined => {
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]
        if (ev.type !== 'agent-preset/selected') continue
        const p = (ev.data as { agentPreset?: string }).agentPreset
        if (p !== undefined && p !== '') return p
      }
      const h = header?.agentPreset
      return h !== undefined && h !== '' ? h : undefined
    }
    const sessionId = sessionIdForChat(chatId)
    const agent = agents?.get(sessionId)
    if (agent !== undefined) {
      const found = resolve(agent.session.header as { agentPreset?: string } | undefined, agent.session.events ?? [])
      if (found !== undefined) return found
    }
    const persistence = ctx.get('sessionPersistence') as BridgeSessionPersistence | undefined
    if (persistence !== undefined) {
      try {
        const { meta, events } = await persistence.inspect(sessionId)
        return resolve(meta as { agentPreset?: string } | undefined, events ?? [])
      } catch { /* persistence read failed — fall through */ }
    }
    return undefined
  }

  /**
   * The reasoning effort the chat's session actually ran with. Same source
   * modelLabel reads: the live request header first, then the persisted
   * `request/header` log (config.reasoningEffort — an adapter-defined opaque
   * level string). undefined when the model exposes no effort.
   */
  async function reasoningEffort(chatId: string): Promise<string | undefined> {
    const sessionId = sessionIdForChat(chatId)
    const agent = agents?.get(sessionId)
    if (agent !== undefined) {
      const config = agent.session.requestHeader?.()?.config as
        | { provider?: string; model?: string; reasoningEffort?: string }
        | undefined
      const effort = config?.reasoningEffort
      if (effort !== undefined && effort !== '') return effort
    }
    const persistence = ctx.get('sessionPersistence') as BridgeSessionPersistence | undefined
    if (persistence !== undefined) {
      try {
        const { events } = await persistence.inspect(sessionId)
        for (let i = events.length - 1; i >= 0; i--) {
          const ev = events[i]
          if (ev.type !== 'request/header') continue
          const header = (ev.data as { header?: { config?: { provider?: string; model?: string; reasoningEffort?: string } } }).header
          const effort = header?.config?.reasoningEffort
          if (effort !== undefined && effort !== '') return effort
        }
      } catch { /* persistence read failed — fall through */ }
    }
    return undefined
  }

  // ------------------------------------------------------------ commands (see src/commands.ts)
  // The slash-command table lives in src/commands.ts; the runtime hands
  // registerCommands every piece of state the commands touch, and the returned
  // dispatcher is what handle() enqueues for '/'-prefixed messages. The same
  // runtime object is reused by the restart announcement to render per-chat
  // /status snapshots (renderStatus) with identical value sources.
  const commandRuntime: CommandRuntime = {
    ctx,
    channel,
    appId,
    EPOCH,
    STARTED_AT,
    streamDefault: config.stream,
    chatEpochs,
    chatWorkspaces,
    chatSessionOverride,
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
    readCumulativeUsage,
    agentPreset,
    reasoningEffort,
    restartChannel,
  }
  const runCommand = registerCommands(commandRuntime).runCommand

  // ------------------------------------------------------------ questions (see src/questions.ts)
  /** Reverse-map a DSH session id back to the Feishu chat that owns it. */
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

  // ------------------------------------------------------------ lifecycle
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
    const restartText = '✅ bridge 已重启完成，可以继续对话。\n会话记忆已保留；发送 /help 查看可用命令。'
    await Promise.allSettled(chatIds.map(async (chatId) => {
      try {
        // Per-chat /status snapshot: each chat has its own workspace/session,
        // so render one per chat inside the loop (never share across chats).
        // A failed render (e.g. the session is gone) falls back to sending
        // the plain restart notice only.
        let text = restartText
        const snapshot = await renderStatus(commandRuntime, chatId).catch(() => '')
        if (snapshot.trim() !== '') text = `${restartText}\n\n${snapshot}`
        await channel.send(chatId, { text })
      } catch (error) { log(`restart notice to ${chatId} failed:`, errorMessage(error)) }
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
