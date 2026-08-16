/**
 * 持久化出站 Outbox —— P0 可靠性核心（借鉴自 amlyczz/dsh-lark-link (MIT)
 * src/outbound/outbox.ts，按本机形态化用）。
 *
 * at-least-once 投递：JSONL 分段文件 + .tmp 再 rename 原子落盘；重启时
 * rebuild 把 in-flight 的 sending 回滚为 pending；dedupeKey 幂等
 * （sentKeys 从磁盘重建）；状态机 pending→sending→done|failed|fatal；
 * 有界指数退避（封顶 backoffMaxMs=60s）；失败离队不阻塞（retrySweep
 * 队尾追加）；分航道并行（laneKey=chatKey，航道内 FIFO）；终态按
 * retainDays 清理。超长 payload（>blobThreshold=24KB）溢出到 blobs/
 * 目录单独文件，内存与 JSONL 只存 blobRef。
 *
 * 与 lark-link 原版的化用差异（详见 docs/research 对比矩阵）：
 * 1. 本机没有独立的 sender/OutboundEnvelope/RouteRef 抽象层 —— deliver
 *    以「注入函数」方式提供（createOutbox({ deliver })），envelope 即
 *    投递单元，payload 为本机回复形状 { chatId, kind: text|card, ... }。
 * 2. deliver 抛错（原版会直接把 envelope 卡在 sending 直到重启）在这里
 *    被捕获并折算为 retryable 失败，进程内即可自愈。
 * 3. 无 onStatsChange 回调（本机 /status 不展示 outbox 计数）。
 *
 * 刻意零 DSH / 零飞书 SDK 依赖：sender 注入，模块可独立单测。
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'

/** deliver 的判定结果：ok，或失败（retryable=false 视为永久错误 → fatal）。 */
export type OutboxDeliveryResult = { ok: true } | { ok: false; retryable: boolean; error: string }

/** 本机可重放的出站载荷：channel.send 的输入（text 或 card），含回复目标。 */
export interface OutboxPayload {
  chatId: string
  kind: 'text' | 'card'
  text?: string
  card?: object
  /** 回复哪条飞书消息（channel.send 的 replyTo）。 */
  replyTo?: string
  /** 触发本次回复的入站消息 messageId；投递成功后用于 WAL delivered()。 */
  sourceMessageId?: string
}

/** 磁盘/内存中的投递单元（payload 或 blobRef 二选一）。 */
export interface OutboxEnvelope {
  id: string
  dedupeKey: string
  laneKey: string
  kind: OutboxPayload['kind']
  payload?: OutboxPayload
  blobRef?: string
  status: 'pending' | 'sending' | 'failed' | 'done' | 'fatal'
  attempts: number
  error?: string
  nextRetryAt: number
  createdAt: number
  updatedAt: number
}

export interface OutboxDeps {
  /** 持久化目录（如 ~/.dsh/dsh-feishu-bridge/outbox）。 */
  dir: string
  /** 注入的投递函数：把一条 envelope 发给飞书。抛错/返回 {ok:false} 均视为失败。 */
  deliver(env: OutboxEnvelope): Promise<OutboxDeliveryResult>
  cfg?: Partial<{
    /** 单条最大重试次数，超出转 fatal。 */
    maxAttempts: number
    /** 指数退避封顶（ms）。 */
    backoffMaxMs: number
    /** 终态（done/fatal）保留天数，超期清理。 */
    retainDays: number
    /** 队列硬上限：拒绝入队而非无界增长。 */
    pendingCap: number
    /** payload 序列化超过该字节数时溢出 blob 文件。 */
    blobThreshold: number
  }>
  now?: () => number
  /** 永久错误判定（如 chat 不存在 / 参数非法）；缺省按错误文案启发式匹配。 */
  isFatalError?: (error: string) => boolean
}

export interface Outbox {
  /** 入队一条待投递消息；返回 envelope id，幂等键已存在或队列满时返回 undefined。 */
  enqueue(input: {
    dedupeKey: string
    laneKey: string
    kind: OutboxPayload['kind']
    payload: OutboxPayload
    /** true 跳过幂等检查（补发/对账场景）。 */
    skipDedupe?: boolean
  }): string | undefined
  /** 启动泵（分航道并发排空 + 自调度终态清理）。 */
  start(): void
  /** 停止泵（等 in-flight 投递收敛）。 */
  stop(): Promise<void>
  pendingCount(): number
  failedCount(): number
  /** 清理超期终态 envelope（及对应 blob）。 */
  prune(): void
  /** 崩溃恢复：磁盘重建，sending 回滚 pending。 */
  rebuildFromDisk(): void
  /** 当前有积压的航道（测试/诊断用）。 */
  lanes(): string[]
}

const DEFAULT_CFG = {
  maxAttempts: 5,
  backoffMaxMs: 60_000,
  retainDays: 3,
  pendingCap: 1000,
  blobThreshold: 24 * 1024,
} as const

/** 缺省永久错误判定：明确的参数/权限/不存在类错误，排除网络瞬时类。 */
function defaultIsFatal(error: string): boolean {
  if (/timeout|ECONN|socket|fetch failed|ETIMEDOUT|EAI_AGAIN/i.test(error)) return false
  return /invalid|not found|不存在|forbidden|permission|230001|230002|230007|240001/i.test(error)
}

/** Unref 的 sleep：空闲泵不拖住进程退出。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  })
}

export function createOutbox(deps: OutboxDeps): Outbox {
  const now = deps.now ?? Date.now
  const cfg = { ...DEFAULT_CFG, ...deps.cfg }
  const dir = deps.dir
  const isFatal = deps.isFatalError ?? defaultIsFatal
  mkdirSync(join(dir, 'blobs'), { recursive: true })

  /** id -> envelope（全部状态，受 prune 约束）。 */
  const envelopes = new Map<string, OutboxEnvelope>()
  /** laneKey -> FIFO 待投递 id 列表（pending+failed+sending）。 */
  const lanes = new Map<string, string[]>()
  /** dedupeKey -> envelope id（幂等，随 rebuild 从磁盘重建）。 */
  const sentKeys = new Map<string, string>()

  let draining = false
  let stopped = false
  let pruneTimer: NodeJS.Timeout | undefined
  const activeDeliveries = new Set<Promise<void>>()
  const laneQueues = new Map<string, Promise<void>>()
  /** 空闲泵的唤醒信号（入队时立即唤醒，零轮询延迟）。 */
  let idleWake: (() => void) | undefined

  // ---- 持久化 -------------------------------------------------------------
  const segmentPath = (n: number): string => join(dir, `seg-${n}.jsonl`)

  function loadSegment(file: string): void {
    try {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const env = JSON.parse(line) as OutboxEnvelope
          envelopes.set(env.id, env)
          // 任何状态都记幂等键：重启后同样不会重复投递。
          if (env.dedupeKey) sentKeys.set(env.dedupeKey, env.id)
          if (env.status === 'pending' || env.status === 'failed' || env.status === 'sending') {
            const lane = lanes.get(env.laneKey) ?? []
            lane.push(env.id)
            lanes.set(env.laneKey, lane)
          }
        } catch {
          // 跳过损坏行
        }
      }
    } catch {
      // 段文件缺失/损坏 —— 跳过
    }
  }

  function rebuildFromDisk(): void {
    envelopes.clear()
    lanes.clear()
    sentKeys.clear()
    let segs: string[] = []
    try {
      segs = readdirSync(dir)
        .filter((f) => /^seg-\d+\.jsonl$/.test(f))
        .sort((a, b) => {
          const na = Number(basename(a).match(/\d+/)?.[0] ?? 0)
          const nb = Number(basename(b).match(/\d+/)?.[0] ?? 0)
          return na - nb
        })
    } catch {
      segs = []
    }
    for (const seg of segs) loadSegment(join(dir, seg))
    // 崩溃恢复：sending = 进程死时仍在投递 → 回滚 pending 重新投递。
    let changed = false
    for (const env of envelopes.values()) {
      if (env.status === 'sending') {
        env.status = 'pending'
        env.updatedAt = now()
        changed = true
      }
    }
    if (changed) persistAll()
  }

  /** 全量重写一个新鲜段文件（tmp + rename 原子落盘），并清理超期段文件。 */
  function persistAll(): void {
    try {
      const segFile = segmentPath(Math.floor(now() / 1000))
      const lines = [...envelopes.values()].map((e) => JSON.stringify(e))
      const tmp = `${segFile}.tmp`
      writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 })
      renameSync(tmp, segFile)
      const cutoff = now() - cfg.retainDays * 86_400_000
      for (const f of readdirSync(dir).filter((x) => /^seg-\d+\.jsonl$/.test(x))) {
        const ts = Number(basename(f).match(/\d+/)?.[0] ?? 0) * 1000
        if (ts < cutoff) {
          try {
            rmSync(join(dir, f))
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // 持久化 best-effort；内存态继续
    }
  }

  // ---- 超长 payload 溢出 blob ----------------------------------------------
  function spill(payload: OutboxPayload): { payload?: OutboxPayload; blobRef?: string } {
    const size = JSON.stringify(payload).length
    if (size <= cfg.blobThreshold) return { payload }
    const ref = `${randomUUID()}.json`
    try {
      writeFileSync(join(dir, 'blobs', ref), JSON.stringify(payload), { mode: 0o600 })
      return { blobRef: ref }
    } catch {
      return { payload } // 溢出失败 —— 保留内联
    }
  }

  function resolvePayload(env: OutboxEnvelope): OutboxPayload | undefined {
    if (env.payload) return env.payload
    if (env.blobRef) {
      try {
        return JSON.parse(readFileSync(join(dir, 'blobs', env.blobRef), 'utf8')) as OutboxPayload
      } catch {
        return undefined
      }
    }
    return undefined
  }

  // ---- 入队 ---------------------------------------------------------------
  function enqueue(input: {
    dedupeKey: string
    laneKey: string
    kind: OutboxPayload['kind']
    payload: OutboxPayload
    skipDedupe?: boolean
  }): string | undefined {
    if (stopped) return undefined
    // 幂等在入队时强制（任何状态）：同一逻辑消息绝不二次投递。
    if (!input.skipDedupe && sentKeys.has(input.dedupeKey)) return undefined
    if (envelopes.size >= cfg.pendingCap) return undefined
    const id = randomUUID()
    const spilled = spill(input.payload)
    const env: OutboxEnvelope = {
      id,
      dedupeKey: input.dedupeKey,
      laneKey: input.laneKey,
      kind: input.kind,
      status: 'pending',
      attempts: 0,
      nextRetryAt: now(),
      createdAt: now(),
      updatedAt: now(),
      ...spilled,
    }
    envelopes.set(id, env)
    sentKeys.set(input.dedupeKey, id)
    const lane = lanes.get(input.laneKey) ?? []
    lane.push(id)
    lanes.set(input.laneKey, lane)
    persistAll()
    idleWake?.()
    return id
  }

  // ---- 排空 ---------------------------------------------------------------
  async function deliverOne(id: string): Promise<void> {
    const env = envelopes.get(id)
    if (!env || env.status === 'done' || env.status === 'fatal') return
    const payload = resolvePayload(env)
    if (payload === undefined) {
      env.status = 'fatal'
      env.error = 'payload unresolved (blob missing)'
      env.updatedAt = now()
      return
    }
    env.status = 'sending'
    env.updatedAt = now()
    const resolved: OutboxEnvelope = { ...env, payload }
    // 与 lark-link 差异：deliver 抛错折算为 retryable 失败，不让 envelope
    // 卡死在 sending 等到重启才恢复。
    let result: OutboxDeliveryResult
    try {
      result = await deps.deliver(resolved)
    } catch (error) {
      result = { ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) }
    }
    if (result.ok) {
      env.status = 'done'
      env.updatedAt = now()
      if (env.dedupeKey) sentKeys.set(env.dedupeKey, env.id)
    } else {
      env.attempts += 1
      env.error = result.error
      env.updatedAt = now()
      if (!result.retryable || isFatal(result.error)) {
        env.status = 'fatal'
      } else if (env.attempts >= cfg.maxAttempts) {
        env.status = 'fatal' // 重试次数耗尽 —— 放弃
      } else {
        env.status = 'failed'
        // 有界指数退避，封顶 backoffMaxMs。
        const backoff = Math.min(cfg.backoffMaxMs, 1000 * 2 ** Math.min(env.attempts - 1, 10))
        env.nextRetryAt = now() + backoff
      }
    }
    // 失败消息不回插航道头部（离队不阻塞）：已在排空时出队，留待 retrySweep 队尾追加。
    persistAll()
  }

  /** 航道 FIFO 排空一条：失败即离队，不阻塞后续消息。 */
  async function drainLane(laneKey: string): Promise<void> {
    const ids = lanes.get(laneKey)
    if (!ids || ids.length === 0) return
    const head = ids.shift()
    lanes.set(laneKey, ids)
    if (head !== undefined) await deliverOne(head)
  }

  /** 重试清扫：把到期的 failed envelope 追加到所属航道队尾。 */
  function retrySweep(): void {
    let woke = false
    const due: string[] = []
    for (const env of envelopes.values()) {
      if (env.status === 'failed' && env.nextRetryAt <= now()) due.push(env.id)
    }
    for (const id of due) {
      const env = envelopes.get(id)
      if (env) {
        const lane = lanes.get(env.laneKey) ?? []
        if (!lane.includes(id)) {
          lane.push(id)
          lanes.set(env.laneKey, lane)
          woke = true
        }
      }
    }
    if (woke) idleWake?.()
  }

  async function pump(): Promise<void> {
    if (draining) return
    draining = true
    try {
      while (!stopped) {
        retrySweep()
        let worked = false
        for (const laneKey of lanes.keys()) {
          const ids = lanes.get(laneKey)
          if (ids && ids.length > 0) {
            worked = true
            // 每条航道一条链：航道内串行 FIFO，航道间并发。
            const laneQueue = laneQueues.get(laneKey) ?? Promise.resolve()
            const next = laneQueue.then(() => drainLane(laneKey))
            laneQueues.set(laneKey, next.catch(() => undefined))
            activeDeliveries.add(next)
            void next.finally(() => activeDeliveries.delete(next))
          }
        }
        if (!worked) {
          // 空闲：等入队唤醒（或 200ms 安全超时），新任务零轮询延迟。
          await new Promise<void>((resolve) => {
            idleWake = resolve
            const t = setTimeout(() => {
              idleWake = undefined
              resolve()
            }, 200)
            t.unref?.()
          })
          idleWake = undefined
        } else {
          await sleep(25)
        }
      }
    } finally {
      draining = false
    }
  }

  /** 终态清理：done/fatal 超 retainDays 的 envelope + blob 删除。 */
  function doPrune(): void {
    const cutoff = now() - cfg.retainDays * 86_400_000
    let changed = false
    for (const [id, env] of envelopes) {
      if ((env.status === 'done' || env.status === 'fatal') && env.updatedAt < cutoff) {
        envelopes.delete(id)
        if (env.blobRef) {
          try {
            rmSync(join(dir, 'blobs', env.blobRef))
          } catch {
            // ignore
          }
        }
        changed = true
      }
    }
    if (changed) persistAll()
  }

  return {
    enqueue,
    start() {
      stopped = false
      doPrune()
      // 自调度终态清理：无外部调用者时磁盘段也不会无限增长。
      const cadence = Math.max(3_600_000, Math.min(24 * 3_600_000, cfg.retainDays * 3_600_000))
      pruneTimer = setInterval(() => doPrune(), cadence)
      if (pruneTimer.unref) pruneTimer.unref()
      void pump()
    },
    async stop() {
      stopped = true
      if (pruneTimer !== undefined) clearInterval(pruneTimer)
      pruneTimer = undefined
      await Promise.allSettled([...activeDeliveries])
    },
    pendingCount() {
      let n = 0
      for (const env of envelopes.values()) {
        if (env.status === 'pending' || env.status === 'failed') n++
      }
      return n
    },
    failedCount() {
      let n = 0
      for (const env of envelopes.values()) {
        if (env.status === 'failed') n++
      }
      return n
    },
    prune: doPrune,
    rebuildFromDisk,
    lanes: () => [...lanes.keys()],
  }
}
