/**
 * Durable per-chat state: chatEpochs / chatSessionList / chatWorkspaces /
 * chatEffortPrefs / chatPermissionTiers / chatModes persisted to
 * ~/.dsh/dsh-feishu-bridge/state.json.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const STATE_FILE = join(homedir(), '.dsh', 'dsh-feishu-bridge', 'state.json')

/**
 * Per-chat permission tier set by /permission (P2). 'full' is the
 * danger-full-access 全放行端（与 /yolo 同语义），'workspace-write' 受管模式，
 * 'read-only' 沙箱只读（部署未配置 read-only 预设时经 sandbox/mode 事件落地）。
 */
export type PermissionTier = 'read-only' | 'workspace-write' | 'full'

/** One durable state row set, as persisted in state.json. */
export interface BridgeState {
  chatEpochs: Record<string, string>
  chatSessionList: Record<string, string[]>
  chatWorkspaces: Record<string, string>
  /** Per-chat current-session override: a web session (session-<uuid>) resumed into the chat. */
  chatSessionOverride: Record<string, string>
  /** Per-chat thinking-effort preference set by /effort; applied on the next turn (survives restarts). */
  chatEffortPrefs: Record<string, string>
  /**
   * Per-chat permission tier set by /permission（P2）。由 commands.ts 经
   * savePermissionTier 独占维护（index.ts 的持久化视图不含最新值，故
   * saveState 总是保留磁盘上的该字段——见 saveState 注释）。
   */
  chatPermissionTiers: Record<string, PermissionTier>
  /**
   * Per-chat agent-mode (agentPreset id) preference set by /mode（P2.5）。
   * 由 commands.ts 经 saveChatMode 独占维护，独占写模式同
   * chatPermissionTiers（index.ts 的持久化视图不含最新值，saveState
   * 总是保留磁盘上的该字段——见 saveState 注释）。
   */
  chatModes: Record<string, string>
}

/** Read the current on-disk state verbatim ({} on missing/corrupt file). */
function readDiskState(): Partial<BridgeState> {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<BridgeState>
  } catch {
    return {}
  }
}

/** Load the state file; any failure yields the empty default. */
export function loadState(): BridgeState {
  const parsed = readDiskState()
  return {
    chatEpochs: parsed.chatEpochs ?? {},
    chatSessionList: parsed.chatSessionList ?? {},
    chatWorkspaces: parsed.chatWorkspaces ?? {},
    chatSessionOverride: parsed.chatSessionOverride ?? {},
    chatEffortPrefs: parsed.chatEffortPrefs ?? {},
    chatPermissionTiers: parsed.chatPermissionTiers ?? {},
    chatModes: parsed.chatModes ?? {},
  }
}

/** Atomic 0600 write of a fully-merged state object (shared by saveState / savePermissionTier). */
function writeStateFile(merged: BridgeState): void {
  const dir = dirname(STATE_FILE)
  mkdirSync(dir, { recursive: true })
  const text = `${JSON.stringify(merged, null, 2)}\n`
  const tmp = join(dir, `.state.tmp-${process.pid}`)
  writeFileSync(tmp, text, { mode: 0o600 })
  try {
    renameSync(tmp, STATE_FILE)
  } catch {
    writeFileSync(STATE_FILE, text, { mode: 0o600 })
    try { unlinkSync(tmp) } catch { /* already gone */ }
  }
  try { chmodSync(STATE_FILE, 0o600) } catch { /* best effort */ }
}

/**
 * 写全量 state：目录自动创建；先写临时文件再 rename 原子落盘（避免半截
 * JSON —— 直写目标文件时写一半崩溃会让 loadState 静默回默认、丢掉全部
 * 会话绑定）；权限强制 0600。rename 失败（罕见）退化为直接写目标文件。
 * （原子写风格仿 src/setup.ts 的凭据落盘；setup.ts 同款写法。）
 *
 * chatPermissionTiers 例外：该字段由 commands.ts 经 savePermissionTier 独占
 * 写入（P2 /permission），index.ts 的持久化视图（createRuntime 启动时装载的
 * state 对象）永远不会包含最新值——若按常规以传入值为准，index.ts 的任意一次
 * persist() 都会把该字段回写成启动时的陈旧快照，/permission 的持久化即失效。
 * 因此这里总是以磁盘上的最新值为准（读改写闭环在 savePermissionTier 内完成）。
 *
 * chatModes 例外同理（P2.5 /mode）：由 commands.ts 经 saveChatMode 独占写入，
 * 这里同样保留磁盘最新值。
 */
export function saveState(state: BridgeState): void {
  const disk = readDiskState()
  writeStateFile({
    ...disk,
    ...state,
    chatPermissionTiers: (disk.chatPermissionTiers ?? {}) as Record<string, PermissionTier>,
    chatModes: (disk.chatModes ?? {}) as Record<string, string>,
  })
}

/**
 * 写入一个 chat 的权限档（P2 /permission 专用写路径）：读磁盘最新值 → 改一个
 * key → 原子落盘。与 saveState 的「保留磁盘 chatPermissionTiers」约定互补，
 * 保证该字段不被 index.ts 的陈旧持久化视图覆盖。
 */
export function savePermissionTier(chatId: string, tier: PermissionTier): void {
  const disk = readDiskState()
  const tiers = { ...(disk.chatPermissionTiers ?? {}) }
  tiers[chatId] = tier
  writeStateFile({
    chatEpochs: disk.chatEpochs ?? {},
    chatSessionList: disk.chatSessionList ?? {},
    chatWorkspaces: disk.chatWorkspaces ?? {},
    chatSessionOverride: disk.chatSessionOverride ?? {},
    chatEffortPrefs: disk.chatEffortPrefs ?? {},
    chatPermissionTiers: tiers,
    chatModes: (disk.chatModes ?? {}) as Record<string, string>,
  })
}

/**
 * 写入一个 chat 的 Agent 模式偏好（P2.5 /mode 专用写路径）：读磁盘最新值 →
 * 改一个 key → 原子落盘。与 saveState 的「保留磁盘 chatModes」约定互补，
 * 保证该字段不被 index.ts 的陈旧持久化视图覆盖（独占写模式同
 * savePermissionTier；写路径里同样带全量字段，避免丢其他键）。
 */
export function saveChatMode(chatId: string, presetId: string): void {
  const disk = readDiskState()
  const modes = { ...(disk.chatModes ?? {}) }
  modes[chatId] = presetId
  writeStateFile({
    chatEpochs: disk.chatEpochs ?? {},
    chatSessionList: disk.chatSessionList ?? {},
    chatWorkspaces: disk.chatWorkspaces ?? {},
    chatSessionOverride: disk.chatSessionOverride ?? {},
    chatEffortPrefs: disk.chatEffortPrefs ?? {},
    chatPermissionTiers: (disk.chatPermissionTiers ?? {}) as Record<string, PermissionTier>,
    chatModes: modes,
  })
}

/**
 * DSH session id for a Feishu chat: `feishu-<epoch>-<slug>`. The slug is the
 * chat id scrubbed to [a-zA-Z0-9_-], capped at 40 chars; the epoch is the
 * chat's current memory generation.
 */
export function sessionIdFor(chatId: string, epoch: string): string {
  const slug = chatId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)
  return `feishu-${epoch}-${slug}`
}
