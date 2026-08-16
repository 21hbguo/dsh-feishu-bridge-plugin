/**
 * Slash-command table, extracted from src/index.ts into its own module.
 * registerCommands(runtime) receives every piece of bridge state the commands
 * touch and returns the dispatcher (runCommand) that handle() enqueues. The
 * runtime parameter is the only coupling, so this module never imports
 * src/index.ts (the dependency direction stays acyclic).
 *
 * Beyond the ported /help /ping /status /reset /new /stream /cancel /restart,
 * this module adds three in-process commands: /workspace
 * (workspaceRegistry.list/create + chatWorkspaces binding), /model (llm
 * catalog + per-chat preference applied on the next turn), and /resume
 * (sessions.list / agents.roots / sessionPersistence history with
 * latest-answer excerpts, switching via agents.resume).
 *
 * 命令三级分流（借鉴自 amlyczz/dsh-lark-link (MIT)
 * src/application/command-router.ts 的设计，化用为本机命令表结构）：
 *   Tier 1 桥命令：COMMANDS 表命中 → 现有处理（路径不变）；
 *   Tier 2 DSH 宿主注册命令：未知 /xxx 先查 host commands 服务
 *     （setCommandsHost 注入；find/execute 语义对齐 @deepseek-ai/dsh-commands
 *      CommandRuntime），命中则原生执行并把结果文本回给聊天；
 *   Tier 3 注入：未命中命令转发给 agent（setAgentFallback 注入；index.ts
 *     接线为 processNormalText 后生效），未接线时保持原「未知命令」回复，
 *     保证现有行为零回归。
 * 两个注入点均为本模块级扩展，不改变 CommandRuntime / CommandRunner 契约。
 */

import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { Context } from 'cordis'
import { saveCredentials, setupErrorMessage, type SetupFlow } from './setup.js'
import { firstSentence, formatTokens } from './text.js'
import { currentEffort, installEffortPref, supportedEfforts } from './effort.js'
import type {
  BridgeAgent,
  BridgeAgentRegistry,
  BridgeApprovalService,
  BridgeLlm,
  BridgeLogEvent,
  BridgeModelPreference,
  BridgePermissionPresetsService,
  BridgeSessionPersistence,
  BridgeSessionStore,
  BridgeTranscriptEntry,
  BridgeTurnEntry,
  BridgeWorkspace,
  BridgeWorkspaceRegistry,
} from './types.js'

/** One-line error text from any thrown value (index.ts keeps its own copy). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runtime surface registerCommands consumes (see createRuntime in index.ts). */
export interface CommandRuntime {
  ctx: Context
  channel: LarkChannel
  appId: string
  EPOCH: string
  STARTED_AT: number
  /** config.stream — the per-chat stream default when no /stream override exists. */
  streamDefault: boolean
  chatEpochs: Map<string, string>
  chatWorkspaces: Map<string, string>
  /** Per-chat current-session override: a web session (session-<uuid>) resumed into the chat. */
  chatSessionOverride: Map<string, string>
  chatTurns: Map<string, BridgeTurnEntry>
  chatStreamPrefs: Map<string, boolean>
  /** Per-chat YOLO 免审批开关（/yolo 设置；内存态，重启自动关闭，不持久化）。 */
  chatYoloPrefs: Map<string, boolean>
  chatModelPrefs: Map<string, BridgeModelPreference>
  /** Per-chat thinking-effort preference set by /effort; applied on the next turn (persisted). */
  chatEffortPrefs: Map<string, string>
  chatTranscript: Map<string, BridgeTranscriptEntry[]>
  log(...args: unknown[]): void
  cmdReply(msg: NormalizedMessage, text: string): Promise<void>
  sessionIdForChat(chatId: string): string
  /** Live agent of the chat's current session, if any (sync; no session creation). */
  getAgent(chatId: string): BridgeAgent | undefined
  epochFor(chatId: string): string
  appendEpoch(chatId: string, epoch: string): void
  persist(): void
  queueDepth(chatId: string): number
  /** Current model label (durable: live agent request config → options → persisted log → default). */
  modelLabel(chatId: string): Promise<string>
  /** Cumulative per-session token usage ({billed, output}), null when unknown. */
  readCumulativeUsage(chatId: string): { billed: number; output: number } | null
  /** The agent preset the chat's session runs on (creation header, then logged switches); undefined when the deployment composes none. */
  agentPreset(chatId: string): Promise<string | undefined>
  /** Reasoning effort the session actually ran with (live request header, then persisted request/header log); undefined when the model has none. */
  reasoningEffort(chatId: string): Promise<string | undefined>
  restartChannel(): Promise<void>
  /** Claim a fresh QR setup flow (null when one is already running per process). */
  startSetup(): SetupFlow | null
  /** Swap the bridge onto fresh credentials (saveCredentials is the caller's job) and reconnect. */
  rebuildChannel(appId: string, appSecret: string): Promise<void>
}

/** Dispatcher handle() uses for any text starting with '/'. */
export interface CommandRunner {
  runCommand(msg: NormalizedMessage, text: string): Promise<void>
}

// ------------------------------------------------------------ Tier 2/3 host wiring
/**
 * Structural mirror of the host commands service (packages/interaction/commands
 * CommandRuntime) — the plugin does not import @deepseek-ai/dsh-commands
 * (undeclared dependency; same mirroring policy as src/types.ts). The real
 * service is structurally compatible: find resolves one definition, execute
 * parses a complete slash-command line and runs the handler natively (never
 * sent to the model), resolving undefined when syntax/name does not resolve.
 */
export interface BridgeCommandsHost {
  /** Resolve a registered command by name (no leading slash); undefined = not registered. */
  find(agent: BridgeAgent, name: string): unknown
  /** Parse and execute a full slash-command line; undefined = syntax/name miss. */
  execute(
    agent: BridgeAgent,
    line: string,
    signal: AbortSignal,
  ): Promise<BridgeCommandExecution | undefined>
}

/** One settled host command execution (mirror of CommandExecution). */
export interface BridgeCommandExecution {
  commandId: string
  result: BridgeCommandResult
}

/** Handler outcome (mirror of CommandResult): success carries optional reply text, error carries a message. */
export type BridgeCommandResult =
  | { kind: 'success'; text?: string; sourceEventSeq?: number }
  | { kind: 'error'; text: string }

/** Tier-3 injection target: forward an unhandled slash line into the agent (index.ts wires processNormalText). */
export type AgentInjection = (msg: NormalizedMessage, text: string) => Promise<void>

let commandsHost: BridgeCommandsHost | undefined
let agentFallback: AgentInjection | undefined

/**
 * Tier-2 wiring point (called by index.ts at apply time, before any message):
 * setCommandsHost(ctx.get('commands') as BridgeCommandsHost | undefined).
 * undefined disables Tier 2 (host commands service not assembled).
 */
export function setCommandsHost(host: BridgeCommandsHost | undefined): void {
  commandsHost = host
}

/**
 * Tier-3 wiring point (called by index.ts at apply time): forward unhandled
 * slash lines into the agent (processNormalText). undefined keeps the legacy
 * "unknown command" reply — no behavior regression when unwired.
 */
export function setAgentFallback(fallback: AgentInjection | undefined): void {
  agentFallback = fallback
}

/** One command row of the COMMANDS table. */
interface Command {
  desc: string
  run(msg: NormalizedMessage, arg: string): Promise<void>
}

/** Next epoch for a chat: `${EPOCH}-<count+1>`. */
function nextEpoch(runtime: CommandRuntime, chatId: string): string {
  const n = Number(runtime.chatEpochs.get(chatId)?.split('-').pop() ?? 0)
  return `${runtime.EPOCH}-${n + 1}`
}

/** The chat's current model: /model preference first, then the live agent's options. */
function currentModel(runtime: CommandRuntime, chatId: string): BridgeModelPreference | undefined {
  const pref = runtime.chatModelPrefs.get(chatId)
  if (pref !== undefined) return pref
  const agent = liveAgent(runtime, chatId)
  const options = agent?.options
  if (options === undefined || options.model === undefined || options.model === '') return undefined
  return { provider: options.provider ?? '', model: options.model }
}

/** Live agent of the chat's current session, if any. */
function liveAgent(runtime: CommandRuntime, chatId: string): BridgeAgent | undefined {
  return runtime.getAgent(chatId)
}

/** Switch the live agent's route in place so the next turn uses the new model. */
function applyModelToLiveAgent(runtime: CommandRuntime, chatId: string, pref: BridgeModelPreference): void {
  const agent = liveAgent(runtime, chatId)
  if (agent === undefined || agent.options === undefined) return
  // agent-loop re-reads options.provider/model for every step's request config,
  // so mutating the creation-time options object (not frozen) changes the route
  // for the next turn while keeping the session's memory intact.
  agent.options.provider = pref.provider
  agent.options.model = pref.model
}

/** Resolve the chat's workspace display label (title + path, or 默认). */
function workspaceLabel(runtime: CommandRuntime, chatId: string): string {
  const id = runtime.chatWorkspaces.get(chatId)
  if (id === undefined) return '默认（宿主 cwd）'
  const registry = runtime.ctx.get('workspaceRegistry') as BridgeWorkspaceRegistry | undefined
  try {
    const w = registry?.list().find((it) => it.id === id)
    return w !== undefined ? `${w.title}（${w.path}）` : id
  } catch {
    return id
  }
}

/** Workspace owning a session, if any (workspace.sessionIds is authoritative). */
function workspaceForSession(runtime: CommandRuntime, sessionId: string): BridgeWorkspace | undefined {
  const registry = runtime.ctx.get('workspaceRegistry') as BridgeWorkspaceRegistry | undefined
  if (registry === undefined) return undefined
  try {
    return registry.list().find((w) => (w.sessionIds ?? []).includes(sessionId))
  } catch {
    return undefined
  }
}

/** Up to `max` latest non-empty assistant answer texts of a session log (excerpt source for /resume and /status). */
function latestAssistantAnswers(events: readonly BridgeLogEvent[], max: number): string[] {
  const out: string[] = []
  for (let i = events.length - 1; i >= 0 && out.length < max; i--) {
    const ev = events[i]
    if (ev.type !== 'assistant/message') continue
    const content = ev.data?.message?.content ?? []
    const text = content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    if (text !== '') out.push(text)
  }
  return out
}

/** Latest assistant answer text of a session log (excerpt source for /resume). */
function latestAnswer(events: readonly BridgeLogEvent[]): string {
  return latestAssistantAnswers(events, 1)[0] ?? ''
}

/** Last event timestamp of a session log (the honest "last active" time), 0 when unknown. */
function latestEventTime(events: readonly BridgeLogEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.time
    if (t !== undefined && t > 0) return t
  }
  return 0
}

/** One /resume candidate row. */
interface ResumeRow {
  epoch: string
  createdAt: number
  /** Last event timestamp (last active time); falls back to createdAt. */
  updatedAt: number
  running: boolean
  sessionId: string
  summary: string
}

/**
 * Top-10 sessions of this Feishu chat: with a bound workspace, every session
 * of that workspace (feishu-* and web session-* alike — the shared pool the
 * web GUI shows); without one, the chat's own feishu-* sessions (legacy).
 * Live sessions (sessions.list / agents.roots) are merged with cold persisted
 * sessions, ranked by creation time, with latest-answer excerpts. Archived
 * sessions are hidden.
 */
async function recentSessions(runtime: CommandRuntime, chatId: string): Promise<ResumeRow[]> {
  const slug = chatId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)
  const agents = runtime.ctx.get('agents') as BridgeAgentRegistry | undefined
  const liveStatus = new Map<string, string>()
  for (const agent of agents?.roots() ?? []) liveStatus.set(agent.id, agent.status ?? 'idle')
  const sessions = runtime.ctx.get('sessions') as BridgeSessionStore | undefined

  // Registry-global archive set: sessions archived in the web GUI (workspace
  // browser archive action) are hidden from every grouping surface there;
  // /resume must match, or archived sessions keep showing up in the list.
  const registry = runtime.ctx.get('workspaceRegistry') as BridgeWorkspaceRegistry | undefined
  const archived = new Set<string>(registry?.archivedSessionIds ?? [])

  // Scope to the chat's current workspace: the bound workspace's sessionIds
  // is the authoritative membership. No bound workspace → keep all feishu
  // sessions (legacy behavior).
  let allowed: Set<string> | null = null
  const bound = runtime.chatWorkspaces.get(chatId)
  if (bound !== undefined) {
    try {
      const w = registry?.list().find((it) => it.id === bound)
      if (w !== undefined) allowed = new Set(w.sessionIds?.map(String) ?? [])
    } catch { /* workspace.list failed — fall through to unfiltered */ }
  }

  const matches = (id: string): boolean =>
    !archived.has(id) && (allowed !== null
      ? allowed.has(id)
      : id.startsWith('feishu-') && id.endsWith(`-${slug}`))
  /** Epoch for feishu sessions; web sessions use their own id as the row key. */
  const epochOf = (id: string): string =>
    id.startsWith('feishu-') ? id.slice('feishu-'.length, id.length - slug.length - 1) : id

  const candidates = new Map<string, { createdAt: number; running: boolean; events: readonly BridgeLogEvent[] | null }>()
  for (const session of sessions?.list() ?? []) {
    if (typeof session.id !== 'string' || !matches(session.id)) continue
    candidates.set(session.id, {
      createdAt: session.header?.createdAt ?? 0,
      running: liveStatus.get(session.id) === 'running',
      events: session.events ?? [],
    })
  }
  const persistence = runtime.ctx.get('sessionPersistence') as BridgeSessionPersistence | undefined
  let headers: { id: string; createdAt: number }[] = []
  if (persistence !== undefined) {
    try { headers = await persistence.list() } catch { headers = [] }
  }
  for (const header of headers) {
    if (!matches(header.id) || candidates.has(header.id)) continue
    candidates.set(header.id, { createdAt: header.createdAt ?? 0, running: false, events: null })
  }

  const rows = [...candidates.entries()]
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .slice(0, 10)
  return await Promise.all(rows.map(async ([sessionId, row]) => {
    let events = row.events
    if (events === null && persistence !== undefined) {
      try {
        const inspection = await persistence.inspect(sessionId)
        events = inspection.events
      } catch { events = [] }
    }
    return {
      epoch: epochOf(sessionId),
      createdAt: row.createdAt,
      updatedAt: latestEventTime(events ?? []) || row.createdAt,
      running: row.running,
      sessionId,
      summary: latestAnswer(events ?? []),
    }
  }))
}

/** Materialize a cold session now so a persistence failure surfaces at /resume time. */
async function ensureResumable(runtime: CommandRuntime, chatId: string, sessionId: string): Promise<void> {
  const agents = runtime.ctx.get('agents') as BridgeAgentRegistry | undefined
  if (agents === undefined) throw new Error('agents 服务不可用')
  if (agents.get(sessionId) !== undefined) return // already live
  const persistence = runtime.ctx.get('sessionPersistence') as BridgeSessionPersistence | undefined
  if (persistence === undefined) throw new Error('会话持久化服务不可用（无法恢复历史会话）')
  const found = await persistence.list().then((list) => list.some((h) => h.id === sessionId)).catch(() => false)
  if (!found) throw new Error(`会话 ${sessionId} 不存在`)
  const agentOptions = runtime.chatModelPrefs.get(chatId)
  await agents.resume({
    resumeSessionId: sessionId,
    ...(agentOptions === undefined ? {} : { agentOptions }),
    // Effort preference rides an agent-scoped agent/request waterfall (see
    // src/effort.ts), same registration the index.ts create/resume path uses.
    setup: (agentCtx) => { installEffortPref(agentCtx, () => runtime.chatEffortPrefs.get(chatId)) },
  })
}

/**
 * Render the /status reply text for one chat — the exact text the /status
 * command sends. Shared with the restart announcement (index.ts) so every
 * remembered chat gets a fresh per-chat snapshot without a manual /status:
 * each chat has its own workspace/session, so the snapshot must be rendered
 * per chatId with the same value sources the command uses.
 */
export async function renderStatus(runtime: CommandRuntime, chatId: string): Promise<string> {
  const [model, preset, effort, usage] = await Promise.all([
    runtime.modelLabel(chatId),
    runtime.agentPreset(chatId),
    runtime.reasoningEffort(chatId),
    Promise.resolve(runtime.readCumulativeUsage(chatId)),
  ])
  const agentStatus = runtime.getAgent(chatId)?.status
  const lines = [
    `🤖 bot: ${runtime.channel.botIdentity?.name ?? runtime.appId}`,
    `🧩 模型: ${model}`,
    `💬 会话: ${runtime.sessionIdForChat(chatId)}`,
    `📁 工作区: ${workspaceLabel(runtime, chatId)}`,
  ]
  // 四项扩展信息全部条件显示：无值（未装配/无 agent/无推理档位/用量未知）时不显示对应行，不编造。
  if (preset !== undefined && preset !== '') lines.push(`🎛️ 模式: ${preset}`)
  if (effort !== undefined && effort !== '') lines.push(`🧠 思考强度: ${effort}`)
  if (usage !== null) lines.push(`🔢 token: billed ${formatTokens(usage.billed)} / output ${formatTokens(usage.output)}`)
  if (agentStatus !== undefined) lines.push(`⚡ agent: ${agentStatus}`)
  lines.push(
    `🔄 流式: ${(runtime.chatStreamPrefs.get(chatId) ?? runtime.streamDefault) ? 'on' : 'off'}`,
    `⏳ 队列深度: ${runtime.queueDepth(chatId)}`,
    `🕐 运行时长: ${Math.round((Date.now() - runtime.STARTED_AT) / 60_000)} 分钟`,
  )
  const currentEpoch = runtime.epochFor(chatId)
  let answers = (runtime.chatTranscript.get(chatId) ?? [])
    .filter((e) => e.role === 'assistant' && e.epoch === currentEpoch)
    .slice(-5)
  if (answers.length === 0) {
    // The in-memory transcript resets on plugin reload/restart; fall
    // back to the current session's persisted log so excerpts survive
    // restarts and /resume switches.
    const sessionId = runtime.sessionIdForChat(chatId)
    const persistence = runtime.ctx.get('sessionPersistence') as BridgeSessionPersistence | undefined
    if (persistence !== undefined) {
      try {
        const { events } = await persistence.inspect(sessionId)
        answers = latestAssistantAnswers(events ?? [], 5)
          .map((text) => ({ role: 'assistant' as const, text, epoch: currentEpoch }))
      } catch { /* keep empty */ }
    }
  }
  if (answers.length > 0) {
    lines.push('', '📜 当前会话最近回答（各取第一句）：')
    answers.forEach((a, i) => {
      const s = firstSentence(a.text)
      if (s !== '') lines.push(`${i + 1}. ${s}`)
    })
  }
  return lines.join('\n')
}

/**
 * Register the slash-command table against the bridge runtime and return the
 * dispatcher handle() uses. Command state mutations (epochs, workspace
 * binding, model preference) go through the runtime maps and persist().
 */
export function registerCommands(runtime: CommandRuntime): CommandRunner {
  const cmdReply = runtime.cmdReply

  const COMMANDS: Record<string, Command> = {
    help: {
      desc: '列出所有命令',
      async run(msg) {
        const lines = ['可用命令：']
        for (const [cmdName, cmd] of Object.entries(COMMANDS)) lines.push(`/${cmdName} — ${cmd.desc}`)
        if (commandsHost !== undefined) {
          lines.push('（DSH 宿主注册的命令如 /goal 会直接执行；其余以 / 开头的内容视为命令）')
        } else {
          lines.push('（其他以 / 开头的内容视为命令；想发给 AI 用 /ai <内容>）')
        }
        await cmdReply(msg, lines.join('\n'))
      },
    },
    ping: {
      desc: '连通性自检',
      async run(msg) {
        await cmdReply(msg, 'pong 🏓')
      },
    },
    status: {
      desc: '查看桥与当前会话状态（含最近对话）',
      async run(msg) {
        await cmdReply(msg, await renderStatus(runtime, msg.chatId))
      },
    },
    reset: {
      desc: '清空本会话记忆（开新 DSH 会话）',
      async run(msg) {
        const next = nextEpoch(runtime, msg.chatId)
        // Clear the session override BEFORE any persist: appendEpoch persists
        // synchronously, so deleting after it left a stale web-session binding
        // in state.json (survives reloads/restarts) — the /new escape hatch
        // silently failed.
        runtime.chatSessionOverride.delete(msg.chatId)
        runtime.chatEpochs.set(msg.chatId, next)
        runtime.appendEpoch(msg.chatId, next)
        await cmdReply(msg, '✅ 已重置本会话记忆，开始新的 DSH 会话。')
      },
    },
    new: {
      desc: '同 /reset：开新会话',
      async run(msg) {
        await COMMANDS.reset.run(msg, '')
      },
    },
    workspace: {
      desc: '列出/切换工作区：/workspace 或 /workspace <序号|路径>',
      async run(msg, arg) {
        const registry = runtime.ctx.get('workspaceRegistry') as BridgeWorkspaceRegistry | undefined
        if (registry === undefined) {
          await cmdReply(msg, '⚠️ 工作区服务不可用（未装配 workspaceRegistry）。')
          return
        }
        let items: BridgeWorkspace[]
        try { items = registry.list() } catch (error) {
          await cmdReply(msg, `⚠️ ${errorMessage(error).slice(0, 150)}`)
          return
        }
        const target = arg.trim()
        const current = runtime.chatWorkspaces.get(msg.chatId)
        if (target === '') {
          // 0 = 未分组（web GUI 同语义）：会话不进任何工作区，用宿主默认 cwd。
          const lines = [`0. 未分组（宿主默认 cwd）${current === undefined ? ' ← 当前' : ''}`]
          lines.push(...items.map((w, i) => {
            const mark = w.id === current ? ' ← 当前' : ''
            return `${i + 1}. ${w.title} — ${w.path}${mark}`
          }))
          if (lines.length === 1) lines.push('（还没有工作区；用 /workspace <路径> 添加一个已存在的目录）')
          lines.push('输入 /workspace <序号> 或 /workspace <路径> 切换（自动开新会话，记忆清空）；/workspace 0 回到未分组。')
          await cmdReply(msg, lines.join('\n'))
          return
        }
        // /workspace 0 = 解除工作区绑定（未分组，宿主默认 cwd），与 web GUI 的 0 一致。
        if (target === '0') {
          if (current === undefined) {
            await cmdReply(msg, '当前已经是未分组（宿主默认 cwd），无需切换。')
            return
          }
          runtime.chatWorkspaces.delete(msg.chatId)
          const next = nextEpoch(runtime, msg.chatId)
          runtime.chatEpochs.set(msg.chatId, next)
          runtime.appendEpoch(msg.chatId, next)
          runtime.chatSessionOverride.delete(msg.chatId)
          runtime.persist()
          await cmdReply(msg, '✅ 已解除工作区绑定（未分组，宿主默认 cwd），并开了新会话（记忆已清空）。')
          return
        }
        const n = Number.parseInt(target, 10)
        let workspace: BridgeWorkspace
        if (!Number.isNaN(n)) {
          const w = items[n - 1]
          if (w === undefined) { await cmdReply(msg, `序号无效（可用 0-${items.length}，先 /workspace 查看）。`); return }
          if (w.id === current) { await cmdReply(msg, `已经是工作区 #${n}「${w.title}」，无需切换。`); return }
          workspace = w
        } else {
          try {
            workspace = await registry.create(target)
          } catch (error) {
            await cmdReply(msg, `⚠️ 切换失败：${errorMessage(error).slice(0, 200)}（路径需是已存在的目录）`)
            return
          }
        }
        const already = workspace.id === current
        runtime.chatWorkspaces.set(msg.chatId, workspace.id)
        if (already) {
          await cmdReply(msg, `✅ 已经是工作区「${workspace.title}」（${workspace.path}），无需重开会话。`)
          return
        }
        const next = nextEpoch(runtime, msg.chatId)
        runtime.chatEpochs.set(msg.chatId, next)
        runtime.appendEpoch(msg.chatId, next)
        runtime.chatSessionOverride.delete(msg.chatId)
        runtime.persist()
        await cmdReply(msg, `✅ 已切到工作区「${workspace.title}」（${workspace.path}），并开了新会话（记忆已清空）。`)
      },
    },
    model: {
      desc: '列出/切换模型：/model 或 /model <序号>',
      async run(msg, arg) {
        const llm = runtime.ctx.get('llm') as BridgeLlm | undefined
        if (llm === undefined) {
          await cmdReply(msg, '⚠️ 模型服务不可用（未装配 llm）。')
          return
        }
        const entries: Array<{ provider: string; providerName: string; model: string }> = []
        try {
          for (const provider of llm.listProviders()) {
            const models = await llm.listModels(provider.id)
            for (const model of models) entries.push({ provider: provider.id, providerName: provider.name, model: model.id })
          }
        } catch (error) {
          await cmdReply(msg, `⚠️ ${errorMessage(error).slice(0, 150)}`)
          return
        }
        const current = currentModel(runtime, msg.chatId)
        const n = Number.parseInt(arg, 10)
        if (arg.trim() === '' || Number.isNaN(n)) {
          if (entries.length === 0) { await cmdReply(msg, '没有可用模型。'); return }
          const lines = entries.map((e, i) => {
            const isCur = current !== undefined && e.provider === current.provider && e.model === current.model
            return `${i + 1}. ${e.model}（${e.providerName ?? e.provider}）${isCur ? ' ← 当前' : ''}`
          })
          if (current !== undefined && !entries.some((e) => e.provider === current.provider && e.model === current.model)) {
            lines.push(`（当前不在列表中：${current.provider} / ${current.model}）`)
          }
          lines.push('输入 /model <序号> 切换（下一回合生效，记忆保留）。')
          await cmdReply(msg, lines.join('\n'))
          return
        }
        const entry = entries[n - 1]
        if (entry === undefined) { await cmdReply(msg, `序号无效（可用 1-${entries.length}，先 /model 查看）。`); return }
        const pref: BridgeModelPreference = { provider: entry.provider, model: entry.model }
        runtime.chatModelPrefs.set(msg.chatId, pref)
        applyModelToLiveAgent(runtime, msg.chatId, pref)
        await cmdReply(msg, `✅ 已切换模型：${entry.model}（${entry.providerName ?? entry.provider}），下一回合生效（记忆保留）。`)
      },
    },
    effort: {
      desc: '查看/切换思考强度：/effort 或 /effort <档位>',
      async run(msg, arg) {
        const target = arg.trim()
        // 当前值 = per-chat 偏好优先，否则运行时实际值（reasoningEffort 读取）。
        const current = await currentEffort(runtime, msg.chatId)
        const route = currentModel(runtime, msg.chatId)
        const efforts = await supportedEfforts(runtime.ctx, route)
        if (target === '') {
          const label = current ?? '—'
          if (efforts === null) {
            // 未知适配器：只显示实际值，不编造档位列表。
            await cmdReply(msg, `🧠 当前思考强度: ${label}\n（该模型的适配器未暴露档位列表，无法枚举；/effort <档位> 仍可尝试切换）`)
            return
          }
          const lines = [`🧠 思考强度档位（当前: ${label}）：`]
          lines.push(...efforts.map((e) => `• ${e}${e === current ? ' ← 当前' : ''}`))
          const provider = route?.provider !== undefined && route.provider !== '' ? route.provider : '当前模型'
          lines.push(`（该列表来自 ${provider} 的适配器；/effort <档位> 切换，下一回合生效）`)
          await cmdReply(msg, lines.join('\n'))
          return
        }
        // 档位在支持列表内才接受；枚举不到列表（未知模型）时宽松接受任意非空值，防误伤。
        if (efforts !== null && !efforts.includes(target)) {
          await cmdReply(msg, `⚠️ 档位 ${target} 不在支持列表（${efforts.join(' / ')}）。\n输入 /effort 查看当前支持的档位。`)
          return
        }
        runtime.chatEffortPrefs.set(msg.chatId, target)
        runtime.persist()
        await cmdReply(msg, `✅ 思考强度已切换为 ${target}（下一回合生效）。`)
      },
    },
    stream: {
      desc: '流式开关：/stream on|off（本会话）',
      async run(msg, arg) {
        const v = arg.toLowerCase()
        if (v === 'on' || v === 'off') {
          runtime.chatStreamPrefs.set(msg.chatId, v === 'on')
          await cmdReply(msg, `✅ 本会话流式回复已${v === 'on' ? '开启' : '关闭'}。`)
        } else {
          await cmdReply(msg, `当前流式：${(runtime.chatStreamPrefs.get(msg.chatId) ?? runtime.streamDefault) ? 'on' : 'off'}（用法：/stream on|off）`)
        }
      },
    },
    cancel: {
      desc: '取消当前回合（回合卡住时自救）',
      async run(msg) {
        const running = runtime.chatTurns.get(msg.chatId)
        if (running === undefined) { await cmdReply(msg, '当前没有运行中的回合。'); return }
        running.cancel()
        await cmdReply(msg, '🛑 已取消当前回合，队列恢复。')
      },
    },
    resume: {
      desc: '列出最近会话（Top10，带摘要）或切换：/resume 或 /resume <序号>',
      async run(msg, arg) {
        // The chat's current session id: a resumed web session override, else
        // the feishu-<epoch>-<slug> session of the current epoch.
        const currentSessionId = runtime.sessionIdForChat(msg.chatId)
        const n = Number.parseInt(arg, 10)
        let recent: ResumeRow[]
        try {
          recent = await recentSessions(runtime, msg.chatId)
        } catch (error) {
          await cmdReply(msg, `⚠️ 无法读取会话列表：${errorMessage(error).slice(0, 150)}`)
          return
        }
        if (arg.trim() === '' || Number.isNaN(n)) {
          if (recent.length === 0) { await cmdReply(msg, '本对话还没有历史会话。'); return }
          const lines = [`📁 当前工作区：${workspaceLabel(runtime, msg.chatId)}`, '']
          lines.push(...recent.map((s, i) => {
            const when = s.updatedAt > 0
              ? new Date(s.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
              : '—'
            const excerpt = s.summary.replace(/\s+/g, ' ').trim()
            const label = excerpt !== '' ? `「${excerpt.length > 40 ? `${excerpt.slice(0, 40)}…` : excerpt}」` : '（无内容）'
            return `${i + 1}. ${label}${s.sessionId === currentSessionId ? ' ← 当前' : ''}（活跃 ${when}）${s.running ? ' ⏳运行中' : ''}`
          }))
          if (runtime.chatWorkspaces.get(msg.chatId) !== undefined) {
            lines.push('（显示当前工作区的全部会话——含 web 端创建的会话；已归档的已隐藏）')
          }
          lines.push('输入 /resume <序号> 切换并恢复那段记忆。')
          await cmdReply(msg, lines.join('\n'))
          return
        }
        const item = recent[n - 1]
        if (item === undefined) { await cmdReply(msg, `序号无效（可用 1-${recent.length}，先 /resume 查看）。`); return }
        if (item.sessionId === currentSessionId) { await cmdReply(msg, `已经是会话 #${n}，无需切换。`); return }
        try {
          await ensureResumable(runtime, msg.chatId, item.sessionId)
        } catch (error) {
          await cmdReply(msg, `⚠️ 恢复失败：${errorMessage(error).slice(0, 200)}`)
          return
        }
        if (item.sessionId.startsWith('feishu-')) {
          runtime.chatEpochs.set(msg.chatId, item.epoch)
          runtime.appendEpoch(msg.chatId, item.epoch)
          runtime.chatSessionOverride.delete(msg.chatId)
        } else {
          // A web session becomes the chat's current session (override);
          // the feishu epoch bookkeeping is untouched while it stays active.
          runtime.chatSessionOverride.set(msg.chatId, item.sessionId)
        }
        // Sync the workspace binding if the resumed session belongs to a
        // different workspace than the chat is bound to (sessionIds authoritative).
        try {
          const w = workspaceForSession(runtime, item.sessionId)
          if (w !== undefined) runtime.chatWorkspaces.set(msg.chatId, w.id)
        } catch { /* keep current binding on workspace lookup failure */ }
        runtime.persist()
        const excerpt = item.summary.replace(/\s+/g, ' ').trim()
        const label = excerpt !== '' ? `「${excerpt.length > 40 ? `${excerpt.slice(0, 40)}…` : excerpt}」` : ''
        await cmdReply(msg, `✅ 已切到会话 #${n} ${label}，那段记忆已恢复。`)
      },
    },
    restart: {
      desc: '重连飞书长连接（不退出进程）',
      async run(msg) {
        await cmdReply(msg, '♻️ 正在重连…')
        await runtime.restartChannel()
        await cmdReply(msg, '✅ 已重连。')
      },
    },
    setup: {
      desc: '扫码授权飞书应用（生成授权链接，打开后扫码即完成配置）',
      async run(msg) {
        const flow = runtime.startSetup()
        if (flow === null) {
          await cmdReply(msg, '⚠️ 已有配置流程在进行中，请等待其完成后再试。')
          return
        }
        // 立即回复授权链接：registerApp 的 onQRCodeReady 是异步回调，链接生成
        // 后即可先回复，不要等完整流程。
        try {
          const info = await flow.qrReady
          await cmdReply(msg,
            `🔗 请打开链接并用飞书扫码授权（${info.expireIn} 秒内有效）：\n${info.url}\n\n`
            + '⚠️ 若应用创建后无法收发消息，请到开发者后台确认已开启机器人能力与 '
            + 'im:message、im:message:send_as_bot 权限并发布版本。')
        } catch (error) {
          await cmdReply(msg, `❌ ${setupErrorMessage(error)}`)
          return
        }
        // 后台等待授权完成：写凭据 + 重建连接（成功后新桥会向各聊天发送重启通知）。
        void (async () => {
          try {
            const result = await flow.result
            await cmdReply(msg, `✅ 已获取凭据（App ID: ${result.appId}），正在重连飞书…`)
            saveCredentials(result)
            await runtime.rebuildChannel(result.appId, result.appSecret)
          } catch (error) {
            runtime.log('feishu setup failed:', setupErrorMessage(error))
            try { await cmdReply(msg, `❌ ${setupErrorMessage(error)}`) } catch { /* chat gone */ }
          }
        })()
      },
    },
    yolo: {
      desc: '本会话免审批模式（权限预设切 danger-full-access，/yolo off 恢复）',
      async run(msg, arg) {
        const off = arg.trim().toLowerCase() === 'off'
        const agent = runtime.getAgent(msg.chatId)
        const presets = runtime.ctx.get('permissionPresets') as BridgePermissionPresetsService | undefined
        const approval = runtime.ctx.get('approval') as BridgeApprovalService | undefined
        if (off) {
          // 关闭：恢复受管模式。flag 无条件清除（approval.ts 的兜底自动放行随之关闭）；
          // agent/服务齐备才做预设切换，缺一也不阻塞 flag 关闭（优雅降级）。
          if (agent !== undefined && presets !== undefined && approval !== undefined) {
            approval.setPolicy(agent, 'ask')
            presets.set(agent.session, 'workspace-write')
          }
          runtime.chatYoloPrefs.set(msg.chatId, false)
          await cmdReply(msg, '🔒 YOLO 已关闭：本会话恢复 workspace-write（工具审批恢复）。')
          return
        }
        if (agent === undefined) {
          await cmdReply(msg, '⚠️ 会话尚未激活：先发一条消息让 DSH 会话就绪，再开启 /yolo。')
          return
        }
        if (presets === undefined || approval === undefined) {
          await cmdReply(msg, '⚠️ 权限预设服务不可用（未装配 permissionPresets/approval），无法切换。')
          return
        }
        // 顺序关键：先 setPolicy（写 approval/policy 事件 + 注入模型可见通知），
        // 再 permissionPresets.set()——set() 内部写 approval knob 时值已相同则幂等
        // 跳过，不会让 setPolicy 的通知因 early-return 丢失。
        approval.setPolicy(agent, 'never')
        presets.set(agent.session, 'danger-full-access')
        runtime.chatYoloPrefs.set(msg.chatId, true)
        await cmdReply(msg, '⚡ YOLO 已开启：本会话权限预设 → danger-full-access（免审批直接执行）。/yolo off 恢复。')
      },
    },
  }

  /**
   * Tier 2: execute a host-registered command natively (no model round-trip).
   * Requires the host service (setCommandsHost) and a live chat agent — the
   * command runs against the chat's session. Returns true when consumed.
   */
  async function runHostCommand(
    msg: NormalizedMessage,
    text: string,
    cmdName: string,
    arg: string,
  ): Promise<boolean> {
    const host = commandsHost
    if (host === undefined) return false
    const agent = runtime.getAgent(msg.chatId)
    if (agent === undefined) return false
    try {
      if (host.find(agent, cmdName) === undefined) return false
      // Rebuild a normalized lowercase line: host parseCommand requires
      // /[a-z][a-z0-9_-]*/, so an uppercase /Goal must not silently miss.
      const line = `/${cmdName}${arg !== '' ? ` ${arg}` : ''}`
      const execution = await host.execute(agent, line, new AbortController().signal)
      if (execution === undefined) return false // syntax/name race — Tier 3
      const result = execution.result
      if (result.kind === 'success') {
        if (result.text !== undefined && result.text !== '') await cmdReply(msg, result.text)
      } else {
        await cmdReply(msg, `⚠️ ${result.text}`)
      }
      return true
    } catch (error) {
      // Handler failure: never wedge the chat — fall through to Tier 3.
      runtime.log(`host command /${cmdName} failed:`, errorMessage(error))
      return false
    }
  }

  async function runCommand(msg: NormalizedMessage, text: string): Promise<void> {
    const parts = text.slice(1).split(/\s+/)
    const raw = parts[0] ?? ''
    const cmdName = raw.toLowerCase()
    const arg = parts.slice(1).join(' ').trim()
    const cmd = COMMANDS[cmdName]
    if (cmd !== undefined) {
      // Tier 1: bridge command — existing handling, unchanged.
      try {
        await cmd.run(msg, arg)
      } catch (error) {
        runtime.log(`command /${cmdName} failed:`, errorMessage(error))
        await cmdReply(msg, `⚠️ 命令执行失败：${errorMessage(error).slice(0, 200)}`)
      }
      return
    }
    // Tier 2: DSH host-registered command (e.g. /goal) — native execution.
    if (await runHostCommand(msg, text, cmdName, arg)) return
    // Tier 3: injection into the agent (wired by index.ts); unwired keeps the
    // legacy unknown-command reply — zero regression.
    if (agentFallback !== undefined) {
      await agentFallback(msg, text)
      return
    }
    await cmdReply(msg, `未知命令 /${cmdName}。输入 /help 查看可用命令；想把内容发给 AI，用 /ai <内容>。`)
  }

  return { runCommand }
}
