/**
 * P2.5 /mode 多模式切换单元测试（vitest）。
 *
 * 被测功能与来源：src/commands.ts「/mode 单选卡 + cmd|mode 回调 + 切换即重置
 * 会话」（liveModeRoster/modePickerCard/switchChatMode/resetChatSession；
 * 回落链 currentModeId：chatModes 偏好 → agentPresets.defaultId → standard）
 * ——commit d616e35「feat: /mode 单选卡命令——实时 roster 枚举 + cmd|mode 回调
 * + 切换即重置会话（借鉴 lark-link）」、bb745b7「state 增加 chatModes 持久化」。
 *
 * 可测面与边界说明：
 * - 可测：roster 枚举（服务可达/缺失/抛错降级）、卡片构建（current 标注、
 *   broken 只列不点）、切换路径（saveChatMode 独占写 + epoch+1 重置 + 回执）、
 *   未知/不可用预设、cmd|mode 回调（含陈旧卡片实时校验）、currentModeId
 *   回落链（经 /mode 卡片 current 标注断言）。
 * - 不可测：index.ts ensureAgent 的「chatModes → defaultId → standard」预设
 *   应用链是 createRuntime 闭包（依赖宿主 agents/loader/sessionPersistence
 *   服务装配），无导出出口——按老板要求不重构源码，故在 mode.test.ts 只测
 *   commands.ts 侧等价回落链（currentModeId 与之一致），闭包本体留待集成验证。
 * state.js 被 mock（saveChatMode 不触碰真实 state.json）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { CommandRuntime } from '../../src/commands.js'
import { registerCommands } from '../../src/commands.js'
import { makeCommandRuntime, cardButtonKeys, cardMarkdownTexts, TEST_CHAT, type FakeRuntime } from '../helpers.js'
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

/** agentPresets 服务假件：roster 可注入，defaultId 可配。 */
function modeServices(roster: Array<Record<string, unknown>>, defaultId = 'standard'): Record<string, unknown> {
  return {
    agentPresets: {
      defaultId,
      list: vi.fn(async () => roster),
    },
  }
}

function makeRunner(services: Record<string, unknown>): void {
  rt = makeCommandRuntime({ services })
  runner = registerCommands(rt as unknown as CommandRuntime)
}

beforeEach(() => {
  vi.clearAllMocks()
  saveChatMode.mockClear()
})

describe('/mode roster 枚举与卡片', () => {
  it('no-arg（服务可达）→ 单选卡：每预设一个 cmd|mode 按钮，当前模式标注', async () => {
    makeRunner(modeServices([
      { id: 'standard', name: '标准模式', description: '默认' },
      { id: 'agent-dev', name: '开发模式', description: 'dev preset' },
    ]))
    await runner.runCommand(msg(), '/mode')
    expect(rt.cards).toHaveLength(1)
    const keys = cardButtonKeys(rt.cards[0]!.card)
    expect(keys).toEqual(['cmd|mode|standard', 'cmd|mode|agent-dev'])
    const texts = cardMarkdownTexts(rt.cards[0]!.card)
    expect(texts.some((t) => t.includes('当前模式') && t.includes('标准模式'))).toBe(true)
  })

  it('no-arg（chatModes 偏好存在）→ 当前模式显示偏好', async () => {
    makeRunner(modeServices([
      { id: 'standard', name: '标准模式' },
      { id: 'agent-dev', name: '开发模式' },
    ]))
    rt.chatModes.set(TEST_CHAT, 'agent-dev')
    await runner.runCommand(msg(), '/mode')
    const texts = cardMarkdownTexts(rt.cards[0]!.card)
    expect(texts.some((t) => t.includes('当前模式') && t.includes('开发模式'))).toBe(true)
  })

  it('服务缺失/空列表 → 安静降级：回退提示 + 内置 standard 可用', async () => {
    makeRunner(modeServices([]))
    await runner.runCommand(msg(), '/mode')
    expect(rt.replies[0]?.text).toContain('⚠️ 预设服务不可用')
    expect(rt.replies[0]?.text).toContain('standard')
    expect(rt.cards).toHaveLength(0) // 降级不发卡
  })

  it('list() 抛错 → 同样安静降级（不把异常抛给用户）', async () => {
    makeRunner({
      agentPresets: {
        defaultId: 'standard',
        list: vi.fn(async () => {
          throw new Error('presets service down')
        }),
      },
    })
    await runner.runCommand(msg(), '/mode')
    expect(rt.replies[0]?.text).toContain('⚠️ 预设服务不可用')
  })

  it('broken 预设只列不点（无按钮）', async () => {
    makeRunner(modeServices([
      { id: 'standard', name: '标准模式' },
      { id: 'agent-broken', name: '坏模式', broken: 'manifest 缺失' },
    ]))
    await runner.runCommand(msg(), '/mode')
    const keys = cardButtonKeys(rt.cards[0]!.card)
    expect(keys).toEqual(['cmd|mode|standard'])
    const texts = cardMarkdownTexts(rt.cards[0]!.card)
    expect(texts.some((t) => t.includes('坏模式') && t.includes('不可用：manifest 缺失'))).toBe(true)
  })

  it('currentModeId 回落链：无偏好无 defaultId → standard；有 defaultId → defaultId', async () => {
    // 无 defaultId（服务缺失形态）→ standard
    makeRunner({ agentPresets: { list: vi.fn(async () => []) } })
    rt.chatModes.delete(TEST_CHAT)
    await runner.runCommand(msg(), '/mode')
    expect(rt.replies[0]?.text).toContain('standard')
    // 有 defaultId（如 agent-dev）→ 卡片 current 标注 defaultId
    makeRunner(modeServices([{ id: 'agent-dev', name: '开发模式' }], 'agent-dev'))
    await runner.runCommand(msg(), '/mode')
    const texts = cardMarkdownTexts(rt.cards[0]!.card)
    expect(texts.some((t) => t.includes('当前模式') && t.includes('开发模式'))).toBe(true)
  })
})

describe('/mode 切换路径', () => {
  it('/mode <id> → saveChatMode 独占写 + 会话重置（epoch+1）+ 回执', async () => {
    makeRunner(modeServices([
      { id: 'standard', name: '标准模式' },
      { id: 'agent-dev', name: '开发模式' },
    ]))
    rt.chatEpochs.set(TEST_CHAT, 'test-2')
    rt.chatSessionOverride.set(TEST_CHAT, 'session-web-9')
    await runner.runCommand(msg(), '/mode agent-dev')
    expect(rt.chatModes.get(TEST_CHAT)).toBe('agent-dev')
    expect(saveChatMode).toHaveBeenCalledWith(TEST_CHAT, 'agent-dev')
    // 会话重置：epoch+1、清 session 覆盖、appendEpoch 持久化
    expect(rt.chatEpochs.get(TEST_CHAT)).toBe('test-3')
    expect(rt.chatSessionOverride.has(TEST_CHAT)).toBe(false)
    expect(rt.appendEpoch).toHaveBeenCalledWith(TEST_CHAT, 'test-3')
    expect(rt.replies[0]?.text).toContain('✅ 模式已切换为 开发模式')
    expect(rt.replies[0]?.text).toContain('当前会话已重置')
  })

  it('自定义预设（trust=user）→ 回执标注自定义', async () => {
    makeRunner(modeServices([{ id: 'standard', name: '标准模式' }, { id: 'my-mode', name: '我的模式', trust: 'user' }]))
    await runner.runCommand(msg(), '/mode my-mode')
    expect(rt.replies[0]?.text).toContain('（自定义）')
  })

  it('未知 id → ⚠️ 并列出可用项', async () => {
    makeRunner(modeServices([{ id: 'standard', name: '标准模式' }]))
    await runner.runCommand(msg(), '/mode nope')
    expect(rt.replies[0]?.text).toContain('⚠️ 未知模式「nope」')
    expect(rt.replies[0]?.text).toContain('standard')
    expect(saveChatMode).not.toHaveBeenCalled()
  })

  it('broken 预设 → ⚠️ 不可用，不切换', async () => {
    makeRunner(modeServices([{ id: 'standard', name: '标准模式' }, { id: 'bad', name: '坏模式', broken: '缺失' }]))
    await runner.runCommand(msg(), '/mode bad')
    expect(rt.replies[0]?.text).toContain('⚠️ 模式「坏模式」当前不可用')
    expect(saveChatMode).not.toHaveBeenCalled()
  })

  it('服务缺失时 /mode <standard> 仍可切换（内置回退）', async () => {
    makeRunner(modeServices([]))
    await runner.runCommand(msg(), '/mode standard')
    expect(rt.chatModes.get(TEST_CHAT)).toBe('standard')
    expect(saveChatMode).toHaveBeenCalledWith(TEST_CHAT, 'standard')
  })
})

describe('卡片回调 cmd|mode', () => {
  it('cmd|mode|<id> 回调 → 重读实时 roster 校验后切换', async () => {
    makeRunner(modeServices([
      { id: 'standard', name: '标准模式' },
      { id: 'agent-dev', name: '开发模式' },
    ]))
    rt.emitCardAction({ action: { value: { key: 'cmd|mode|agent-dev' } } })
    await new Promise((r) => setTimeout(r, 0))
    expect(saveChatMode).toHaveBeenCalledWith(TEST_CHAT, 'agent-dev')
    expect(rt.chatEpochs.get(TEST_CHAT)).toBe('test-1') // epoch 0 → 1
    expect(rt.replies[0]?.text).toContain('✅ 模式已切换为 开发模式')
  })

  it('卡片陈旧（预设已被删）→ ⚠️ 未知模式，不切换', async () => {
    makeRunner(modeServices([{ id: 'standard', name: '标准模式' }]))
    rt.emitCardAction({ action: { value: { key: 'cmd|mode|deleted-preset' } } })
    await new Promise((r) => setTimeout(r, 0))
    expect(rt.replies[0]?.text).toContain('⚠️ 未知模式「deleted-preset」')
    expect(saveChatMode).not.toHaveBeenCalled()
  })

  it('cmd|mode| 空 id → 忽略', async () => {
    makeRunner(modeServices([{ id: 'standard', name: '标准模式' }]))
    rt.emitCardAction({ action: { value: { key: 'cmd|mode|' } } })
    await new Promise((r) => setTimeout(r, 0))
    expect(rt.replies).toHaveLength(0)
  })
})
