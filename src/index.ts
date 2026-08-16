/**
 * @dsh-external/dsh-feishu-bridge — 飞书机器人 ↔ DSH 对话桥（DSH 进程内 Cordis 插件）。
 *
 * DSH 访问走进程内 ctx 服务直调（ctx.get('agents') + ctx.on('session/event') +
 * agent.followup/steer/cancel）。业务逻辑：飞书 Channel 收发与流式卡片、每 chat
 * 串行队列与插队、看门狗（超时 cancel + 错误卡片，**不退出进程**）、@提及剥离/
 * 截断/token 格式化、handle 入口、斜杠命令子集。
 *
 * 明确不做：RUNTIME=local 模式、任何 UI/client 代码。模型工具注册仅限
 * feishu_setup 一个（一键扫码配置，见 src/setup.ts）；注册失败只告警不阻塞。
 * 提问/问答卡片系统见 src/questions.ts（进程内 api.respond，不注册 userQuestions
 * provider）；/workspace /model /resume 命令见 src/commands.ts。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { Context } from 'cordis'
import z from 'schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createOutbox } from './outbox.js'
import { createWal, type WalRecord } from './wal.js'
import { createBatcher } from './batching.js'
import { registerApproval } from './approval.js'
import { registerCommands, renderStatus, type CommandRuntime } from './commands.js'
import { installEffortPref } from './effort.js'
import { registerQuestions } from './questions.js'
import { buildChannel } from './lark.js'
import { beginSetupFlow, loadCredentials, saveCredentials, setupErrorMessage, type SetupFlow } from './setup.js'
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
  /** 入站单条消息长度上限（字符）：超出截断并提示（0 = 不限制）。 */
  maxMessageChars: number
  /** 入站限流：每 chat 每分钟消息数上限（agent 注入前防护；0 = 不限制）。 */
  rateLimitPerMinute: number
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
  maxMessageChars: z.number().min(0).default(20_000),
  rateLimitPerMinute: z.number().min(0).default(30),
})

/** One-line error text from any thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Bridge-wide log line for apply-scope code (createRuntime keeps its own copy). */
function log(...args: unknown[]): void {
  console.error(`[${name} ${new Date().toISOString().slice(11, 19)}]`, ...args)
}

/** Cross-generation bridge hooks handed into each runtime generation (see apply). */
interface BridgeHooks {
  /** Claim a fresh QR setup flow; null when one is already running. */
  startSetup(): SetupFlow | null
  /** Swap the bridge onto fresh credentials: tear down + rebuild + reconnect. */
  rebuildChannel(appId: string, appSecret: string): Promise<void>
}

export function apply(ctx: Context, config: Config): void {
  // Credentials: Config wins, environment second, persisted credentials.json last.
  const saved = loadCredentials()
  const appId = config.feishuAppId !== '' ? config.feishuAppId : (process.env.FEISHU_APP_ID ?? saved?.appId ?? '')
  const appSecret = config.feishuAppSecret !== '' ? config.feishuAppSecret : (process.env.FEISHU_APP_SECRET ?? saved?.appSecret ?? '')
  if (appId === '' || appSecret === '') {
    throw new Error(`${name}: FEISHU_APP_ID / FEISHU_APP_SECRET are required (Config or environment)`)
  }

  // One effect owns the whole bridge lifetime: the current bridge generation
  // (channel + runtime + channel listeners), the global session/event feed,
  // the (re)connect loop, the credential-swap path (startSetup /
  // rebuildChannel, shared by /setup and the feishu_setup tool), and the
  // teardown disposer.
  ctx.effect(() => {
    const offs: Array<() => void> = []
    let disposed = false

    interface BridgeInstance {
      channel: LarkChannel
      runtime: BridgeRuntime
      dispose(): void
    }
    let bridge: BridgeInstance | null = null

    // The session/event feed is generation-independent: it always dispatches
    // into the CURRENT runtime, so a credential swap rebuilds cleanly.
    offs.push(ctx.on('session/event', (session, event) => {
      if (!session.id.startsWith('feishu-')) return
      bridge?.runtime.onGlobalSessionEvent(session.id, event as BridgeSessionEvent)
    }))

    /** Build + wire + connect a new bridge generation from fresh credentials. */
    function startBridge(nextAppId: string, nextAppSecret: string): void {
      if (disposed) return
      bridge?.dispose()
      const channel = buildChannel({
        appId: nextAppId,
        appSecret: nextAppSecret,
        streamThrottleMs: config.streamThrottleMs,
        streamThrottleChars: config.streamThrottleChars,
      })
      const runtime = createRuntime(ctx, channel, config, nextAppId, { startSetup, rebuildChannel })
      const channelOffs: Array<() => void> = []
      channelOffs.push(channel.on('error', (err) => runtime.log('channel error:', err.code, err.message)))
      channelOffs.push(channel.on('reconnecting', () => runtime.log('channel reconnecting…')))
      channelOffs.push(channel.on('reconnected', () => runtime.log('channel reconnected')))
      channelOffs.push(channel.on('message', (msg) => {
        void runtime.handle(msg).catch((error) => runtime.log('message handling failed:', errorMessage(error)))
      }))
      bridge = {
        channel,
        runtime,
        dispose: () => {
          for (const off of channelOffs) {
            try { off() } catch { /* already gone */ }
          }
          runtime.dispose()
        },
      }
      void runtime.connectChannel()
    }

    /** Credential swap: dispose the old generation, rebuild + reconnect. */
    async function rebuildChannel(nextAppId: string, nextAppSecret: string): Promise<void> {
      log('feishu bridge rebuilding with new credentials:', nextAppId)
      startBridge(nextAppId, nextAppSecret)
    }

    // ------------------------------------------------------------ setup flow
    let activeSetup: SetupFlow | null = null

    /** Claim a fresh setup flow; null while one is already running (per process). */
    function startSetup(): SetupFlow | null {
      if (activeSetup !== null) return null
      const flow = beginSetupFlow({
        onStatusChange: (info) => log('feishu setup status:', JSON.stringify(info)),
      })
      activeSetup = flow
      const release = (): void => { if (activeSetup === flow) activeSetup = null }
      void flow.result.then(release, release)
      return flow
    }

    /** Background finalize after the user scans: save credentials + rebuild. */
    function runBackgroundSetup(flow: SetupFlow): void {
      void flow.result.then(async (result) => {
        try {
          saveCredentials(result)
          await rebuildChannel(result.appId, result.appSecret)
        } catch (error) {
          log('feishu setup finalize failed:', errorMessage(error))
        }
      }, (error) => {
        log('feishu setup failed:', setupErrorMessage(error))
      })
    }

    // ------------------------------------------------------------ DSH tool entry
    // feishu_setup：生成授权链接（返回 URL 文本），后台等待授权完成后自动写
    // 凭据并重建飞书连接。tools 服务未装配（可选 peer）时只告警，不阻塞桥本身。
    const toolRuntime = ctx.get('tools') as { register(tool: ToolDefinition): () => void } | undefined
    if (toolRuntime?.register !== undefined) {
      try {
        offs.push(toolRuntime.register(defineTool({
          name: 'feishu_setup',
          description: '生成飞书授权链接，扫码后自动配置飞书桥凭据',
          parameters: {},
          output: {
            schema: { type: 'string' },
            render: (_args, value: string) => [{ type: 'text', text: value }],
          },
          timeoutMs: 120_000,
          async execute() {
            const flow = startSetup()
            if (flow === null) return '⚠️ 已有配置流程在进行中，请等待其完成。'
            try {
              const info = await flow.qrReady
              runBackgroundSetup(flow)
              return `🔗 请打开链接并用飞书扫码授权（${info.expireIn} 秒内有效）：\n${info.url}\n\n授权完成后将自动写入凭据并重连飞书，无需其他操作。`
            } catch (error) {
              return `❌ ${setupErrorMessage(error)}`
            }
          },
        })))
      } catch (error) {
        log('feishu_setup tool registration failed:', errorMessage(error))
      }
    }

    startBridge(appId, appSecret)

    return () => {
      disposed = true
      try { activeSetup?.abort() } catch { /* already gone */ }
      for (const off of offs) {
        try { off() } catch { /* already gone */ }
      }
      bridge?.dispose()
    }
  }, `${name}: channel + session events + setup tool`)
}

/** Public surface of the bridge runtime, consumed by the apply effect. */
interface BridgeRuntime {
  log(...args: unknown[]): void
  onGlobalSessionEvent(sessionId: string, event: BridgeSessionEvent): void
  /** opts.replayed = 入站补发重放：跳过入站过滤/命令解析/限流/WAL accept。 */
  handle(msg: NormalizedMessage, opts?: { replayed?: boolean }): Promise<void>
  connectChannel(): Promise<void>
  dispose(): void
}

function createRuntime(ctx: Context, channel: LarkChannel, config: Config, appId: string, hooks: BridgeHooks): BridgeRuntime {
  // ------------------------------------------------------------ persistent state
  const state: BridgeState = loadState()
  const chatEpochs = new Map(Object.entries(state.chatEpochs))
  const chatSessionList = new Map(Object.entries(state.chatSessionList))
  const chatWorkspaces = new Map(Object.entries(state.chatWorkspaces))
  /** Per-chat current-session override: a web session (session-<uuid>) resumed into the chat. */
  const chatSessionOverride = new Map(Object.entries(state.chatSessionOverride))
  /** Per-chat thinking-effort preference set by /effort; applied on the next turn (persisted). */
  const chatEffortPrefs = new Map(Object.entries(state.chatEffortPrefs))

  /** Stable base epoch (web-mode semantics: session ids survive restarts). */
  const EPOCH = '0'
  const STARTED_AT = Date.now()

  // ------------------------------------------------------------ P0 reliability: outbox + inbound WAL
  // 入站 WAL：注入 agent 之前落盘，回复确认送达后记账；崩溃/重载后可补发。
  const wal = createWal({ dir: join(homedir(), '.dsh', 'dsh-feishu-bridge', 'wal') })
  // 出站 Outbox：回复投递走持久化队列（at-least-once）。deliver 注入 channel.send，
  // 成功即触发该消息的 WAL delivered（"回复已送达"是补发语义的终点）。
  const outbox = createOutbox({
    dir: join(homedir(), '.dsh', 'dsh-feishu-bridge', 'outbox'),
    deliver: async (env) => {
      const p = env.payload
      if (p === undefined) return { ok: false, retryable: false, error: 'payload unresolved (blob missing)' }
      try {
        const input = p.kind === 'card' && p.card !== undefined ? { card: p.card } : { text: p.text ?? '' }
        await channel.send(p.chatId, input, p.replyTo !== undefined ? { replyTo: p.replyTo } : {})
        if (p.sourceMessageId !== undefined) markDelivered(p.sourceMessageId)
        return { ok: true }
      } catch (error) {
        return { ok: false, retryable: true, error: errorMessage(error) }
      }
    },
  })
  outbox.rebuildFromDisk() // sending → pending：崩溃/重载/凭据重建后恢复投递
  outbox.start()

  function log(...args: unknown[]): void {
    console.error(`[${name} ${new Date().toISOString().slice(11, 19)}]`, ...args)
  }

  /** Refresh the in-memory maps into `state` and write the file. */
  function persist(): void {
    state.chatEpochs = Object.fromEntries(chatEpochs)
    state.chatSessionList = Object.fromEntries(chatSessionList)
    state.chatWorkspaces = Object.fromEntries(chatWorkspaces)
    state.chatSessionOverride = Object.fromEntries(chatSessionOverride)
    state.chatEffortPrefs = Object.fromEntries(chatEffortPrefs)
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
          // Effort preference rides an agent-scoped agent/request waterfall
          // (AgentOptions has no reasoningEffort field — see src/effort.ts),
          // registered at creation/resume time exactly like the web GUI's
          // model-selection setup; takes effect on the next turn.
          setup: (agentCtx) => { installEffortPref(agentCtx, () => chatEffortPrefs.get(chatId)) },
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
      setup: (agentCtx) => { installEffortPref(agentCtx, () => chatEffortPrefs.get(chatId)) },
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
      // 流式回复确认送达 → WAL delivered：该用户消息不再需要补发。
      markDelivered(msg.messageId)
      // Completed turn: patch interrupt note + token footer onto the card.
      if (streamed.trim() !== '') {
        await appendTokenFooter(msg.chatId, messageId, streamed, interrupted)
      }
    } catch (error) {
      if (error instanceof TurnTimeoutError) throw error
      log('stream failed:', errorMessage(error))
      // P0：兜底错误通知走 Outbox（at-least-once），送达即 WAL delivered。
      const id = enqueueDurable({
        chatId: msg.chatId, kind: 'text', text: `⚠️ 处理失败：${errorMessage(error).slice(0, 300)}`,
        replyTo: msg.messageId, dedupeKey: `notice:${msg.messageId}`, sourceMessageId: msg.messageId,
      })
      if (id === undefined) markDelivered(msg.messageId)
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
   * P0 出站 Outbox：把回复投递进持久化队列（at-least-once —— 失败重试、重启
   * 恢复、幂等键防重复投递）。返回 envelope id；undefined = 幂等键已投递过
   * （此时回复必然已送达，调用方应直接记账 delivered）或队列满拒绝。
   */
  function enqueueDurable(input: {
    chatId: string
    kind: 'text' | 'card'
    text?: string
    card?: object
    replyTo?: string
    dedupeKey: string
    sourceMessageId?: string
  }): string | undefined {
    try {
      return outbox.enqueue({
        dedupeKey: input.dedupeKey,
        laneKey: input.chatId,
        kind: input.kind,
        payload: {
          chatId: input.chatId,
          kind: input.kind,
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.card !== undefined ? { card: input.card } : {}),
          ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
          ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
        },
      })
    } catch (error) {
      log('outbox enqueue failed:', errorMessage(error))
      return undefined
    }
  }

  /** WAL 记账：该用户消息的回复已确认送达，不再需要补发。 */
  function markDelivered(messageId: string): void {
    try {
      wal.delivered(messageId)
    } catch (error) {
      log('wal delivered failed:', errorMessage(error))
    }
  }

  // P0 入站限流：每 chat 每分钟消息数上限（滑动窗口，agent 注入前防护）。
  const chatMsgTimes = new Map<string, number[]>()
  /** 限流提示节流：同 chat 每 5s 至多一条丢弃提示，避免提示本身刷屏。 */
  const chatRateNoticeAt = new Map<string, number>()

  /** 滑动窗口（60s）计数；超限返回 false（config 为 0 = 不限制）。 */
  function rateLimitAllowed(chatId: string): boolean {
    if (config.rateLimitPerMinute <= 0) return true
    const cutoff = Date.now() - 60_000
    const times = (chatMsgTimes.get(chatId) ?? []).filter((t) => t >= cutoff)
    if (times.length >= config.rateLimitPerMinute) {
      chatMsgTimes.set(chatId, times)
      return false
    }
    times.push(Date.now())
    chatMsgTimes.set(chatId, times)
    return true
  }

  /** 丢弃提示（节流版）：超频时告知用户，不静默吞消息。 */
  function rateLimitNotice(msg: NormalizedMessage): void {
    const now = Date.now()
    const last = chatRateNoticeAt.get(msg.chatId) ?? 0
    if (now - last < 5_000) return
    chatRateNoticeAt.set(msg.chatId, now)
    void cmdReply(msg, `⚠️ 消息太频繁（每分钟最多 ${config.rateLimitPerMinute} 条），本条已丢弃，请稍后再试。`).catch(() => {})
  }

  /**
   * One plain message through the existing reply pipeline: queue/steer mode,
   * interrupt-if-slow, user transcript, then the streaming or one-shot card
   * branch. Shared by immediate (forced-mode / /ai / batching-disabled)
   * messages and by batched flushes.
   * @param opts.replayed - 入站补发重放：不再 accept（避免重置补发次数上限）。
   */
  async function processNormalText(
    msg: NormalizedMessage,
    text: string,
    forced: 'queue' | 'steer' | undefined,
    opts: { replayed?: boolean } = {},
  ): Promise<void> {
    // P0 入站 WAL：注入 agent 之前落盘（崩溃/重载后补发；批处理合并文本时
    // 只记一条 —— messageId 取 flush 携带的最后一条消息，text 为合并全文，
    // 补发重放的就是同一回合）。
    if (!opts.replayed) {
      try {
        wal.accept({ messageId: msg.messageId, chatKey: msg.chatId, text })
      } catch (error) {
        log('wal accept failed:', errorMessage(error))
      }
    }
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
    // and cumulative-token footer. P0：回复走 Outbox（at-least-once）；投递成功
    // 即 WAL delivered（deliver 注入钩子），enqueue 幂等短路时直接记账。
    try {
      const result = await enqueue(msg.chatId, () => thinkTurn(msg.chatId, text, undefined, mode))
      const answer = result.text
      recordTranscript(msg.chatId, 'assistant', answer)
      if (answer.trim() === '') {
        const id = enqueueDurable({
          chatId: msg.chatId, kind: 'text', text: '⚠️ DSH 没有产生回复（可能出错了）。',
          replyTo: msg.messageId, dedupeKey: `notice:${msg.messageId}`, sourceMessageId: msg.messageId,
        })
        if (id === undefined) markDelivered(msg.messageId)
      } else {
        const usage = readCumulativeUsage(msg.chatId)
        const body = result.blocked
          ? `${truncate(answer, config.maxReplyChars)}\n\n⚠️ 该请求需要交互，请在 Web GUI 处理。`
          : truncate(answer, config.maxReplyChars)
        const id = enqueueDurable({
          chatId: msg.chatId, kind: 'card', card: replyCard(body, result.interrupted, usage),
          replyTo: msg.messageId, dedupeKey: `reply:${msg.messageId}`, sourceMessageId: msg.messageId,
        })
        if (id === undefined) markDelivered(msg.messageId)
      }
    } catch (error) {
      if (error instanceof TurnTimeoutError) { await handleTimeout(msg); return }
      log('turn failed:', errorMessage(error))
      const id = enqueueDurable({
        chatId: msg.chatId, kind: 'text', text: `⚠️ 处理失败：${errorMessage(error).slice(0, 300)}`,
        replyTo: msg.messageId, dedupeKey: `notice:${msg.messageId}`, sourceMessageId: msg.messageId,
      })
      if (id === undefined) markDelivered(msg.messageId)
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

  /**
   * 入站消息入口。opts.replayed = 入站补发重放：该消息当初已通过过滤/限流，
   * 重放只重跑注入管线（跳过过滤、命令解析、限流，也不重复 WAL accept）。
   */
  async function handle(msg: NormalizedMessage, opts: { replayed?: boolean } = {}): Promise<void> {
    if (!opts.replayed) {
      const botOpenId = channel.botIdentity?.openId
      if (msg.senderId === botOpenId) return
      if (msg.chatType === 'group' && !msg.mentionedBot) return
    }

    let text = stripMentions(msg)
    if (text === '') return
    log(`message ${msg.messageId} chat=${msg.chatId} type=${msg.chatType} from=${msg.senderId}: ${text.slice(0, 80)}`)

    // P0 入站限流 1/2：单条消息长度上限（超出截断 + 提示；0 = 不限制）。
    if (config.maxMessageChars > 0 && text.length > config.maxMessageChars) {
      text = text.slice(0, config.maxMessageChars)
      void cmdReply(msg, `⚠️ 消息过长（超过 ${config.maxMessageChars} 字符），已截断为前 ${config.maxMessageChars} 字符处理。`).catch(() => {})
    }

    // 补发重放：原始文本已是注入内容（记录时即 post-解析），直接走注入管线；
    // 放在问答消费之前 —— 重放文本必为 agent 注入消息（问答答案从未 WAL 记账），
    // 避免被 pending 问答卡误吞。
    if (opts.replayed) {
      await processNormalText(msg, text, undefined, { replayed: true })
      return
    }

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

    // P0 入站限流 2/2：每 chat 每分钟消息数上限（agent 注入前防护）。命令已在
    // 上面 return，此处只拦 agent 注入路径（普通消息 / /ai / /squeeze / /steer）。
    if (!rateLimitAllowed(msg.chatId)) {
      rateLimitNotice(msg)
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
    chatEffortPrefs,
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
    startSetup: hooks.startSetup,
    rebuildChannel: hooks.rebuildChannel,
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

  /** 把 WAL 记录合成一条可重放的入站消息（replayed 旁路跳过全部入站过滤）。 */
  function replayMessage(rec: WalRecord): NormalizedMessage {
    return {
      messageId: rec.messageId,
      chatId: rec.chatKey,
      chatType: 'p2p',
      senderId: '',
      content: rec.text,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      createTime: rec.acceptedAt,
    }
  }

  /** YOLO 免审批查询：该 chat 开启 /yolo 后审批帧自动放行（approval.ts 消费）。 */
  function isYolo(chatId: string): boolean {
    return chatYoloPrefs.get(chatId) === true
  }
  const approvals = registerApproval({ ctx, channel, chatIdForSession, isYolo, log })

  // ---- P0 入站补发对账（启动流程末尾，fire-and-forget）--------------------------
  // accepted 而未 delivered 的记录 = 上次进程/插件在回合中途死掉，用户消息被吞。
  // 窗口内（30min）、次数未超（2 次）的重新派发 —— handle 的 replayed 旁路不再
  // 重跑过滤/命令解析/限流、也不重复 accept；回复走 Outbox 依旧 at-least-once。
  // 调用点：首次连接成功后（connectChannel 的 firstConnectDone 分支），与
  // lark-link 的「supervisor 连接建立后再对账」一致 —— 连接未就绪时流式卡片
  // 会直接失败，补发只会产出错误通知而非真正的回复。fire-and-forget，不阻塞。
  function runInboundReplay(): void {
    void (async () => {
      try {
        wal.prune()
        const pending = wal.pendingReplays()
        let replayed = 0
        for (const rec of pending) {
          if (!wal.markReplay(rec.messageId)) continue
          try {
            await handle(replayMessage(rec), { replayed: true })
            replayed++
          } catch (error) {
            log(`inbound replay failed for ${rec.messageId}:`, errorMessage(error))
          }
        }
        if (replayed > 0) log(`inbound replay re-dispatched ${replayed} request(s)`)
      } catch (error) {
        log('inbound replay errored:', errorMessage(error))
      }
    })()
  }

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
        // P0：连接就绪后再补发入站请求（见 runInboundReplay 注释）。
        runInboundReplay()
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
    // P0：停 outbox 泵（等 in-flight 投递收敛；未投递的 envelope 已在磁盘，
    // 下次启动/重建后由 rebuildFromDisk 恢复）。
    void outbox.stop().catch(() => { /* already stopped */ })
    void channel.disconnect().catch(() => { /* already gone */ })
  }

  return { log, onGlobalSessionEvent, handle, connectChannel, dispose }
}
