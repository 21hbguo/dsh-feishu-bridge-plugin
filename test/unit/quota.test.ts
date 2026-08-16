/**
 * P1 连接配额熔断器单元测试（vitest）。
 *
 * 被测功能与来源：src/quota.ts「QuotaGovernor 连接配额熔断器」（60min 窗口
 * 12 次失败熔断、JSONL 0600 落盘、500 条上限、坏行容错、跨重启持久化）——
 * commit e0acfe9「feat: 连接配额熔断器 QuotaGovernor（60min 窗口 ≥12 次失败
 * 熔断，JSONL 0600 跨重启）」。
 *
 * 测试策略：historyFile 参数化（os.tmpdir 临时目录）；now 注入滑动窗口；
 * 跨实例重载验证持久化。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQuotaGovernor, type QuotaGovernor } from '../../src/quota.js'

function makeQuota(overrides: Partial<Parameters<typeof createQuotaGovernor>[1]> = {}): { g: QuotaGovernor; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-quota-'))
  const file = join(dir, 'conn-history.jsonl')
  const g = createQuotaGovernor(file, overrides)
  return { g, file, dir }
}

describe('quota 窗口计数与熔断', () => {
  it('recordConnect 返回窗口内失败次数；成功记录不计入', () => {
    const { g } = makeQuota()
    expect(g.recordConnect(true)).toBe(0)
    expect(g.recordConnect(false)).toBe(1)
    expect(g.recordConnect(false)).toBe(2)
    expect(g.recordConnect(true)).toBe(2) // 成功只推进窗口，不清失败计数
  })

  it('窗口内失败 ≥ limit 即熔断，remaining 归零', () => {
    const { g } = makeQuota({ limit: 3 })
    g.recordConnect(false)
    g.recordConnect(false)
    expect(g.tripped()).toBe(false)
    expect(g.remaining()).toBe(1)
    g.recordConnect(false)
    expect(g.tripped()).toBe(true)
    expect(g.remaining()).toBe(0)
  })

  it('滑动窗口：窗口外旧失败不计数，熔断随窗口滑出解除', () => {
    let now = 1_000_000
    const { g } = makeQuota({ limit: 3, now: () => now })
    g.recordConnect(false)
    g.recordConnect(false)
    g.recordConnect(false)
    expect(g.tripped()).toBe(true)
    // 窗口滑过 60min：旧失败全部出窗
    now += 61 * 60_000
    expect(g.tripped()).toBe(false)
    expect(g.remaining()).toBe(3)
  })

  it('resetAt = 窗口内最早失败 + windowMs；未熔断时 undefined', () => {
    let now = 1_000_000
    const { g } = makeQuota({ limit: 3, now: () => now })
    expect(g.resetAt()).toBeUndefined()
    g.recordConnect(false)
    g.recordConnect(false)
    g.recordConnect(false)
    expect(g.resetAt()).toBe(1_000_000 + 60 * 60_000)
  })

  it('lastAttemptAt 返回最近一次尝试时间；无记录 undefined', () => {
    let now = 5_000
    const { g } = makeQuota({ now: () => now })
    expect(g.lastAttemptAt()).toBeUndefined()
    now = 9_000
    g.recordConnect(true)
    expect(g.lastAttemptAt()).toBe(9_000)
  })

  it('reset 清空历史并落盘', () => {
    const { g, file } = makeQuota({ limit: 1 })
    g.recordConnect(false)
    expect(g.tripped()).toBe(true)
    g.reset()
    expect(g.tripped()).toBe(false)
    expect(g.lastAttemptAt()).toBeUndefined()
    expect(readFileSync(file, 'utf8').trim()).toBe('')
  })
})

describe('quota 持久化', () => {
  it('落盘 JSONL 0600；跨实例重载保留熔断状态', () => {
    const { g, file } = makeQuota({ limit: 3 })
    g.recordConnect(false)
    g.recordConnect(false)
    g.recordConnect(false)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    // 新实例从磁盘恢复：仍处于熔断（limit 需一致）
    const g2 = createQuotaGovernor(file, { limit: 3 })
    expect(g2.tripped()).toBe(true)
    expect(g2.remaining()).toBe(0)
  })

  it('500 条上限：落盘只保留最近 maxRecords 条', () => {
    let now = 0
    const { g, file } = makeQuota({ maxRecords: 500, limit: 1000, now: () => now })
    for (let i = 0; i < 600; i++) {
      now += 1000
      g.recordConnect(i % 2 === 0)
    }
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(500)
    // 内存计数用窗口裁剪，不受落盘截断影响（limit 抬高避免熔断干扰断言）
    expect(g.tripped()).toBe(false)
    expect(g.remaining()).toBeGreaterThan(0)
  })

  it('坏行/半截行跳过，其余记录加载', () => {
    const { g, file } = makeQuota({ limit: 2 })
    g.recordConnect(false)
    writeFileSync(file, '{broken\n' + readFileSync(file, 'utf8') + '{"at":1}\n')
    const g2 = createQuotaGovernor(file, { limit: 2 })
    expect(g2.tripped()).toBe(false) // 坏行被跳过，只认 1 条失败
    g2.recordConnect(false)
    expect(g2.tripped()).toBe(true)
  })

  it('跨重启窗口仍滑动：旧记录按 at 裁剪', () => {
    let now = 1_000_000
    const { g, file } = makeQuota({ limit: 3, now: () => now })
    g.recordConnect(false)
    g.recordConnect(false)
    g.recordConnect(false)
    const g2 = createQuotaGovernor(file, { limit: 3, now: () => now + 61 * 60_000 })
    expect(g2.tripped()).toBe(false)
    expect(g2.remaining()).toBe(3)
  })

  it('落盘失败（路径不可写）不阻塞内存态计数', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-quota-'))
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const g = createQuotaGovernor(join(blocker, 'conn-history.jsonl'), { limit: 2 })
    expect(g.recordConnect(false)).toBe(1)
    expect(g.recordConnect(false)).toBe(2)
    expect(g.tripped()).toBe(true)
    g.reset()
    expect(g.tripped()).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
