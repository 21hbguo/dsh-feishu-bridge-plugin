/**
 * P0/P2 state.json 持久化单元测试（vitest）。
 *
 * 被测功能与来源：src/state.ts「Durable per-chat state」（saveState tmp+rename
 * 原子写 0600；chatPermissionTiers/savePermissionTier 与 chatModes/saveChatMode
 * 独占写——saveState 保留磁盘最新值防陈旧视图覆盖）——commit 26c4ef5「fix:
 * state.json 原子落盘（tmp+rename+0600）」、c1c7afc「P2 基础——state 增加权限档
 * 持久化」、bb745b7「state 增加 chatModes 持久化」。
 *
 * HOME 隔离：state.ts 的 STATE_FILE 固定为 homedir()/.dsh/dsh-feishu-bridge/
 * state.json（模块级常量，非参数化）。测试用 vi.mock('node:os') 把 homedir
 * 指到 vi.hoisted 预生成的 os.tmpdir 临时目录——绝不触碰真实
 * ~/.dsh/dsh-feishu-bridge/state.json。
 */
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadState,
  saveState,
  savePermissionTier,
  saveChatMode,
  sessionIdFor,
  type BridgeState,
} from '../../src/state.js'

const { homedirMock, stateHomeDir } = vi.hoisted(() => {
  // 注意：hoisted 工厂先于所有 import 执行，只能用全局（process/Math），
  // 不能用 import 的 os.tmpdir()——按 os.tmpdir 的 POSIX 回退链取基目录。
  const base = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? '/tmp'
  const dir = `${base}/dsh-state-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return { homedirMock: vi.fn(() => dir), stateHomeDir: dir }
})
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: homedirMock }
})

/** 测试内 state.json 的绝对路径（位于 mock HOME 下）。 */
function stateFilePath(): string {
  return join(stateHomeDir, '.dsh', 'dsh-feishu-bridge', 'state.json')
}

beforeAll(() => {
  mkdirSync(join(stateHomeDir, '.dsh', 'dsh-feishu-bridge'), { recursive: true })
})
beforeEach(() => {
  rmSync(stateFilePath(), { force: true })
})
afterAll(() => {
  rmSync(stateHomeDir, { recursive: true, force: true })
})

describe('state 加载与原子落盘', () => {
  it('无文件/损坏文件 → 全字段空默认', () => {
    expect(loadState()).toEqual({
      chatEpochs: {},
      chatSessionList: {},
      chatWorkspaces: {},
      chatSessionOverride: {},
      chatEffortPrefs: {},
      chatPermissionTiers: {},
      chatModes: {},
    })
    writeFileSync(stateFilePath(), '{broken json') // 父目录已由 beforeAll 建好
    expect(loadState().chatEpochs).toEqual({})
  })

  it('saveState 全字段往返 + 文件 0600 原子写', () => {
    const full: BridgeState = {
      chatEpochs: { c1: 'e2' },
      chatSessionList: { c1: ['feishu-e1-c1'] },
      chatWorkspaces: { c1: 'w1' },
      chatSessionOverride: { c1: 'session-uuid' },
      chatEffortPrefs: { c1: 'high' },
      chatPermissionTiers: { c1: 'workspace-write' },
      chatModes: { c1: 'standard' },
    }
    // 注意：saveState 有意丢弃传入的 chatPermissionTiers/chatModes（独占写
    // 路径 savePermissionTier/saveChatMode 是它们的唯一作者）——先写权限档
    // 与模式，再 saveState 全字段，最后验证互不覆盖。
    savePermissionTier('c1', 'workspace-write')
    saveChatMode('c1', 'standard')
    saveState(full)
    const loaded = loadState()
    expect(loaded.chatEpochs.c1).toBe('e2')
    expect(loaded.chatSessionList.c1).toEqual(['feishu-e1-c1'])
    expect(loaded.chatWorkspaces.c1).toBe('w1')
    expect(loaded.chatSessionOverride.c1).toBe('session-uuid')
    expect(loaded.chatEffortPrefs.c1).toBe('high')
    expect(loaded.chatPermissionTiers.c1).toBe('workspace-write')
    expect(loaded.chatModes.c1).toBe('standard')
    expect(statSync(stateFilePath()).mode & 0o777).toBe(0o600)
    expect(readFileSync(stateFilePath(), 'utf8')).toMatch(/\n$/)
  })

  it('saveState 保留磁盘 chatPermissionTiers/chatModes 最新值（防陈旧视图覆盖）', () => {
    // 模拟 index.ts 的陈旧持久化视图：启动时装载后 /permission 又写入了新档位
    const staleView = loadState() // 空视图
    savePermissionTier('c1', 'full')
    saveChatMode('c1', 'agent-dev')
    // 用陈旧视图调 saveState —— 权限档与模式不能被回写成空
    saveState(staleView)
    const loaded = loadState()
    expect(loaded.chatPermissionTiers.c1).toBe('full')
    expect(loaded.chatModes.c1).toBe('agent-dev')
    expect(loaded.chatEpochs).toEqual({})
  })
})

describe('state 独占写路径', () => {
  it('savePermissionTier 只改一个 chat 的档位，保留其他字段', () => {
    saveState({ ...loadState(), chatEpochs: { c1: 'e1' } })
    saveChatMode('c2', 'm2')
    savePermissionTier('c1', 'read-only')
    const loaded = loadState()
    expect(loaded.chatPermissionTiers.c1).toBe('read-only')
    expect(loaded.chatEpochs.c1).toBe('e1') // 其他字段不丢
    expect(loaded.chatModes.c2).toBe('m2')
  })

  it('savePermissionTier 支持多 chat 各自档位并存', () => {
    savePermissionTier('c1', 'read-only')
    savePermissionTier('c2', 'full')
    const loaded = loadState()
    expect(loaded.chatPermissionTiers.c1).toBe('read-only')
    expect(loaded.chatPermissionTiers.c2).toBe('full')
  })

  it('saveChatMode 只改一个 chat 的模式，保留其他字段与权限档', () => {
    savePermissionTier('c1', 'full')
    saveState({ ...loadState(), chatEpochs: { c1: 'e1' } })
    saveChatMode('c1', 'agent-dev')
    saveChatMode('c2', 'standard')
    const loaded = loadState()
    expect(loaded.chatModes.c1).toBe('agent-dev')
    expect(loaded.chatModes.c2).toBe('standard')
    expect(loaded.chatPermissionTiers.c1).toBe('full')
    expect(loaded.chatEpochs.c1).toBe('e1')
  })

  it('saveChatMode 与 savePermissionTier 互不覆盖（同一 chat 双字段并存）', () => {
    saveChatMode('c1', 'agent-dev')
    savePermissionTier('c1', 'workspace-write')
    const loaded = loadState()
    expect(loaded.chatModes.c1).toBe('agent-dev')
    expect(loaded.chatPermissionTiers.c1).toBe('workspace-write')
  })
})

describe('sessionIdFor', () => {
  it('slug 清洗非法字符 + 40 字符封顶 + epoch 前缀', () => {
    expect(sessionIdFor('oc_abc-123', 'e1')).toBe('feishu-e1-oc_abc-123')
    expect(sessionIdFor('中文😀 chat!', 'e2')).toBe('feishu-e2-chat')
    const long = 'x'.repeat(60)
    expect(sessionIdFor(long, 'e3').length).toBe('feishu-e3-'.length + 40)
    expect(sessionIdFor(long, 'e3')).toBe(`feishu-e3-${'x'.repeat(40)}`)
  })
})
