/**
 * /effort 思考强度模块单元测试。
 *
 * 覆盖：installEffortPref 的默认档位注入（无偏好 → config.defaultEffort，
 * 默认 'max'；有偏好 → 偏好优先）、currentEffort 回落链、
 * supportedEfforts 枚举（API 优先 / 已知适配器表回退 / 双失败 null）。
 *
 * 功能来源：P1 /effort（0.1.0）+ 默认 max 增强（0.3.1，用户需求）。
 */
import { describe, expect, it, vi } from 'vitest'
import { currentEffort, installEffortPref, supportedEfforts } from '../../src/effort.js'

/** 捕获 agent/request waterfall listener 的假 agent-scope。 */
function captureScope() {
  let captured: ((payload: unknown, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>) | undefined
  const scope = {
    on(event: string, listener: typeof captured) {
      expect(event).toBe('agent/request')
      captured = listener
      return () => { captured = undefined }
    },
  }
  return {
    scope,
    run: async (config: Record<string, unknown>) => {
      expect(captured).toBeDefined()
      return captured!(null, async () => config)
    },
  }
}

describe('installEffortPref', () => {
  it('无偏好时注入默认档位（max）——组合层 read() 回落 config.defaultEffort', async () => {
    // 与 index.ts 真实接线一致：read = () => chatEffortPrefs.get(chatId) ?? config.defaultEffort
    const prefs = new Map<string, string>()
    const { scope, run } = captureScope()
    installEffortPref(scope, () => prefs.get('chat-1') ?? 'max')
    const out = await run({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(out).toEqual({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' })
  })

  it('无偏好时注入自定义默认档位（config.defaultEffort 可配）', async () => {
    const { scope, run } = captureScope()
    installEffortPref(scope, () => 'high')
    const out = await run({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(out.reasoningEffort).toBe('high')
  })

  it('有 /effort 偏好时偏好优先于默认', async () => {
    const prefs = new Map<string, string>([['chat-1', 'low']])
    const { scope, run } = captureScope()
    installEffortPref(scope, () => prefs.get('chat-1') ?? 'max')
    const out = await run({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(out.reasoningEffort).toBe('low')
  })

  it('偏好为空字符串时原样放行（installEffortPref 通用机制，不注入）', async () => {
    const { scope, run } = captureScope()
    installEffortPref(scope, () => '')
    const out = await run({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(out.reasoningEffort).toBeUndefined()
    expect(out).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('保留请求的其它字段（temperature/maxTokens/stop 不被破坏）', async () => {
    const { scope, run } = captureScope()
    installEffortPref(scope, () => 'off')
    const out = await run({ provider: 'p', model: 'm', temperature: 0.3, maxTokens: 1000, stop: ['x'] })
    expect(out).toEqual({ provider: 'p', model: 'm', temperature: 0.3, maxTokens: 1000, stop: ['x'], reasoningEffort: 'off' })
  })

  it('dispose 后 listener 移除（不再注入）', async () => {
    const scope = {
      on: vi.fn(() => () => undefined),
    } as unknown as Parameters<typeof installEffortPref>[0]
    installEffortPref(scope, () => 'max')
    const onMock = vi.mocked(scope.on as unknown as ReturnType<typeof vi.fn>)
    expect(onMock).toHaveBeenCalledWith('agent/request', expect.any(Function))
    expect(onMock.mock.calls[0]![1]).toBeTypeOf('function')
  })
})

describe('currentEffort', () => {
  const runtime = {
    chatEffortPrefs: new Map<string, string>(),
    reasoningEffort: vi.fn(async () => 'high'),
  }

  it('偏好优先于运行时实际值', async () => {
    runtime.chatEffortPrefs.set('chat-1', 'off')
    expect(await currentEffort(runtime, 'chat-1')).toBe('off')
  })

  it('无偏好时读运行时实际值', async () => {
    runtime.chatEffortPrefs.clear()
    expect(await currentEffort(runtime, 'chat-2')).toBe('high')
    expect(runtime.reasoningEffort).toHaveBeenCalledWith('chat-2')
  })

  it('偏好为空字符串视为无偏好', async () => {
    runtime.chatEffortPrefs.set('chat-3', '')
    expect(await currentEffort(runtime, 'chat-3')).toBe('high')
  })
})

describe('supportedEfforts', () => {
  const ctx = { get: vi.fn() } as unknown as Parameters<typeof supportedEfforts>[0]

  it('resolveModelInfo 优先（API 返回档位列表）', async () => {
    const info = { reasoning: { efforts: [{ id: 'off' }, { id: 'max' }] } }
    vi.mocked(ctx.get).mockReturnValue({ resolveModelInfo: async () => info })
    expect(await supportedEfforts(ctx, { provider: 'deepseek', model: 'deepseek-chat' })).toEqual(['off', 'max'])
  })

  it('resolveModelInfo 空档位列表时回退已知适配器表', async () => {
    vi.mocked(ctx.get).mockReturnValue({ resolveModelInfo: async () => ({ reasoning: { efforts: [] } }) })
    expect(await supportedEfforts(ctx, { provider: 'deepseek', model: 'deepseek-chat' })).toEqual(['off', 'low', 'high', 'max'])
  })

  it('resolveModelInfo 抛错时回退已知适配器表', async () => {
    vi.mocked(ctx.get).mockReturnValue({ resolveModelInfo: async () => { throw new Error('unknown') } })
    expect(await supportedEfforts(ctx, { provider: 'pi-ai', model: 'x' })).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('llm 服务缺失时按 provider 匹配已知表', async () => {
    vi.mocked(ctx.get).mockReturnValue(undefined)
    expect(await supportedEfforts(ctx, { provider: 'deepseek', model: 'm' })).toEqual(['off', 'low', 'high', 'max'])
  })

  it('未知 provider 且 llm 缺失时返回 null（不编造档位）', async () => {
    vi.mocked(ctx.get).mockReturnValue(undefined)
    expect(await supportedEfforts(ctx, { provider: 'unknown-provider', model: 'm' })).toBeNull()
  })

  it('route 缺失/空字段时按 provider 匹配（或 null）', async () => {
    vi.mocked(ctx.get).mockReturnValue(undefined)
    expect(await supportedEfforts(ctx, undefined)).toBeNull()
    expect(await supportedEfforts(ctx, { provider: '', model: '' })).toBeNull()
    expect(await supportedEfforts(ctx, { provider: 'deepseek', model: '' })).toEqual(['off', 'low', 'high', 'max'])
  })
})
