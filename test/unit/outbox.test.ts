/**
 * P0 Outbox 出站队列单元测试（vitest）。
 *
 * 被测功能与来源：src/outbox.ts「持久化出站 Outbox」（JSONL 分段 + 原子落盘、
 * dedupeKey 幂等 sentKeys、状态机 pending→sending→done|failed|fatal、指数退避
 * 封顶 60s、失败离队 retrySweep、分航道 lane、终态清理、24KB blob 溢出、重启
 * rebuild sending→pending 回滚）——commit ddf61a0「feat: 出站 Outbox（JSONL+
 * 原子落盘+幂等键+分航道+退避+重启恢复），借鉴 lark-link」。
 *
 * 测试策略：目录参数化（os.tmpdir 临时目录，绝不触碰真实
 * ~/.dsh/dsh-feishu-bridge）；deliver 注入假函数；泵行为用 vi fake timers
 * 驱动（入队→失败→退避重试→成功；lane 隔离；重启重建）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOutbox, type Outbox, type OutboxEnvelope } from '../../src/outbox.js'

let dir: string
beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'dsh-outbox-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function makeOutbox(overrides: Partial<Parameters<typeof createOutbox>[0]> = {}): Outbox {
  const deliver = overrides.deliver ?? vi.fn().mockResolvedValue({ ok: true })
  return createOutbox({
    dir,
    deliver,
    cfg: { maxAttempts: 5, backoffMaxMs: 1000, retainDays: 1, pendingCap: 100, blobThreshold: 24 * 1024, ...(overrides.cfg ?? {}) },
    ...overrides,
  } as Parameters<typeof createOutbox>[0])
}

/** 让泵跑过若干毫秒（fake timers）。 */
async function pump(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** 读最新（时间戳最大）seg 文件的全文——终态断言走磁盘真相。 */
function latestSegText(): string {
  const segs = readdirSync(dir).filter((f) => /^seg-\d+\.jsonl$/.test(f)).sort()
  expect(segs.length).toBeGreaterThan(0)
  return readFileSync(join(dir, segs[segs.length - 1]!), 'utf8')
}

describe('outbox 入队与幂等', () => {
  it('入队后 pendingCount/lanes 可见、磁盘落 seg 文件，start 前不投递', () => {
    const deliver = vi.fn().mockResolvedValue({ ok: true })
    const ob = makeOutbox({ deliver })
    const id = ob.enqueue({ dedupeKey: 'k1', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text', text: 'hi' } })
    expect(id).toBeTruthy()
    expect(ob.pendingCount()).toBe(1)
    expect(ob.lanes()).toEqual(['l1'])
    expect(deliver).not.toHaveBeenCalled()
    const seg = readdirSync(dir).find((f) => /^seg-\d+\.jsonl$/.test(f))
    expect(seg).toBeTruthy()
    expect(readFileSync(join(dir, seg!), 'utf8')).toContain('"dedupeKey":"k1"')
  })

  it('同 dedupeKey 拒绝重投（任意状态）；skipDedupe 绕过', () => {
    const ob = makeOutbox()
    const first = ob.enqueue({ dedupeKey: 'k1', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text' } })
    expect(first).toBeTruthy()
    expect(ob.enqueue({ dedupeKey: 'k1', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text' } })).toBeUndefined()
    const bypass = ob.enqueue({ dedupeKey: 'k1', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text' }, skipDedupe: true })
    expect(bypass).toBeTruthy()
    expect(ob.pendingCount()).toBe(2)
  })

  it('pendingCap 满时拒绝入队', () => {
    const ob = makeOutbox({ cfg: { pendingCap: 2 } })
    ob.enqueue({ dedupeKey: 'a', laneKey: 'l', kind: 'text', payload: { chatId: 'c', kind: 'text' } })
    ob.enqueue({ dedupeKey: 'b', laneKey: 'l', kind: 'text', payload: { chatId: 'c', kind: 'text' } })
    expect(ob.enqueue({ dedupeKey: 'c', laneKey: 'l', kind: 'text', payload: { chatId: 'c', kind: 'text' } })).toBeUndefined()
  })

  it('stop 后拒绝入队', async () => {
    const ob = makeOutbox()
    await ob.stop()
    expect(ob.enqueue({ dedupeKey: 'a', laneKey: 'l', kind: 'text', payload: { chatId: 'c', kind: 'text' } })).toBeUndefined()
  })
})

describe('outbox 投递状态机', () => {
  it('成功路径：pending→sending→done，payload 原样送达', async () => {
    const deliver = vi.fn().mockResolvedValue({ ok: true })
    const ob = makeOutbox({ deliver })
    const payload = { chatId: 'c', kind: 'text' as const, text: 'hello', sourceMessageId: 'sm1' }
    ob.enqueue({ dedupeKey: 'k1', laneKey: 'l1', kind: 'text', payload })
    ob.start()
    await pump(50)
    await ob.stop()
    expect(deliver).toHaveBeenCalledTimes(1)
    // deliver 收到的是投递瞬间的快照（status=sending）；终态断言读磁盘 seg。
    const env = deliver.mock.calls[0]![0] as OutboxEnvelope
    expect(env.payload).toMatchObject(payload)
    expect(ob.pendingCount()).toBe(0)
    expect(ob.failedCount()).toBe(0)
    const seg = latestSegText()
    expect(seg).toContain('"status":"done"')
    expect(seg).not.toContain('"status":"pending"')
  })

  it('失败→指数退避重试→成功（attempts 递增，backoff 后再投）', async () => {
    const deliver = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, retryable: true, error: 'network hiccup' })
      .mockResolvedValue({ ok: true })
    const ob = makeOutbox({ deliver, cfg: { backoffMaxMs: 1000 } })
    ob.enqueue({ dedupeKey: 'k1', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text' } })
    ob.start()
    await pump(50)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(ob.failedCount()).toBe(1)
    // 未到退避时间：重试清扫不拾取
    await pump(900)
    expect(deliver).toHaveBeenCalledTimes(1)
    // 退避到期（≥1000ms）后重投成功
    await pump(300)
    await ob.stop()
    expect(deliver).toHaveBeenCalledTimes(2)
    const env = deliver.mock.calls[1]![0] as OutboxEnvelope
    expect(env.attempts).toBe(1)
    expect(ob.pendingCount()).toBe(0)
    expect(latestSegText()).toContain('"status":"done"')
  })

  it('deliver 抛错折算为 retryable 失败，不卡死在 sending', async () => {
    const deliver = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ ok: true })
    const ob = makeOutbox({ deliver })
    ob.enqueue({ dedupeKey: 'k1', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text' } })
    ob.start()
    await pump(50)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(ob.failedCount()).toBe(1) // 而非 pending 卡死
    await pump(1200)
    await ob.stop()
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('重试次数耗尽（maxAttempts）转 fatal', async () => {
    const deliver = vi.fn().mockResolvedValue({ ok: false, retryable: true, error: 'always fails' })
    const ob = makeOutbox({ deliver, cfg: { maxAttempts: 2, backoffMaxMs: 1000 } })
    ob.enqueue({ dedupeKey: 'k1', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text' } })
    ob.start()
    await pump(50)
    expect(deliver).toHaveBeenCalledTimes(1)
    await pump(1200)
    expect(deliver).toHaveBeenCalledTimes(2)
    await pump(2500)
    await ob.stop()
    expect(deliver).toHaveBeenCalledTimes(2) // fatal 后不再投
    expect(ob.pendingCount()).toBe(0)
    expect(ob.failedCount()).toBe(0)
  })

  it('缺省永久错误启发式：not found 类文案直接 fatal；timeout 类可重试', async () => {
    const deliver = vi.fn().mockResolvedValue({ ok: false, retryable: true, error: 'chat not found' })
    const ob = makeOutbox({ deliver })
    ob.enqueue({ dedupeKey: 'k1', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text' } })
    ob.start()
    await pump(50)
    await ob.stop()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(ob.pendingCount()).toBe(0)
    // timeout 文案 → 可重试
    const deliver2 = vi.fn().mockResolvedValue({ ok: false, retryable: true, error: 'fetch failed: ETIMEDOUT' })
    const ob2 = makeOutbox({ deliver: deliver2 })
    ob2.enqueue({ dedupeKey: 'k2', laneKey: 'l2', kind: 'text', payload: { chatId: 'c', kind: 'text' } })
    ob2.start()
    await pump(50)
    expect(ob2.failedCount()).toBe(1)
    await ob2.stop()
  })

  it('isFatalError 注入覆盖缺省启发式', async () => {
    const deliver = vi.fn().mockResolvedValue({ ok: false, retryable: true, error: 'anything' })
    const ob = makeOutbox({ deliver, isFatalError: () => true })
    ob.enqueue({ dedupeKey: 'k1', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text' } })
    ob.start()
    await pump(50)
    await ob.stop()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(ob.pendingCount()).toBe(0) // 直接 fatal，不再重试
  })

  it('retryable=false 的判定结果直接 fatal', async () => {
    const deliver = vi.fn().mockResolvedValue({ ok: false, retryable: false, error: 'permanent' })
    const ob = makeOutbox({ deliver })
    ob.enqueue({ dedupeKey: 'k1', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text' } })
    ob.start()
    await pump(50)
    await ob.stop()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(ob.pendingCount()).toBe(0)
  })
})

describe('outbox 分航道', () => {
  it('lane 隔离并行：两航道都送达，各自 FIFO 顺序保持', async () => {
    const order: string[] = []
    const deliver = vi.fn().mockImplementation(async (env: OutboxEnvelope) => {
      order.push(`${env.laneKey}:${(env.payload as { text: string }).text}`)
      return { ok: true }
    })
    const ob = makeOutbox({ deliver })
    ob.enqueue({ dedupeKey: 'a1', laneKey: 'la', kind: 'text', payload: { chatId: 'c', kind: 'text', text: 'A1' } })
    ob.enqueue({ dedupeKey: 'a2', laneKey: 'la', kind: 'text', payload: { chatId: 'c', kind: 'text', text: 'A2' } })
    ob.enqueue({ dedupeKey: 'b1', laneKey: 'lb', kind: 'text', payload: { chatId: 'c', kind: 'text', text: 'B1' } })
    ob.start()
    await pump(200)
    await ob.stop()
    expect(deliver).toHaveBeenCalledTimes(3)
    // 同航道内严格 FIFO
    expect(order.filter((o) => o.startsWith('la:'))).toEqual(['la:A1', 'la:A2'])
    expect(order.filter((o) => o.startsWith('lb:'))).toEqual(['lb:B1'])
  })

  it('失败消息离队不阻塞航道：队头失败，队尾先送出，失败后经 retrySweep 补投', async () => {
    const order: string[] = []
    const deliver = vi.fn().mockImplementation(async (env: OutboxEnvelope) => {
      const text = (env.payload as { text: string }).text
      order.push(text)
      return text === 'A' ? { ok: false, retryable: true, error: 'temp' } : { ok: true }
    })
    const ob = makeOutbox({ deliver, cfg: { backoffMaxMs: 500 } })
    ob.enqueue({ dedupeKey: 'a', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text', text: 'A' } })
    ob.enqueue({ dedupeKey: 'b', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text', text: 'B' } })
    ob.start()
    await pump(50)
    // A 失败离队，B 不阻塞：B 已送出
    expect(order).toContain('B')
    await pump(700) // A 的退避到期补投
    await ob.stop()
    expect(order).toEqual(['A', 'B', 'A'])
  })
})

describe('outbox 重启恢复与终态清理', () => {
  it('rebuildFromDisk 恢复 pending 与幂等键：同 dedupeKey 仍拒绝重投', async () => {
    const ob1 = makeOutbox()
    ob1.enqueue({ dedupeKey: 'k1', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text', text: 'hi' } })
    const ob2 = makeOutbox()
    ob2.rebuildFromDisk()
    expect(ob2.pendingCount()).toBe(1)
    expect(ob2.enqueue({ dedupeKey: 'k1', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text' } })).toBeUndefined()
  })

  it('崩溃恢复：磁盘 sending 记录 rebuild 回滚为 pending 并重新投递', async () => {
    const stale: OutboxEnvelope = {
      id: 'e-stale',
      dedupeKey: 'k-stale',
      laneKey: 'l1',
      kind: 'text',
      payload: { chatId: 'c', kind: 'text', text: 'crashed' },
      status: 'sending',
      attempts: 1,
      nextRetryAt: 0,
      createdAt: 0,
      updatedAt: 0,
    }
    writeFileSync(join(dir, 'seg-1000000000.jsonl'), JSON.stringify(stale) + '\n')
    const deliver = vi.fn().mockResolvedValue({ ok: true })
    const ob = makeOutbox({ deliver })
    ob.rebuildFromDisk()
    ob.start()
    await pump(100)
    await ob.stop()
    expect(deliver).toHaveBeenCalledTimes(1)
    const env = deliver.mock.calls[0]![0] as OutboxEnvelope
    expect(env.id).toBe('e-stale')
    expect(ob.pendingCount()).toBe(0)
    expect(latestSegText()).toContain('"status":"done"')
  })

  it('损坏段行跳过：坏 JSON 不影响其余记录加载', () => {
    writeFileSync(join(dir, 'seg-1000000001.jsonl'), '{broken json\n' + JSON.stringify({ id: 'ok', dedupeKey: 'd', laneKey: 'l', kind: 'text', payload: { chatId: 'c', kind: 'text' }, status: 'pending', attempts: 0, nextRetryAt: 0, createdAt: 0, updatedAt: 0 }) + '\n')
    const ob = makeOutbox()
    ob.rebuildFromDisk()
    expect(ob.pendingCount()).toBe(1)
  })

  it('prune 清理超 retainDays 的终态（含 blob），保留新记录', async () => {
    const deliver = vi.fn().mockResolvedValue({ ok: true })
    const ob = makeOutbox({ deliver, cfg: { retainDays: 1, blobThreshold: 100 } })
    const longText = 'x'.repeat(300)
    ob.enqueue({ dedupeKey: 'k1', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text', text: longText } })
    ob.enqueue({ dedupeKey: 'k2', laneKey: 'l1', kind: 'text', payload: { chatId: 'c', kind: 'text', text: 'new' } })
    ob.start()
    await pump(100)
    await ob.stop()
    const blobsBefore = readdirSync(join(dir, 'blobs'))
    expect(blobsBefore.length).toBe(1)
    // 把第一条终态改老 → 重建后 prune 应删掉它（含 blob）并保留新记录。
    // 手写段用「当前秒」命名：prune 的 persistAll 全量重写同名文件，覆盖它。
    const envs = readdirSync(dir).filter((f) => /^seg-/.test(f))
    const seg = readFileSync(join(dir, envs[envs.length - 1]!), 'utf8')
    const line1 = seg.split('\n').find((l) => l.includes('k1'))!
    const old = JSON.parse(line1) as OutboxEnvelope
    old.updatedAt = Date.now() - 2 * 86_400_000
    writeFileSync(join(dir, `seg-${Math.floor(Date.now() / 1000)}.jsonl`), JSON.stringify(old) + '\n' + seg.split('\n').find((l) => l.includes('k2')))
    const ob2 = makeOutbox({ deliver })
    ob2.rebuildFromDisk()
    ob2.prune()
    expect(readdirSync(join(dir, 'blobs')).length).toBe(0)
    expect(latestSegText()).not.toContain('k1')
    expect(latestSegText()).toContain('k2')
  })

  it('blob 溢出：>24KB payload 落 blobs/，重启后能从 blob 恢复投递', async () => {
    const deliver = vi.fn().mockResolvedValue({ ok: true })
    const ob = makeOutbox({ deliver })
    const big = 'y'.repeat(30 * 1024)
    const payload = { chatId: 'c', kind: 'text' as const, text: big }
    ob.enqueue({ dedupeKey: 'big1', laneKey: 'l1', kind: 'text', payload })
    const seg = readdirSync(dir).find((f) => /^seg-\d+\.jsonl$/.test(f))!
    const segText = readFileSync(join(dir, seg), 'utf8')
    expect(segText).toContain('blobRef')
    expect(segText).not.toContain(big.slice(0, 100)) // JSONL 不存正文
    expect(readdirSync(join(dir, 'blobs')).length).toBe(1)
    // 不 start 直接“重启”：新实例 rebuild → 从 blob 恢复并投递完整 payload
    const ob2 = makeOutbox({ deliver })
    ob2.rebuildFromDisk()
    expect(ob2.pendingCount()).toBe(1)
    ob2.start()
    await pump(100)
    await ob2.stop()
    const env = deliver.mock.calls[0]![0] as OutboxEnvelope
    expect(env.payload?.text).toBe(big)
    expect(latestSegText()).toContain('"status":"done"')
  })
})
