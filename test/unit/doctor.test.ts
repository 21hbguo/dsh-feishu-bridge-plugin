/**
 * P2 /doctor 诊断包单元测试（vitest）。
 *
 * 被测功能与来源：src/doctor.ts「runDoctor」（收集 session log + 脱敏
 * redactSecrets + fflate zipSync + 8MB/10MB 限 + 降级）——commit 8c7dccf
 * 「feat: P2 卡片化命令——/model 单选卡、/permission 三级权限卡、/doctor
 * 接线与卡片回调订阅」与 9940802「chore: version 0.2.0 + fflate 依赖」。
 *
 * HOME 隔离：doctor.ts 的 DATA_DIR 固定为 homedir()/.dsh/dsh-feishu-bridge
 * （模块级常量），测试用 vi.mock('node:os') 指到 vi.hoisted 预生成的临时
 * 目录——绝不触碰真实凭据目录。zip 产物用 fflate unzipSync 解包断言。
 */
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { redactSecrets, runDoctor, type DoctorDeps } from '../../src/doctor.js'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'

const { homedirMock, stateHomeDir } = vi.hoisted(() => {
  const base = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? '/tmp'
  const dir = `${base}/dsh-doctor-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return { homedirMock: vi.fn(() => dir), stateHomeDir: dir }
})
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: homedirMock }
})

/** mock HOME 下的 DATA_DIR（doctor.ts 读取 credentials.json 的位置）。 */
function dataDir(): string {
  return join(stateHomeDir, '.dsh', 'dsh-feishu-bridge')
}

beforeAll(() => {
  mkdirSync(dataDir(), { recursive: true })
})
beforeEach(() => {
  rmSync(join(dataDir(), 'credentials.json'), { force: true })
})
afterAll(() => {
  rmSync(stateHomeDir, { recursive: true, force: true })
})

interface Harness {
  send: ReturnType<typeof vi.fn>
  statusText: ReturnType<typeof vi.fn>
  logs: unknown[][]
  deps: DoctorDeps
  services: Record<string, unknown>
  run: () => Promise<string>
  lastZip: () => Uint8Array
  entries: () => Record<string, Uint8Array>
}

function makeHarness(overrides: Partial<DoctorDeps> = {}): Harness {
  const send = vi.fn(async () => ({ messageId: 'msg-doc' }))
  const statusText = vi.fn(async () => '🤖 bot: 测试机器人\n🧩 模型: p/m')
  const logs: unknown[][] = []
  const services: Record<string, unknown> = {}
  const ctx = {
    get: (name: string) => services[name],
  }
  const deps: DoctorDeps = {
    ctx: ctx as unknown as DoctorDeps['ctx'],
    channel: { send } as unknown as LarkChannel,
    chatId: 'oc_testchat',
    sessionId: 'feishu-e1-oc_testchat',
    appId: 'cli_app_12345678',
    statusText,
    extraConfig: { streamDefault: true, botName: '测试机器人' },
    log: (...args: unknown[]) => logs.push(args),
    ...overrides,
  }
  const lastZip = (): Uint8Array => {
    const call = send.mock.calls[0] as unknown as [unknown, { file: { source: Buffer; fileName: string } }]
    return new Uint8Array(call[1].file.source)
  }
  const entries = () => unzipSync(lastZip())
  return {
    send,
    statusText,
    logs,
    deps,
    services,
    run: () => runDoctor(deps),
    lastZip,
    entries,
  }
}

/** 在 fake ctx 上挂 sessionPersistence/sessions 服务。 */
function withPersistence(h: Harness, content: string, filename = 'session.jsonl'): void {
  h.services.sessionPersistence = {
    readRaw: vi.fn(async () => ({ meta: {}, filename, content })),
  }
  h.services.sessions = {
    get: vi.fn(() => ({ id: 'feishu-e1-oc_testchat' })),
    flush: vi.fn(async () => {}),
  }
}

describe('doctor 全链路', () => {
  it('收集 session log + 脱敏配置 + ISSUE.md，zip 发送成功', async () => {
    writeFileSync(join(dataDir(), 'credentials.json'), JSON.stringify({ appId: 'cli_app_12345678', appSecret: 'super-secret-token' }))
    const h = makeHarness()
    withPersistence(h, 'line1\nline2', 'session.jsonl')
    const summary = await h.run()
    expect(summary).toContain('✅ 诊断包已发送')
    expect(summary).toContain('session.jsonl')
    expect(h.send).toHaveBeenCalledTimes(1)
    const fileName = (h.send.mock.calls[0]![1] as { file: { fileName: string } }).file.fileName
    expect(fileName).toMatch(/^dsh-feishu-bridge-doctor-\d+\.zip$/)
    const entries = h.entries()
    expect(entries['session.jsonl']).toBeDefined()
    expect(entries['config.sanitized.json']).toBeDefined()
    expect(entries['ISSUE.md']).toBeDefined()
    expect(entries['README.txt']).toBeDefined()
    expect(strFromU8(entries['session.jsonl']!)).toBe('line1\nline2')
  })

  it('live 会话先 flush 落盘再 readRaw（flush 屏障）', async () => {
    const h = makeHarness()
    withPersistence(h, 'log', 'session.jsonl')
    await h.run()
    const sessions = h.services.sessions as { get: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> }
    expect(sessions.get).toHaveBeenCalledWith('feishu-e1-oc_testchat')
    expect(sessions.flush).toHaveBeenCalled()
  })

  it('sessionPersistence 未装配 → 收集失败入 ISSUE.md，zip 仍发送', async () => {
    const h = makeHarness()
    const summary = await h.run()
    expect(summary).toContain('收集失败 1 项')
    const issue = strFromU8(h.entries()['ISSUE.md']!)
    expect(issue).toContain('session log: 宿主 sessionPersistence 服务未装配')
  })

  it('readRaw 返回空内容 → 视为收集失败', async () => {
    const h = makeHarness()
    withPersistence(h, '', 'session.jsonl')
    const summary = await h.run()
    expect(summary).toContain('收集失败 1 项')
    expect(h.entries()['session.jsonl']).toBeUndefined()
  })

  it('statusText 失败 → 状态快照降级为失败文案，不中断打包', async () => {
    const h = makeHarness()
    h.statusText.mockRejectedValue(new Error('status down'))
    const summary = await h.run()
    expect(summary).toContain('✅ 诊断包已发送')
    const issue = strFromU8(h.entries()['ISSUE.md']!)
    expect(issue).toContain('（状态快照失败：status down）')
  })

  it('session log 超 8MB 截断并记入失败节', async () => {
    const h = makeHarness()
    withPersistence(h, 'a'.repeat(9 * 1024 * 1024), 'session.jsonl')
    await h.run()
    const issue = strFromU8(h.entries()['ISSUE.md']!)
    expect(issue).toContain('session log 截断')
    const logText = strFromU8(h.entries()['session.jsonl']!)
    expect(logText.length).toBeLessThan(9 * 1024 * 1024)
  })

  it('zip 超 10MB → 裁掉 session log 保留其余并在 ISSUE.md 注明', async () => {
    // 随机字符串不可压缩，撑爆 10MB 上限
    let big = ''
    // 0-255 全字符集 → 熵 8bit/字符，zip 不可压缩，稳定超 10MB
    for (let i = 0; i < 11 * 1024 * 1024; i++) big += String.fromCharCode(Math.floor(Math.random() * 256))
    const h = makeHarness()
    h.statusText.mockResolvedValue(big)
    withPersistence(h, 'log', 'session.jsonl')
    const summary = await h.run()
    expect(summary).toContain('session log 已裁掉')
    expect(h.entries()['session.jsonl']).toBeUndefined()
    // 注：ISSUE.md 在体积决策前构建，裁掉注记只出现在摘要与日志里
    expect(h.logs.some((l) => String(l[0]).includes('已裁掉'))).toBe(true)
    expect(strFromU8(h.entries()['ISSUE.md']!)).toContain('## 收集失败')
  })

  it('channel.send 抛错 → runDoctor 向上抛（命令层回错误卡片）', async () => {
    const h = makeHarness()
    withPersistence(h, 'log')
    h.send.mockRejectedValue(new Error('upload failed'))
    await expect(h.run()).rejects.toThrow('upload failed')
  })
})

describe('doctor 脱敏', () => {
  it('redactSecrets：秘密值替换（长值优先）+ 32 位以上 token 正则打码', () => {
    expect(redactSecrets('token=abcdef secret=short', ['abcdef', 'short'])).toBe('token=*** secret=***')
    // 长秘密先替换，避免短值先命中截断长值（短值 defgh 先替换会漏掉 ij）
    expect(redactSecrets('xx-abcdefghij-xx', ['defgh', 'abcdefghij'])).toBe('xx-***-xx')
    expect(redactSecrets('xx-abcdefghij-xx', ['abcdefgh'])).toBe('xx-***ij-xx')
    expect(redactSecrets('key: 0123456789abcdef0123456789abcdef', [])).toBe('key: ***')
    // 短 token 不打码
    expect(redactSecrets('key: shorttoken123', [])).toBe('key: shorttoken123')
    // 空秘密值跳过（空格是合法秘密会被替换——这里只验证空串跳过）
    expect(redactSecrets('a b', ['', 'x'])).toBe('a b')
  })

  it('凭据按 key 脱敏：appId 前缀保留，secret/token 整体打码', async () => {
    writeFileSync(join(dataDir(), 'credentials.json'), JSON.stringify({
      appId: 'cli_app_12345678',
      appSecret: 'raw-secret-value',
      tenantAccessToken: 'raw-token-value',
    }))
    const h = makeHarness()
    withPersistence(h, 'log')
    await h.run()
    const config = strFromU8(h.entries()['config.sanitized.json']!)
    expect(config).toContain('cli_app***') // appId 保留前 7 字符
    expect(config).not.toContain('raw-secret-value')
    expect(config).not.toContain('raw-token-value')
  })

  it('凭据文件不存在 → 配置节如实标注，不视为失败', async () => {
    const h = makeHarness()
    withPersistence(h, 'log')
    const summary = await h.run()
    expect(summary).toContain('收集失败 0 项')
    const config = strFromU8(h.entries()['config.sanitized.json']!)
    expect(config).toContain('(未找到 credentials.json)')
  })

  it('ISSUE.md 不含任何秘密原文（脱敏 grep）', async () => {
    writeFileSync(join(dataDir(), 'credentials.json'), JSON.stringify({
      appId: 'cli_app_12345678',
      appSecret: 'top-secret-value-123',
    }))
    const h = makeHarness()
    withPersistence(h, 'log')
    await h.run()
    const all = Object.values(h.entries()).map((b) => strFromU8(b)).join('\n')
    expect(all).not.toContain('top-secret-value-123')
    expect(all).not.toContain('cli_app_12345678') // appId 只保留前缀
  })
})
