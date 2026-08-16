/**
 * 入站 WAL —— 入站请求补发（借鉴自 amlyczz/dsh-lark-link (MIT)
 * src/inbound/inbound-wal.ts，按本机消息形状化用）。
 *
 * 目的：进程崩溃 / 插件重载发生在 agent 回合中途时，已被 accept 但回复
 * 未送达的用户消息不该静默丢失 —— 每次把消息注入 agent 之前先落盘记录，
 * 回复成功送达后标记 delivered；启动对账把 accepted 而未 delivered 的
 * 记录（窗口内、次数未超）重新派发（skipDedupe 语义），实现 at-least-once。
 *
 * JSONL seg 文件 + tmp 再 rename 原子落盘（0600）；text 只记纯文本并截断
 * 8000；maxReplayAttempts=2；replayRetentionMs=30min。
 *
 * 与 lark-link 原版的化用差异：
 * 1. 记录形状简化为本机消息 {messageId, chatKey, text}（本机 chatKey 即
 *    Feishu chatId，也是会话键来源），无 chatType/senderOpenId 等字段
 *    （重放走 handle 的 replayed 旁路，不再重跑入站过滤）。
 * 2. prune() 额外清理磁盘上的陈旧 seg 文件（原版只清内存、段文件随
 *    persistAll 无限累积 —— 本机每次全量重写后旧段即冗余，删掉更干净）。
 * 3. 无 walDirExists 导出（本机不需要）。
 *
 * 刻意零 DSH / 零飞书 SDK 依赖：纯持久化原语，可独立单测。
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** 一条记录的投递状态。 */
export type WalState = 'accepted' | 'delivered' | 'replayed'

export interface WalRecord {
  messageId: string
  /** 会话键：本机即 Feishu chatId（laneKey 同源）。 */
  chatKey: string
  /** 注入 agent 的纯文本（截断 8000）。 */
  text: string
  acceptedAt: number
  attempts: number
  state: WalState
}

export interface WalDeps {
  /** 持久化目录（如 ~/.dsh/dsh-feishu-bridge/wal）。 */
  dir: string
  /** accepted 未 delivered 记录的补发窗口（缺省 30min）。 */
  replayRetentionMs?: number
  /** 单条记录最大补发次数（缺省 2）。 */
  maxReplayAttempts?: number
  /** text 截断长度（缺省 8000）。 */
  maxTextLength?: number
  now?: () => number
}

export interface InboundWal {
  /** 记录（或刷新）一条待投递的 agent 请求为 accepted；返回完整记录。 */
  accept(msg: { messageId: string; chatKey: string; text: string }): WalRecord
  /** 标记该 messageId 的回复已成功送达。 */
  delivered(messageId: string): void
  /** 枚举窗口内 accepted/replayed 且未 delivered、次数未超的记录，旧的在前。 */
  pendingReplays(): WalRecord[]
  /** accepted → replayed 并 +1 次数；已 delivered / 超次数 / 超窗口返回 false。 */
  markReplay(messageId: string): boolean
  /** 清理：delivered 超窗口的记录、以及耗尽次数的未投递记录 + 陈旧 seg 文件。 */
  prune(): void
  /** 当前内存记录数（诊断用）。 */
  pendingCount(): number
}

/** 磁盘段文件超过该年龄即视为冗余（每次 persistAll 全量重写，旧段必为副本）。 */
const SEG_STALE_MS = 60 * 60_000

export function createWal(deps: WalDeps): InboundWal {
  const dir = deps.dir
  const replayRetentionMs = deps.replayRetentionMs ?? 30 * 60_000
  const maxReplayAttempts = deps.maxReplayAttempts ?? 2
  const maxTextLength = deps.maxTextLength ?? 8000
  const now = deps.now ?? Date.now
  mkdirSync(dir, { recursive: true })

  /** messageId -> record（受 prune 约束的有界集合）。 */
  const records = new Map<string, WalRecord>()

  function load(): void {
    let segs: string[] = []
    try {
      segs = readdirSync(dir)
        .filter((f) => /^seg-.*\.jsonl$/.test(f))
        .sort()
    } catch {
      segs = []
    }
    // 段文件按文件名排序读取；同一 messageId 后写覆盖先写（每次 persistAll
    // 全量重写，最新段即权威快照，旧段仅作损坏兜底）。
    for (const seg of segs) {
      try {
        const lines = readFileSync(join(dir, seg), 'utf8').split('\n').filter(Boolean)
        for (const line of lines) {
          try {
            const rec = JSON.parse(line) as WalRecord
            if (rec?.messageId) records.set(rec.messageId, rec)
          } catch {
            // 跳过损坏行
          }
        }
      } catch {
        // 段缺失/损坏 —— 跳过
      }
    }
  }

  function persistAll(): void {
    try {
      const segFile = join(dir, `seg-${Date.now()}.jsonl`)
      const tmp = `${segFile}.tmp`
      const lines = [...records.values()].map((r) => JSON.stringify(r))
      writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 })
      renameSync(tmp, segFile)
    } catch {
      // best-effort 持久化；内存态继续
    }
  }

  load()

  return {
    accept(msg) {
      const full: WalRecord = {
        messageId: msg.messageId,
        chatKey: msg.chatKey,
        text: msg.text.slice(0, maxTextLength),
        acceptedAt: now(),
        attempts: 0,
        state: 'accepted',
      }
      records.set(msg.messageId, full)
      persistAll()
      return full
    },
    delivered(messageId) {
      const rec = records.get(messageId)
      if (!rec || rec.state === 'delivered') return
      rec.state = 'delivered'
      persistAll()
    },
    markReplay(messageId) {
      const rec = records.get(messageId)
      if (!rec) return false
      if (rec.state === 'delivered') return false
      if (rec.attempts >= maxReplayAttempts) return false
      if (now() - rec.acceptedAt > replayRetentionMs) return false
      rec.attempts += 1
      rec.state = 'replayed'
      persistAll()
      return true
    },
    pendingReplays() {
      const cutoff = now() - replayRetentionMs
      return [...records.values()]
        .filter(
          (r) =>
            r.state !== 'delivered' &&
            r.attempts < maxReplayAttempts &&
            r.acceptedAt >= cutoff,
        )
        .sort((a, b) => a.acceptedAt - b.acceptedAt)
    },
    prune() {
      const deliveredCutoff = now() - replayRetentionMs
      let changed = false
      for (const [id, r] of records) {
        // delivered 记录在窗口后老化；从未投递的记录仅当同时超出窗口且次数耗尽才删。
        const expired =
          r.state === 'delivered'
            ? r.acceptedAt < deliveredCutoff
            : r.acceptedAt < deliveredCutoff && r.attempts >= maxReplayAttempts
        if (expired) {
          records.delete(id)
          changed = true
        }
      }
      if (changed) persistAll()
      // 磁盘清理：陈旧 seg 文件（冗余快照）删除，保留最新一份。
      let segs: string[] = []
      try {
        segs = readdirSync(dir).filter((f) => /^seg-.*\.jsonl$/.test(f))
      } catch {
        segs = []
      }
      const stale = segs
        .filter((f) => {
          const ts = Number(basename(f).replace(/^seg-/, '').replace(/\.jsonl$/, ''))
          return Number.isFinite(ts) && Date.now() - ts > SEG_STALE_MS
        })
        .sort()
      // 全量重写后的旧段全部冗余；即使本次没有内存变更也清理。
      for (const f of stale) {
        try {
          rmSync(join(dir, f))
        } catch {
          // ignore
        }
      }
    },
    pendingCount: () => records.size,
  }
}
