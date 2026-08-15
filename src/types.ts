/**
 * Local structural types for the DSH in-process surface the bridge drives.
 *
 * The plugin's declared dependency set is deliberately small (cordis /
 * schemastery / @larksuiteoapi/node-sdk / @deepseek-ai/dsh-llm), so the
 * agent / session / token-meter shapes below mirror the dsh-agent /
 * dsh-session interfaces instead of importing those packages. The real
 * `session/event` event augmentation and the `ctx.agents` service typing
 * are already present in the compilation through the linked dsh-tools
 * declaration files; the bridge reads services via `ctx.get()` so the
 * branded `SessionId` never leaks into this package.
 */

/** Token accounting carried by an assistant/message event (mirror of TokenUsage). */
export interface BridgeTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Minimal model-facing content block; text is the only block the bridge produces. */
export interface BridgeContentBlock {
  type: string
  text?: string
}

/** User message accepted by agent.followup / agent.steer (mirror of UserMessage). */
export interface BridgeUserMessage {
  content: BridgeContentBlock[]
  source: { kind: 'user' } | { kind: 'plugin'; plugin: string }
}

/** Why a turn ended; 'blocked' means the turn waits for a human (ask). */
export interface BridgeTurnEndReason {
  kind: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'blocked' | 'interrupted' | (string & {})
}

/**
 * Session event narrowed to the members per-session turn listeners consume.
 * Each member carries a literal `type` so discriminated narrowing works; the
 * real event is cast onto this view once at the `ctx.on('session/event')`
 * boundary, and any event whose `type` is not listed here simply falls
 * through every branch.
 */
export type BridgeSessionEvent =
  | { type: 'assistant/chunk'; data: { turn: number; step: number; chunk: { type: string; text?: string } } }
  | { type: 'assistant/message'; data: { turn: number; step: number; message: { content?: BridgeContentBlock[] }; usage?: BridgeTokenUsage } }
  | { type: 'turn/end'; data: { turn: number; reason: BridgeTurnEndReason } }
  | { type: 'tool/call'; data: { turn: number; step: number; name: string } }

/** Detached session header (mirror of dsh-session SessionHeader). */
export interface BridgeSessionHeader {
  id: string
  createdAt: number
  cwd?: string
}

/** Structural view of one logged session event (summary scanning for /resume). */
export interface BridgeLogEvent {
  type: string
  data: { message?: { content?: BridgeContentBlock[] } }
  /** Event timestamp (epoch ms); present on real session events. */
  time?: number
}

/** Minimal session handle (mirror of dsh-session Session). */
export interface BridgeSession {
  id: string
  seq?: number
  header?: BridgeSessionHeader
  events?: readonly BridgeLogEvent[]
  /** Last logged request config (provider/model the session actually ran with; same source session.models reads). */
  requestHeader?(): { config?: { provider?: string; model?: string } } | undefined
}

/** Live session store (mirror of dsh-session SessionStore). */
export interface BridgeSessionStore {
  list(): BridgeSession[]
}

/** Persisted cold-session access (mirror of SessionPersistence). */
export interface BridgeSessionPersistence {
  list(signal?: AbortSignal): Promise<BridgeSessionHeader[]>
  inspect(id: string, signal?: AbortSignal): Promise<{ meta: BridgeSessionHeader; events: readonly BridgeLogEvent[] }>
}

/** Cancel cause accepted by agent.cancel (mirror of AgentCancelCause). */
export type BridgeCancelCause =
  | { kind: 'user' }
  | { kind: 'parent' }
  | { kind: 'hook'; reason: string }
  | { kind: 'disposed' }

/** Live agent handle (mirror of the Agent interface). */
export interface BridgeAgent {
  id: string
  session: BridgeSession
  options?: { provider?: string; model?: string }
  status?: 'idle' | 'running'
  followup(message: BridgeUserMessage): void
  steer(message: BridgeUserMessage): void
  cancel(cause: BridgeCancelCause, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
}

/** Agent registry service (mirror of AgentRegistry). */
export interface BridgeAgentRegistry {
  create(options: {
    sessionId: string
    meta?: { cwd?: string; parentSession?: string; agentPreset?: string }
    agentOptions?: { provider?: string; model?: string; maxTokens?: number }
    setup?: (agentCtx: unknown) => void | Promise<void>
  }): Promise<{ agent: BridgeAgent; dispose(): Promise<void> }>
  resume(options: {
    resumeSessionId: string
    agentOptions?: { provider?: string; model?: string; maxTokens?: number }
    signal?: AbortSignal
    setup?: (agentCtx: unknown) => void | Promise<void>
  }): Promise<{ agent: BridgeAgent; dispose(): Promise<void> }>
  get(id: string): BridgeAgent | undefined
  list(): BridgeAgent[]
  roots(): BridgeAgent[]
}

/**
 * Approval policy values (mirror of APPROVAL_POLICIES in dsh-user-approval:
 * ['ask', 'never']). 'never' is the YOLO 免审批端，'ask' 是受管模式。
 */
export type BridgeApprovalPolicy = 'ask' | 'never'

/**
 * Approval service surface the /yolo command drives (mirror of
 * ApprovalService.setPolicy — live per-agent switch: writes the
 * approval/policy knob and injects a model-visible notification; early-returns
 * when the policy is unchanged).
 */
export interface BridgeApprovalService {
  setPolicy(agent: BridgeAgent, policy: BridgeApprovalPolicy): void
}

/**
 * Permission-presets service surface the /yolo command drives (mirror of
 * PermissionPresetsService.set — per-session preset switch: appends
 * permission/preset then writes the sandbox/mode + approval/policy knobs
 * idempotently; unknown names throw).
 */
export interface BridgePermissionPresetsService {
  set(session: BridgeSession, name: string): void
}

/** Result of tokenMeter.measure (mirror of TokenMeasurement). */
export interface BridgeTokenMeasurement {
  totalTokens: number
  surfaceTokens?: number
}

/** Token meter service (mirror of TokenMeter). */
export interface BridgeTokenMeter {
  measure(session: BridgeSession): BridgeTokenMeasurement
}

/** Workspace entity (mirror of dsh-workspace Workspace). */
export interface BridgeWorkspace {
  id: string
  path: string
  title: string
  sessionIds?: readonly string[]
  attachSession(sessionId: string): Promise<void>
}

/** Workspace registry service (mirror of WorkspaceRegistry). */
export interface BridgeWorkspaceRegistry {
  list(): BridgeWorkspace[]
  get(id: string): BridgeWorkspace | undefined
  create(path: string, title?: string): Promise<BridgeWorkspace>
  /** Registry-global archive set: sessions archived in the web GUI are hidden from every grouping surface there. */
  readonly archivedSessionIds?: readonly string[]
}

/** LLM route directory (mirror of the llm service catalog reads /model uses). */
export interface BridgeLlm {
  listProviders(): { id: string; name: string }[]
  listModels(provider: string): Promise<readonly { id: string; name: string }[]>
}

/** Per-chat model preference set by /model; applied on the next turn. */
export interface BridgeModelPreference {
  provider: string
  model: string
}

/** One running turn handle kept per chat (mirror of the runtime's TurnEntry). */
export interface BridgeTurnEntry {
  startedAt: number
  interrupted: boolean
  cancel(): void
}

/** One transcript row kept per chat (mirror of the runtime's TranscriptEntry). */
export interface BridgeTranscriptEntry {
  role: 'user' | 'assistant'
  text: string
  epoch: string
}

/**
 * Ambient augmentation: declare the `session/event` event on the cordis
 * `Events` map with the bridge's structural view. The plugin does not import
 * the dsh-session / dsh-agent packages (undeclared dependencies), so without
 * this the event name would not be a member of `keyof Events` and `ctx.on`
 * would reject it at compile time. At runtime the real SessionEvent is
 * structurally compatible: every member the bridge reads (`assistant/chunk`
 * text-delta, `assistant/message` usage, `turn/end` reason) exists verbatim;
 * other event types simply fall through the type checks.
 */
declare module 'cordis' {
  interface Events {
    /** Post-commit session event feed; filter by session.id in the listener. */
    'session/event'(session: BridgeSession, event: BridgeSessionEvent): void
  }
}
