/**
 * P2 /permission 三级权限卡单元测试（vitest）。
 *
 * 被测功能与来源：src/commands.ts「/permission 三级权限卡 + 事件落地 + 幂等
 * 守卫 + yolo 同步」（permissionPickerCard/setPermissionTier/applyPermissionEvents/
 * onSessionCreated/currentPermissionTier；卡片回调 cmd|perm|<tier>）——commit
 * c1c7afc「P2 基础——state 增加权限档持久化（chatPermissionTiers +
 * savePermissionTier 独占写）」、8c7dccf「P2 卡片化命令——/permission 三级
 * 权限卡」。
 *
 * 可测面：卡构建与切换路径经 registerCommands 的 runCommand / cardAction
 * 回调公开面断言；state.js 被 mock（savePermissionTier 落盘与 loadState 读盘
 * 不触碰真实 state.json——真实落盘行为由 state.test.ts 覆盖）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { CommandRuntime } from '../../src/commands.js'
import { registerCommands } from '../../src/commands.js'
import { makeCommandRuntime, cardButtonKeys, TEST_CHAT, type FakeRuntime } from '../helpers.js'
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'

const { loadState, saveChatMode, savePermissionTier } = vi.hoisted(() => ({
  loadState: vi.fn(() => ({ chatPermissionTiers: {}, chatModes: {} })),
  saveChatMode: vi.fn(),
  savePermissionTier: vi.fn(),
}))
vi.mock('../../src/state.js', () => ({ loadState, saveChatMode, savePermissionTier }))

let rt: FakeRuntime
let runner: ReturnType<typeof registerCommands>

const msg = (): NormalizedMessage => ({ messageId: 'm1', chatId: TEST_CHAT } as NormalizedMessage)

function services(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approval: { setPolicy: vi.fn() },
    permissionPresets: {
      set: vi.fn(),
      current: vi.fn(() => 'workspace-write'),
    },
    ...extra,
  }
}

function makeRunner(extraServices: Record<string, unknown> = {}, agentOverrides: Partial<typeof rt.agent> = {}): void {
  rt = makeCommandRuntime({ services: services(extraServices) })
  if (Object.keys(agentOverrides).length > 0) {
    Object.assign(rt.agent, agentOverrides)
  }
  runner = registerCommands(rt as unknown as CommandRuntime)
}

beforeEach(() => {
  vi.clearAllMocks()
  loadState.mockReturnValue({ chatPermissionTiers: {}, chatModes: {} })
  makeRunner()
})

describe('/permission 卡片', () => {
  it('no-arg → 三级权限卡（cmd|perm|read-only|workspace-write|full）', async () => {
    await runner.runCommand(msg(), '/permission')
    expect(rt.cards).toHaveLength(1)
    const keys = cardButtonKeys(rt.cards[0]!.card)
    expect(keys).toEqual(['cmd|perm|read-only', 'cmd|perm|workspace-write', 'cmd|perm|full'])
    // 当前档（presets.current → workspace-write）在卡片上标注
    const card = JSON.stringify(rt.cards[0]!.card)
    expect(card).toContain('（当前）')
  })

  it('未知档位 → ⚠️ 提示', async () => {
    await runner.runCommand(msg(), '/permission nonsense')
    expect(rt.replies[0]?.text).toContain('⚠️ 未知权限档')
  })

  it('danger-full-access 作为 full 的别名', async () => {
    await runner.runCommand(msg(), '/permission danger-full-access')
    expect(savePermissionTier).toHaveBeenCalledWith(TEST_CHAT, 'full')
  })
})

describe('/permission 切换路径', () => {
  it('workspace-write：approval.setPolicy ask + presets.set + yolo 关闭 + 持久化', async () => {
    await runner.runCommand(msg(), '/permission workspace-write')
    const approval = rt.ctx.services.approval as { setPolicy: ReturnType<typeof vi.fn> }
    const presets = rt.ctx.services.permissionPresets as { set: ReturnType<typeof vi.fn> }
    expect(approval.setPolicy).toHaveBeenCalledWith(rt.agent, 'ask')
    expect(presets.set).toHaveBeenCalledWith(rt.agent.session, 'workspace-write')
    expect(rt.chatYoloPrefs.get(TEST_CHAT)).toBe(false)
    expect(savePermissionTier).toHaveBeenCalledWith(TEST_CHAT, 'workspace-write')
    expect(rt.replies[0]?.text).toContain('✅ 本会话权限已设为「工作区写」')
  })

  it('full：setPolicy never + presets danger-full-access + yolo 同步开启', async () => {
    await runner.runCommand(msg(), '/permission full')
    const approval = rt.ctx.services.approval as { setPolicy: ReturnType<typeof vi.fn> }
    const presets = rt.ctx.services.permissionPresets as { set: ReturnType<typeof vi.fn> }
    expect(approval.setPolicy).toHaveBeenCalledWith(rt.agent, 'never')
    expect(presets.set).toHaveBeenCalledWith(rt.agent.session, 'danger-full-access')
    expect(rt.chatYoloPrefs.get(TEST_CHAT)).toBe(true)
    expect(savePermissionTier).toHaveBeenCalledWith(TEST_CHAT, 'full')
  })

  it('read-only：无预设时事件落地（sandbox/mode + approval/policy）', async () => {
    const append = vi.fn()
    rt.agent.session = { id: 'feishu-test-0-oc_testchat', events: [], append } as never
    const presets = rt.ctx.services.permissionPresets as { set: ReturnType<typeof vi.fn> }
    presets.set.mockImplementation(() => {
      throw new Error('no read-only preset configured')
    })
    await runner.runCommand(msg(), '/permission read-only')
    expect(append).toHaveBeenCalledWith('sandbox/mode', { mode: 'read-only' })
    expect(append).toHaveBeenCalledWith('approval/policy', { policy: 'ask' })
    expect(savePermissionTier).toHaveBeenCalledWith(TEST_CHAT, 'read-only')
  })

  it('read-only 幂等守卫：已落地的事件不重复追加', async () => {
    const append = vi.fn()
    rt.agent.session = {
      id: 'feishu-test-0-oc_testchat',
      events: [
        { type: 'sandbox/mode', data: { mode: 'read-only' } },
        { type: 'approval/policy', data: { policy: 'ask' } },
      ],
      append,
    } as never
    const presets = rt.ctx.services.permissionPresets as { set: ReturnType<typeof vi.fn> }
    presets.set.mockImplementation(() => {
      throw new Error('no read-only preset configured')
    })
    await runner.runCommand(msg(), '/permission read-only')
    expect(append).not.toHaveBeenCalled()
  })

  it('会话未激活（无 agent）→ ⚠️', async () => {
    rt = makeCommandRuntime({ services: services(), agent: null })
    runner = registerCommands(rt as unknown as CommandRuntime)
    await runner.runCommand(msg(), '/permission full')
    expect(rt.replies[0]?.text).toContain('⚠️ 会话尚未激活')
  })

  it('审批服务未装配 → ⚠️ 不可用', async () => {
    makeRunner({ approval: undefined })
    await runner.runCommand(msg(), '/permission full')
    expect(rt.replies[0]?.text).toContain('⚠️ 审批服务不可用')
  })

  it('非 read-only 但 presets 未装配 → ⚠️ 不可用', async () => {
    makeRunner({ permissionPresets: undefined })
    await runner.runCommand(msg(), '/permission full')
    expect(rt.replies[0]?.text).toContain('⚠️ 权限预设服务不可用')
  })
})

describe('卡片回调 cmd|perm 与会话恢复', () => {
  it('cmd|perm|full 回调 → 与命令同路径（setPolicy/save/yolo）', async () => {
    rt.emitCardAction({ action: { value: { key: 'cmd|perm|full' } } })
    await new Promise((r) => setTimeout(r, 0))
    const approval = rt.ctx.services.approval as { setPolicy: ReturnType<typeof vi.fn> }
    expect(approval.setPolicy).toHaveBeenCalledWith(rt.agent, 'never')
    expect(savePermissionTier).toHaveBeenCalledWith(TEST_CHAT, 'full')
    expect(rt.replies[0]?.text).toContain('✅ 本会话权限已设为「全放行」')
  })

  it('cmd|perm|未知档回调 → 忽略（不回复）', async () => {
    rt.emitCardAction({ action: { value: { key: 'cmd|perm|root' } } })
    await new Promise((r) => setTimeout(r, 0))
    expect(rt.replies).toHaveLength(0)
  })

  it('session/created（feishu 会话）→ 恢复持久化档位到新会话事件', () => {
    loadState.mockReturnValue({
      chatPermissionTiers: { [TEST_CHAT]: 'full' },
      chatModes: {},
    })
    // 新会话 = epoch+1 后创建：先同步 runtime 的当前 epoch
    rt.chatEpochs.set(TEST_CHAT, 'test-1')
    const append = vi.fn()
    const newSession = { id: 'feishu-test-1-oc_testchat', events: [], append }
    rt.ctx.emitSessionCreated(newSession)
    const presets = rt.ctx.services.permissionPresets as { set: ReturnType<typeof vi.fn> }
    expect(presets.set).toHaveBeenCalledWith(newSession, 'danger-full-access')
  })

  it('session/created（非 feishu 会话）→ 跳过', () => {
    loadState.mockReturnValue({
      chatPermissionTiers: { [TEST_CHAT]: 'full' },
      chatModes: {},
    })
    rt.ctx.emitSessionCreated({ id: 'session-web-1', events: [] })
    const presets = rt.ctx.services.permissionPresets as { set: ReturnType<typeof vi.fn> }
    expect(presets.set).not.toHaveBeenCalled()
  })
})
