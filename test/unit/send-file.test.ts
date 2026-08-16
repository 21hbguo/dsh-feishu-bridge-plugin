/**
 * P2 出站文件工具 lark_send_local_file 单元测试（vitest）。
 *
 * 被测功能与来源：src/send-file.ts「registerSendFileTool」（会话反查 + realpath
 * 白名单防穿越 + 20MB 上限 + 扩展名白名单 + 图片/文件分流）——commit
 * 1425087「feat: P2 入站多媒体（图片→ImageBlock/文件→文本提取）与出站文件
 * 工具 lark_send_local_file，借鉴 lark-link」。
 *
 * 测试策略：tools.register 捕获工具定义后直接调 execute；真实文件放在
 * os.tmpdir 临时目录（含工作区/数据目录/越界目录三种位置）；channel.send 假。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FILE_BYTES, registerSendFileTool, type SendFileToolDeps } from '../../src/send-file.js'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** 已创建的临时根目录（afterEach 清理）。 */
const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sendfile-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Harness {
  send: ReturnType<typeof vi.fn>
  logs: unknown[][]
  tool: ToolDefinition
  deps: SendFileToolDeps
  dataDir: string
  workspaceDir: string
  outsideDir: string
  run: (args: { path: string }, agentId?: string) => Promise<string>
  emitSignal: (aborted?: boolean) => { aborted: boolean }
}

function makeHarness(overrides: Partial<SendFileToolDeps> = {}): Harness {
  const root = makeRoot()
  const dataDir = join(root, 'data')
  const workspaceDir = join(root, 'workspace')
  const outsideDir = join(root, 'outside')
  for (const d of [dataDir, workspaceDir, outsideDir]) mkdirSync(d, { recursive: true })
  const send = vi.fn(async () => ({ messageId: 'msg-9' }))
  const logs: unknown[][] = []
  let registered: ToolDefinition | undefined
  const tools = {
    register: vi.fn((def: ToolDefinition) => {
      registered = def
      return () => {}
    }),
  }
  const deps: SendFileToolDeps = {
    tools,
    channel: { send } as unknown as LarkChannel,
    chatIdForSession: (sessionId) => (sessionId === 'session-1' ? 'oc_target' : undefined),
    workspacePathFor: (chatId) => (chatId === 'oc_target' ? workspaceDir : undefined),
    dataDir,
    log: (...args: unknown[]) => logs.push(args),
    ...overrides,
  }
  registerSendFileTool(deps) // 注册一次，捕获工具定义
  const tool = registered!
  /** execute 的 exec 参数（SessionId/AbortSignal 品牌类型收口）。 */
  type ExecArg = Parameters<NonNullable<ToolDefinition['execute']>>[1]
  const run = async (args: { path: string }, agentId = 'session-1') =>
    (await tool.execute!(args, { agent: { id: agentId }, signal: { aborted: false } } as unknown as ExecArg)) as string
  return {
    send,
    logs,
    tool,
    deps,
    dataDir,
    workspaceDir,
    outsideDir,
    run,
    emitSignal: (aborted = false) => ({ aborted }),
  }
}

describe('send-file 注册与成功路径', () => {
  it('注册成功：工具名 lark_send_local_file，返回注销函数', () => {
    const h = makeHarness()
    expect(h.tool.name).toBe('lark_send_local_file')
    expect(h.tool.description).toContain('≤20MB')
    const unregister = registerSendFileTool(h.deps)
    expect(typeof unregister).toBe('function')
  })

  it('tools 服务未装配 → 返回 undefined 并告警', () => {
    const h = makeHarness()
    const unregister = registerSendFileTool({ ...h.deps, tools: undefined })
    expect(unregister).toBeUndefined()
    expect(h.logs.some((l) => String(l[0]).includes('tools service unavailable'))).toBe(true)
  })

  it('成功：工作区内文本文件按 file 消息发送，含消息 id', async () => {
    const h = makeHarness()
    const file = join(h.workspaceDir, 'note.md')
    writeFileSync(file, '# hi')
    const out = await h.run({ path: file })
    expect(out).toContain('✅ 已发送到飞书')
    expect(out).toContain('msg-9')
    expect(h.send).toHaveBeenCalledWith('oc_target', expect.objectContaining({ file: expect.objectContaining({ fileName: 'note.md' }) }))
  })

  it('成功：png 图片按 image 消息发送', async () => {
    const h = makeHarness()
    const file = join(h.workspaceDir, 'pic.png')
    writeFileSync(file, 'x')
    const out = await h.run({ path: file })
    expect(out).toContain('✅ 已发送到飞书')
    expect(h.send).toHaveBeenCalledWith('oc_target', expect.objectContaining({ image: expect.anything() }))
  })

  it('成功：数据目录内文件可发送（白名单含插件数据目录）', async () => {
    const h = makeHarness()
    const file = join(h.dataDir, 'export.csv')
    writeFileSync(file, 'a,b')
    const out = await h.run({ path: file })
    expect(out).toContain('✅ 已发送到飞书')
  })

  it('相对路径基于工作区解析后发送', async () => {
    const h = makeHarness()
    writeFileSync(join(h.workspaceDir, 'rel.txt'), 'x')
    const out = await h.run({ path: 'rel.txt' })
    expect(out).toContain('✅ 已发送到飞书')
  })

  it('allowedExtensions 覆盖可放行自定义扩展名', async () => {
    const h = makeHarness({ allowedExtensions: ['xyz'] })
    const file = join(h.workspaceDir, 'custom.xyz')
    writeFileSync(file, 'x')
    const out = await h.run({ path: file })
    expect(out).toContain('✅ 已发送到飞书')
  })
})

describe('send-file 拒绝路径', () => {
  it('无会话（session 反查失败）→ 拒绝', async () => {
    const h = makeHarness()
    const file = join(h.workspaceDir, 'a.txt')
    writeFileSync(file, 'x')
    const out = await h.run({ path: file }, 'session-unknown')
    expect(out).toContain('❌ 无法定位当前飞书会话')
  })

  it('空 path → 拒绝', async () => {
    const h = makeHarness()
    expect(await h.run({ path: '   ' })).toContain('❌ 参数 path 不能为空')
  })

  it('相对路径但无工作区绑定 → 拒绝', async () => {
    const h = makeHarness({ workspacePathFor: () => undefined })
    expect(await h.run({ path: 'rel.txt' })).toContain('❌ 相对路径需要工作区绑定')
  })

  it('文件不存在 → 拒绝', async () => {
    const h = makeHarness()
    expect(await h.run({ path: join(h.workspaceDir, 'missing.txt') })).toContain('❌ 文件不存在')
  })

  it('目录穿越（..）折叠后逃出白名单 → 拒绝', async () => {
    const h = makeHarness()
    writeFileSync(join(h.outsideDir, 'secret.txt'), 's') // 先造出越界文件
    const out = await h.run({ path: join(h.workspaceDir, '..', 'outside', 'secret.txt') })
    expect(out).toContain('❌ 拒绝：路径不在允许目录内')
  })

  it('符号链接指向白名单外 → realpath 折叠后拒绝', async () => {
    const h = makeHarness()
    const secret = join(h.outsideDir, 'secret.txt')
    writeFileSync(secret, 's')
    const link = join(h.workspaceDir, 'link.txt')
    symlinkSync(secret, link)
    const out = await h.run({ path: link })
    expect(out).toContain('❌ 拒绝：路径不在允许目录内')
  })

  it('目录（非普通文件）→ 拒绝', async () => {
    const h = makeHarness()
    const out = await h.run({ path: h.workspaceDir })
    expect(out).toContain('❌ 拒绝：不是普通文件')
  })

  it('超过 20MB → 拒绝（发送前拦截）', async () => {
    const h = makeHarness()
    const big = join(h.workspaceDir, 'big.bin')
    writeFileSync(big, 'x')
    truncateSync(big, MAX_FILE_BYTES + 1)
    const out = await h.run({ path: big })
    expect(out).toContain('❌ 拒绝：文件超过 20MB 上限')
    expect(h.send).not.toHaveBeenCalled()
  })

  it('扩展名不在白名单 → 拒绝', async () => {
    const h = makeHarness()
    const exe = join(h.workspaceDir, 'evil.exe')
    writeFileSync(exe, 'x')
    const out = await h.run({ path: exe })
    expect(out).toContain('❌ 拒绝：扩展名「exe」不在白名单')
  })

  it('无扩展名 → 拒绝（白名单含扩展名匹配）', async () => {
    const h = makeHarness()
    const noext = join(h.workspaceDir, 'noext')
    writeFileSync(noext, 'x')
    expect(await h.run({ path: noext })).toContain('扩展名「noext」不在白名单')
  })

  it('signal 已中止 → 拒绝发送', async () => {
    const h = makeHarness()
    const file = join(h.workspaceDir, 'a.txt')
    writeFileSync(file, 'x')
    type ExecArg = Parameters<NonNullable<ToolDefinition['execute']>>[1]
    const out = (await h.tool.execute!(
      { path: file },
      { agent: { id: 'session-1' }, signal: { aborted: true } } as unknown as ExecArg,
    )) as string
    expect(out).toContain('❌ 已取消')
    expect(h.send).not.toHaveBeenCalled()
  })

  it('channel.send 抛错 → 发送失败提示', async () => {
    const h = makeHarness()
    h.send.mockRejectedValue(new Error('upload 400'))
    const file = join(h.workspaceDir, 'a.txt')
    writeFileSync(file, 'x')
    const out = await h.run({ path: file })
    expect(out).toContain('❌ 发送失败')
  })
})
