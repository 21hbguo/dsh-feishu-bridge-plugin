/**
 * Durable per-chat state: chatEpochs / chatSessionList / chatWorkspaces
 * persisted to ~/.dsh/dsh-feishu-bridge/state.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
    }
  } catch {
    return { chatEpochs: {}, chatSessionList: {}, chatWorkspaces: {}, chatSessionOverride: {} }
  }
}

/** Write the full state back (sync write, JSON 2-space). */
export function saveState(state: BridgeState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
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
