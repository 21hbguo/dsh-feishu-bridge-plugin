/**
 * P1 命令三级分流与注入点单元测试（vitest）。
 *
 * 被测功能与来源：src/commands.ts「registerCommands + 模块级注入点」
 * （Tier1 桥命令表 / Tier2 setCommandsHost 宿主命令原生执行 / Tier3
 * setAgentFallback 注入；setStatusExtra /status 附加行；/reset epoch+1
 * 重置；/model 单选卡与列表；/stream /cancel 等）——commit 1dca6d3「feat:
 * 命令三级分流——Tier2 宿主注册命令原生执行 + Tier3 注入钩子」、c898ead
 * 「feat: commands 新增 setStatusExtra 注入点」、d6f01b6「P1 四接线点」。
 *
 * 可测面：注入点（setCommandsHost/setAgentFallback/setStatusExtra）为模块级
 * 变量、可完整测试；registerCommands 返回的 runCommand 是唯一命令入口，
 * 三级分流全部经它断言。state.js 被 mock（避免触碰真实 state.json）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { BridgeCommandExecution, BridgeCommandsHost, CommandRuntime } from '../../src/commands.js'
import { registerCommands, setCommandsHost, setAgentFallback, setStatusExtra } from '../../src/commands.js'
import { makeCommandRuntime, TEST_CHAT, type FakeRuntime } from '../helpers.js'
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'

const { loadState, saveChatMode, savePermissionTier } = vi.hoisted(() => ({
  loadState: vi.fn(() => ({ chatPermissionTiers: {}, chatModes: {} })),
  saveChatMode: vi.fn(),
  savePermissionTier: vi.fn(),
}))
vi.mock('../../src/state.js', () => ({ loadState, saveChatMode, savePermissionTier }))

let rt: FakeRuntime
let runner: ReturnType<typeof registerCommands>

const msg = (chatId = TEST_CHAT): NormalizedMessage => ({ messageId: 'm1', chatId } as NormalizedMessage)

function run(text: string, chatId = TEST_CHAT): Promise<void> {
  return runner.runCommand(msg(chatId), text)
}

beforeEach(() => {
  vi.clearAllMocks()
  setCommandsHost(undefined)
  setAgentFallback(undefined)
  setStatusExtra(undefined)
  rt = makeCommandRuntime()
  runner = registerCommands(rt as unknown as CommandRuntime)
})

describe('Tier1 桥命令表', () => {
  it('/ping → pong', async () => {
    await run('/ping')
    expect(rt.replies[0]?.text).toBe('pong 🏓')
  })

  it('/help 列出全部命令且大小写不敏感（/PING 也命中）', async () => {
    await run('/help')
    expect(rt.replies[0]?.text).toContain('/ping')
    await run('/PING')
    expect(rt.replies[1]?.text).toBe('pong 🏓')
  })

  it('/reset → epoch+1、清 session 覆盖、appendEpoch 持久化', async () => {
    rt.chatEpochs.set(TEST_CHAT, 'test-3')
    rt.chatSessionOverride.set(TEST_CHAT, 'session-web-1')
    await run('/reset')
    expect(rt.chatEpochs.get(TEST_CHAT)).toBe('test-4')
    expect(rt.chatSessionOverride.has(TEST_CHAT)).toBe(false)
    expect(rt.appendEpoch).toHaveBeenCalledWith(TEST_CHAT, 'test-4')
    expect(rt.replies[0]?.text).toContain('✅ 已重置本会话记忆')
  })

  it('/new 与 /reset 同路径', async () => {
    rt.chatEpochs.set(TEST_CHAT, 'test-1')
    await run('/new')
    expect(rt.chatEpochs.get(TEST_CHAT)).toBe('test-2')
  })

  it('/stream on|off 设置偏好，其他参数回显当前值', async () => {
    await run('/stream on')
    expect(rt.chatStreamPrefs.get(TEST_CHAT)).toBe(true)
    await run('/stream off')
    expect(rt.chatStreamPrefs.get(TEST_CHAT)).toBe(false)
    await run('/stream')
    expect(rt.replies[2]?.text).toContain('off')
  })

  it('/cancel 无运行中回合 → 提示', async () => {
    await run('/cancel')
    expect(rt.replies[0]?.text).toBe('当前没有运行中的回合。')
  })

  it('命令 handler 抛错 → 回错误卡片不崩溃', async () => {
    rt.modelLabel = vi.fn(async () => {
      throw new Error('boom')
    })
    await run('/status') // renderStatus 依赖 modelLabel
    expect(rt.replies[0]?.text).toContain('⚠️ 命令执行失败')
    expect(rt.log).toHaveBeenCalledWith(expect.stringContaining('command /status failed'), expect.anything())
  })

  it('未知命令（未接线 Tier3）→ 传统未知命令回复', async () => {
    await run('/nope')
    expect(rt.replies[0]?.text).toContain('未知命令 /nope')
  })
})

describe('Tier2 宿主命令（setCommandsHost）', () => {
  function makeHost(overrides: Partial<BridgeCommandsHost> = {}): BridgeCommandsHost {
    return {
      find: vi.fn((_agent, name) => (name === 'goal' ? { name: 'goal' } : undefined)),
      execute: vi.fn(async (): Promise<BridgeCommandExecution> => ({ commandId: 'c1', result: { kind: 'success', text: '🎯 goal done' } })),
      ...overrides,
    }
  }

  it('宿主命令命中 → 原生执行并回文本', async () => {
    const host = makeHost()
    setCommandsHost(host)
    await run('/goal 完成测试')
    expect(host.find).toHaveBeenCalled()
    expect(host.execute).toHaveBeenCalledWith(expect.anything(), '/goal 完成测试', expect.anything())
    expect(rt.replies[0]?.text).toBe('🎯 goal done')
  })

  it('宿主 execute 返回 error → ⚠️ 回执', async () => {
    setCommandsHost(makeHost({
      execute: vi.fn(async (): Promise<BridgeCommandExecution> => ({ commandId: 'c1', result: { kind: 'error', text: '参数错误' } })),
    }))
    await run('/goal x')
    expect(rt.replies[0]?.text).toBe('⚠️ 参数错误')
  })

  it('宿主 find 未命中 → 落 Tier3（注入）/ 未知命令', async () => {
    setCommandsHost(makeHost())
    await run('/unknown-cmd')
    expect(rt.replies[0]?.text).toContain('未知命令 /unknown-cmd')
  })

  it('宿主 execute 抛错 → 落 Tier3，不卡聊天', async () => {
    const host = makeHost({ execute: vi.fn(async () => { throw new Error('host down') }) })
    setCommandsHost(host)
    await run('/goal x')
    expect(rt.replies[0]?.text).toContain('未知命令')
    expect(rt.log).toHaveBeenCalledWith(expect.stringContaining('host command /goal failed'), expect.anything())
  })

  it('宿主 execute 返回 undefined（语法未命中）→ 落 Tier3', async () => {
    setCommandsHost(makeHost({ execute: vi.fn(async () => undefined) }))
    await run('/goal x')
    expect(rt.replies[0]?.text).toContain('未知命令')
  })
})

describe('Tier3 注入（setAgentFallback）', () => {
  it('未命中命令转发给 agent 注入（原文透传）', async () => {
    const fallback = vi.fn(async (_msg: NormalizedMessage, _text: string) => {})
    setAgentFallback(fallback)
    await run('/magic 内容')
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(fallback.mock.calls[0]![1]).toBe('/magic 内容')
    expect(rt.replies).toHaveLength(0) // 注入接管，不再回未知命令
  })

  it('已知命令不经过 Tier3', async () => {
    const fallback = vi.fn(async () => {})
    setAgentFallback(fallback)
    await run('/ping')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('setAgentFallback(undefined) 恢复未知命令回复', async () => {
    const fallback = vi.fn(async () => {})
    setAgentFallback(fallback)
    setAgentFallback(undefined)
    await run('/magic')
    expect(fallback).not.toHaveBeenCalled()
    expect(rt.replies[0]?.text).toContain('未知命令 /magic')
  })
})

describe('/status 与 setStatusExtra', () => {
  it('/status 基础行齐全（bot/模型/会话/工作区/流式/队列/运行时长）', async () => {
    await run('/status')
    const text = rt.replies[0]?.text ?? ''
    expect(text).toContain('🤖 bot: 测试机器人')
    expect(text).toContain('🧩 模型:')
    expect(text).toContain('💬 会话: feishu-')
    expect(text).toContain('📁 工作区:')
    expect(text).toContain('🔄 流式: on')
    expect(text).toContain('⏳ 队列深度: 0')
    expect(text).toContain('🕐 运行时长')
  })

  it('setStatusExtra 注入的附加行显示；undefined/空串不显示', async () => {
    setStatusExtra(() => '🔌 配额熔断：未触发')
    await run('/status')
    expect(rt.replies[0]?.text).toContain('🔌 配额熔断：未触发')
    setStatusExtra(() => undefined)
    await run('/status')
    expect(rt.replies[1]?.text).not.toContain('配额熔断')
    setStatusExtra(() => '')
    await run('/status')
    expect(rt.replies[2]?.text).not.toContain('配额熔断')
  })
})

describe('/model 命令', () => {
  function withLlm() {
    const llm = {
      listProviders: vi.fn(() => [{ id: 'p1', name: '供应商一' }]),
      listModels: vi.fn(async () => [{ id: 'm1', name: '模型甲' }, { id: 'm2', name: '' }]),
    }
    const rt2 = makeCommandRuntime({ services: { llm } })
    const runner2 = registerCommands(rt2 as unknown as CommandRuntime)
    return { rt2, runner2, llm }
  }

  it('no-arg → 单选卡（cmd|model|provider|model 按钮，当前模型标注）', async () => {
    const { rt2, runner2 } = withLlm()
    await runner2.runCommand(msg(), '/model')
    expect(rt2.cards).toHaveLength(1)
    const keys = (rt2.cards[0]!.card as { body: { elements: Array<{ behaviors: Array<{ value: { key: string } }> }> } }).body.elements
      .flatMap((e) => e.behaviors ?? [])
      .map((b) => b.value.key)
    expect(keys).toEqual(['cmd|model|p1|m1', 'cmd|model|p1|m2'])
  })

  it('/model list → 文本列表', async () => {
    const { rt2, runner2 } = withLlm()
    await runner2.runCommand(msg(), '/model list')
    expect(rt2.replies[0]?.text).toContain('1. m1（供应商一）')
    expect(rt2.replies[0]?.text).toContain('2. m2（供应商一）')
  })

  it('/model <序号> → 写偏好并应用到 live agent', async () => {
    const { rt2, runner2 } = withLlm()
    await runner2.runCommand(msg(), '/model 2')
    expect(rt2.chatModelPrefs.get(TEST_CHAT)).toEqual({ provider: 'p1', model: 'm2' })
    expect(rt2.agent.options).toMatchObject({ provider: 'p1', model: 'm2' })
    expect(rt2.replies[0]?.text).toContain('✅ 已切换模型：m2')
  })

  it('llm 服务缺失 → 提示不可用', async () => {
    await run('/model')
    expect(rt.replies[0]?.text).toContain('⚠️ 模型服务不可用')
  })
})

describe('dispose', () => {
  it('dispose 摘除 cardAction 与 session/created 监听', async () => {
    expect(rt.ctx.sessionCreatedHandlers.length).toBe(1)
    runner.dispose()
    expect(rt.ctx.sessionCreatedHandlers.length).toBe(0)
    // cardAction 回调摘除后再触发不影响
    rt.emitCardAction({ action: { value: { key: 'cmd|mode|standard' } } })
    await Promise.resolve()
    expect(rt.replies).toHaveLength(0)
  })
})
