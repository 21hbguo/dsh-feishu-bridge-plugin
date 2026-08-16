/**
 * Durable per-chat state: chatEpochs / chatSessionList / chatWorkspaces /
 * chatEffortPrefs persisted to ~/.dsh/dsh-feishu-bridge/state.json.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const STATE_FILE = join(homedir(), '.dsh', 'dsh-feishu-bridge', 'state.json')

/** One durable state row set, as persisted in state.json. */
export interface BridgeState {
  chatEpochs: Record<string, string>
  chatSessionList: Record<string, string[]>
  chatWorkspaces: Record<string, string>
  /** Per-chat current-session override: a web session (session-<uuid>) resumed into the chat. */
  chatSessionOverride: Record<string, string>
  /** Per-chat thinking-effort preference set by /effort; applied on the next turn (survives restarts). */
  chatEffortPrefs: Record<string, string>
}

/** Load the state file; any failure yields the empty default. */
export function loadState(): BridgeState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<BridgeState>
    return {
      chatEpochs: parsed.chatEpochs ?? {},
      chatSessionList: parsed.chatSessionList ?? {},
      chatWorkspaces: parsed.chatWorkspaces ?? {},
      chatSessionOverride: parsed.chatSessionOverride ?? {},
      chatEffortPrefs: parsed.chatEffortPrefs ?? {},
    }
  } catch {
    return { chatEpochs: {}, chatSessionList: {}, chatWorkspaces: {}, chatSessionOverride: {}, chatEffortPrefs: {} }
  }
}

/**
 * 写全量 state：目录自动创建；先写临时文件再 rename 原子落盘（避免半截
 * JSON —— 直写目标文件时写一半崩溃会让 loadState 静默回默认、丢掉全部
 * 会话绑定）；权限强制 0600。rename 失败（罕见）退化为直接写目标文件。
 * （原子写风格仿 src/setup.ts 的凭据落盘；setup.ts 同款写法。）
 */
export function saveState(state: BridgeState): void {
  const dir = dirname(STATE_FILE)
  mkdirSync(dir, { recursive: true })
  const text = `${JSON.stringify(state, null, 2)}\n`
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
 * DSH session id for a Feishu chat: `feishu-<epoch>-<slug>`. The slug is the
 * chat id scrubbed to [a-zA-Z0-9_-], capped at 40 chars; the epoch is the
 * chat's current memory generation.
 */
export function sessionIdFor(chatId: string, epoch: string): string {
  const slug = chatId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)
  return `feishu-${epoch}-${slug}`
}
