/**
 * P0 WAL 入站补发单元测试（vitest）。
 *
 * 被测功能与来源：src/wal.ts「入站 WAL」（accept/delivered/pendingReplays/
 * markReplay/prune/pendingCount、text 截断 8000、2 次/30min 补发上限、seg
 * 文件原子落盘与陈旧段清理）——commit a985f7d「feat: 入站 WAL（accept/
 * delivered/补发对账/次数与窗口上限/截断），借鉴 lark-link」。
 *
 * 测试策略：目录参数化（os.tmpdir 临时目录）；now 注入控制窗口；跨实例
 * 重载验证磁盘持久化。
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWal, type InboundWal, type WalRecord } from '../../src/wal.js'

function makeWal(overrides: Partial<Parameters<typeof createWal>[0]> = {}): { wal: InboundWal; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wal-'))
  const wal = createWal({ dir, ...overrides })
  return { wal, dir }
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

describe('wal accept 与持久化', () => {
  it('accept 落盘并返回完整记录；新实例从磁盘重载', () => {
    const { wal, dir } = makeWal()
    const rec = wal.accept({ messageId: 'm1', chatKey: 'c1', text: 'hello' })
    expect(rec).toMatchObject({ messageId: 'm1', chatKey: 'c1', text: 'hello', attempts: 0, state: 'accepted' })
    expect(wal.pendingCount()).toBe(1)
    // seg 文件 0600 原子落盘
    const segs = readdirSync(dir).filter((f) => /^seg-.*\.jsonl$/.test(f))
    expect(segs.length).toBe(1)
    expect(statSync(join(dir, segs[0]!)).mode & 0o777).toBe(0o600)
    // 新实例重载
    const wal2 = createWal({ dir })
    expect(wal2.pendingCount()).toBe(1)
    expect(wal2.pendingReplays()[0]?.messageId).toBe('m1')
    cleanup(dir)
  })

  it('text 截断 8000 字符', () => {
    const { wal, dir } = makeWal()
    const rec = wal.accept({ messageId: 'm1', chatKey: 'c1', text: 'x'.repeat(10_000) })
    expect(rec.text.length).toBe(8000)
    cleanup(dir)
  })

  it('损坏段行跳过，其余记录正常加载', () => {
    const { wal, dir } = makeWal()
    wal.accept({ messageId: 'm1', chatKey: 'c1', text: 'a' })
    writeFileSync(join(dir, 'seg-corrupt.jsonl'), '{bad json\n')
    const wal2 = createWal({ dir })
    expect(wal2.pendingCount()).toBe(1)
    cleanup(dir)
  })
})

describe('wal delivered / markReplay / pendingReplays', () => {
  it('delivered 后 pendingReplays 排除且 markReplay 拒绝', () => {
    const { wal, dir } = makeWal()
    wal.accept({ messageId: 'm1', chatKey: 'c1', text: 'a' })
    wal.delivered('m1')
    expect(wal.pendingReplays()).toEqual([])
    expect(wal.markReplay('m1')).toBe(false)
    cleanup(dir)
  })

  it('markReplay 递增次数并置 replayed；2 次上限后拒绝', () => {
    const { wal, dir } = makeWal({ maxReplayAttempts: 2 })
    wal.accept({ messageId: 'm1', chatKey: 'c1', text: 'a' })
    expect(wal.markReplay('m1')).toBe(true)
    expect(wal.markReplay('m1')).toBe(true)
    expect(wal.markReplay('m1')).toBe(false)
    cleanup(dir)
  })

  it('窗口外（>30min）的 accepted 记录不可补发、不进入 pendingReplays', () => {
    const now = Date.now()
    const { wal, dir } = makeWal({ now: () => now })
    wal.accept({ messageId: 'm1', chatKey: 'c1', text: 'a' })
    expect(wal.pendingReplays()).toHaveLength(1)
    const late = now + 31 * 60_000
    const wal2 = createWal({ dir, now: () => late })
    expect(wal2.pendingReplays()).toHaveLength(0)
    expect(wal2.markReplay('m1')).toBe(false)
    cleanup(dir)
  })

  it('pendingReplays 旧的在前，已 delivered / 次数耗尽 / 窗口外排除', () => {
    const now = Date.now()
    const times = [now, now + 1000, now + 2000]
    let i = 0
    const { wal, dir } = makeWal({ now: () => times[Math.min(i, times.length - 1)]! })
    wal.accept({ messageId: 'm3', chatKey: 'c', text: 'c' })
    i = 1
    wal.accept({ messageId: 'm2', chatKey: 'c', text: 'b' })
    i = 2
    wal.accept({ messageId: 'm1', chatKey: 'c', text: 'a' })
    // m2 已投递；m1 已补发一次（仍在窗口内）—— m1/m3 应出现在列表，m2 不出现
    wal.delivered('m2')
    expect(wal.markReplay('m1')).toBe(true)
    const ids = wal.pendingReplays().map((r) => r.messageId)
    expect(ids).toEqual(['m3', 'm1']) // 旧的在前
    cleanup(dir)
  })

  it('未知 messageId 的 markReplay/delivered 静默无操作', () => {
    const { wal, dir } = makeWal()
    wal.accept({ messageId: 'm1', chatKey: 'c1', text: 'a' })
    expect(wal.markReplay('nope')).toBe(false)
    expect(wal.delivered('nope')).toBeUndefined()
    expect(wal.pendingCount()).toBe(1)
    cleanup(dir)
  })
})

describe('wal prune 与磁盘清理', () => {
  it('prune：delivered 超窗口老化删除；窗口内保留', () => {
    const now = Date.now()
    const { wal, dir } = makeWal({ now: () => now })
    wal.accept({ messageId: 'old', chatKey: 'c1', text: 'a' })
    wal.delivered('old')
    wal.accept({ messageId: 'fresh', chatKey: 'c1', text: 'b' })
    const wal2 = createWal({ dir, now: () => now + 31 * 60_000 })
    wal2.prune()
    expect(wal2.pendingCount()).toBe(1) // fresh 仍在（未投递 + 次数未耗尽）
    cleanup(dir)
  })

  it('prune：从未投递且超窗口且次数耗尽的记录删除', () => {
    const now = Date.now()
    const { wal, dir } = makeWal({ now: () => now })
    wal.accept({ messageId: 'm1', chatKey: 'c1', text: 'a' })
    wal.markReplay('m1')
    wal.markReplay('m1')
    const wal2 = createWal({ dir, now: () => now + 31 * 60_000 })
    wal2.prune()
    expect(wal2.pendingCount()).toBe(0)
    cleanup(dir)
  })

  it('prune 清理陈旧 seg 文件（>1h 的冗余快照），保留新段', () => {
    const { wal, dir } = makeWal()
    wal.accept({ messageId: 'm1', chatKey: 'c1', text: 'a' })
    const oldTs = Date.now() - 2 * 60 * 60_000
    writeFileSync(join(dir, `seg-${oldTs}.jsonl`), 'stale\n')
    wal.prune()
    const segs = readdirSync(dir).filter((f) => /^seg-.*\.jsonl$/.test(f))
    expect(segs).toHaveLength(1) // 只有最新段
    expect(segs[0]).not.toContain(String(oldTs))
    cleanup(dir)
  })

  it('delivered 状态跨实例持久化（重载后不再补发）', () => {
    const { wal, dir } = makeWal()
    wal.accept({ messageId: 'm1', chatKey: 'c1', text: 'a' })
    wal.delivered('m1')
    const wal2 = createWal({ dir })
    expect(wal2.pendingReplays()).toEqual([])
    expect(wal2.markReplay('m1')).toBe(false)
    cleanup(dir)
  })

  it('replayed 状态跨实例持久化（attempts 保留）', () => {
    const { wal, dir } = makeWal()
    wal.accept({ messageId: 'm1', chatKey: 'c1', text: 'a' })
    wal.markReplay('m1')
    const wal2 = createWal({ dir })
    const rec = wal2.pendingReplays()[0] as WalRecord | undefined
    expect(rec?.attempts).toBe(1)
    expect(wal2.markReplay('m1')).toBe(true) // 第二次补发仍允许
    cleanup(dir)
  })
})
