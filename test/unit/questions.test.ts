/**
 * P0 提问/问答卡片系统单元测试（vitest）。
 *
 * 被测功能与来源：src/questions.ts「registerQuestions」（consumeMux 断流 2s
 * 退避重订阅 + 双停止标志；question/requested 发卡、ask/askm/asksubmit 回调
 * 路由、question/resolved 结算、apiProxy 缺失静默降级、卸载 cancelled 回投）——
 * commit 4eff658「fix: questions mux 断流 2s 退避重订阅，带停止标志防卸载空转」。
 *
 * 可测面：consumeMux 等均为 registerQuestions 内部闭包、无导出——测试全部
 * 走公开面（registerQuestions 返回的 dispose/answerPendingFreeText + 注入的
 * 假 channel/apiProxy），驱动 mux 帧与 cardAction 事件断言行为。断流重订阅
 * 用 vi fake timers 推进 2s 退避。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { Context } from 'cordis'
import { registerQuestions, type QuestionRuntime } from '../../src/questions.js'
import { makeLarkChannel, flushAsync, type FakeChannel } from '../helpers.js'

/** mux 帧形状。 */
interface Frame {
  rpcId: string
  payload: Record<string, unknown>
}

/** apiProxy 的进程内结构视图（questions.ts 内部接口未导出，此处镜像）。 */
interface FakeApiProxy {
  events: {
    mux(request: unknown, signal: AbortSignal): AsyncIterable<{ rpcId: string; payload: Frame['payload'] }>
  }
  respond(message: unknown): Promise<unknown>
}

/**
 * 假 apiProxy：push 式异步队列——生成器逐帧 yield，测试用 push(frame) 投帧，
 * 每帧处理完才继续（无竞态）。ended=true 时流在队列清空后自然结束（触发
 * 2s 重订阅路径）；缺省挂起等待下一帧。
 */
function makeApi(opts: { ended?: boolean } = {}): {
  api: FakeApiProxy
  mux: ReturnType<typeof vi.fn>
  respond: ReturnType<typeof vi.fn>
  push: (frame: Frame) => void
} {
  const queue: Frame[] = []
  const waiters: Array<() => void> = []
  const respond = vi.fn(async () => ({ accepted: true }))
  const mux = vi.fn(async function* (): AsyncGenerator<{ rpcId: string; payload: Frame['payload'] }> {
    while (true) {
      const next = queue.shift()
      if (next !== undefined) {
        yield { rpcId: next.rpcId, payload: next.payload }
        continue
      }
      if (opts.ended === true) return
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
  })
  return {
    api: { events: { mux }, respond },
    mux,
    respond,
    push(frame) {
      queue.push(frame)
      for (const w of waiters.splice(0)) w()
    },
  }
}

interface Harness {
  runtime: QuestionRuntime
  fake: FakeChannel
  api: ReturnType<typeof makeApi>
  logs: unknown[][]
  bridge: ReturnType<typeof registerQuestions>
  sendFrame: (frame: Frame) => Promise<void>
  emitCardAction: (key: string) => Promise<void>
  cardCreateCalls: () => number
  cardUpdateCalls: () => number
}

function makeHarness(opts: { apiProxy?: boolean; ended?: boolean } = {}): Harness {
  const fake = makeLarkChannel()
  const logs: unknown[][] = []
  const api = makeApi({ ended: opts.ended })
  const apiHolder = { value: opts.apiProxy === false ? undefined : api.api }
  const chatIdForSession = (sessionId: string) => (sessionId === 'sess-1' ? 'oc_chat' : undefined)
  const ctx = {
    get: (name: string) => (name === 'apiProxy' ? apiHolder.value : name === 'loader' ? undefined : undefined),
  }
  const runtime = { ctx, channel: fake.channel, chatIdForSession, log: (...a: unknown[]) => logs.push(a) } as unknown as QuestionRuntime
  const bridge = registerQuestions(runtime)
  const cardCreate = fake.channel.rawClient.cardkit.v1.card.create as unknown as ReturnType<typeof vi.fn>
  const cardUpdate = fake.channel.rawClient.cardkit.v1.card.update as unknown as ReturnType<typeof vi.fn>
  return {
    runtime,
    fake,
    api,
    logs,
    bridge,
    sendFrame: async (frame: Frame) => {
      api.push(frame)
      await flushAsync(30)
    },
    emitCardAction: async (key: string) => {
      fake.emit('cardAction', { messageId: 'cb-1', chatId: 'oc_chat', action: { value: { key } } })
      await flushAsync(30)
    },
    cardCreateCalls: () => cardCreate.mock.calls.length,
    cardUpdateCalls: () => cardUpdate.mock.calls.length,
  }
}

/** 构造一条 question/requested 帧。 */
function requestedFrame(overrides: Partial<{ sessionId: string; rpcId: string; questions: unknown[] }> = {}): Frame {
  return {
    rpcId: overrides.rpcId ?? 'rpc-1',
    payload: {
      type: 'question/requested',
      sessionId: overrides.sessionId ?? 'sess-1',
      questions: overrides.questions ?? [
        { id: 'q1', question: '选一个', options: [{ label: 'A' }, { label: 'B' }] },
      ],
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('questions mux 订阅与发卡', () => {
  it('question/requested → 创建 cardkit 卡片并发送引用消息', async () => {
    const h = makeHarness()
    await h.sendFrame(requestedFrame())
    expect(h.cardCreateCalls()).toBe(1)
    const createArg = (h.fake.channel.rawClient.cardkit.v1.card.create as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      data: { type: string }
    }
    expect(createArg.data.type).toBe('card_json')
    expect(h.fake.channel.send).toHaveBeenCalledWith('oc_chat', { card: { type: 'card', data: { card_id: 'card-1' } } }, {})
  })

  it('未知 session（chatIdForSession 反查失败）→ 不发卡', async () => {
    const h = makeHarness()
    await h.sendFrame(requestedFrame({ sessionId: 'sess-unknown' }))
    expect(h.cardCreateCalls()).toBe(0)
  })

  it('空 rpcId 帧 → 跳过', async () => {
    const h = makeHarness()
    await h.sendFrame(requestedFrame({ rpcId: '' }))
    expect(h.cardCreateCalls()).toBe(0)
  })

  it('非 question 类型帧忽略', async () => {
    const h = makeHarness()
    await h.sendFrame({ rpcId: 'rpc-x', payload: { type: 'session/event' } })
    expect(h.cardCreateCalls()).toBe(0)
  })

  it('apiProxy 缺失 → 静默降级：不发卡、不订阅 cardAction', () => {
    const h = makeHarness({ apiProxy: false })
    expect(h.logs.some((l) => String(l[0]).includes('apiProxy service unavailable'))).toBe(true)
    expect(h.fake.cardActionHandlers.size).toBe(0)
  })
})

describe('questions 卡片回调路由', () => {
  it('单选按钮（ask|rpc|0|1）→ 选中结算：respond ok + 卡片置已结束', async () => {
    const h = makeHarness()
    await h.sendFrame(requestedFrame())
    await h.emitCardAction('ask|rpc-1|0|1')
    expect(h.api.respond).toHaveBeenCalledTimes(1)
    const body = h.api.respond.mock.calls[0]![0] as { result: { ok: boolean; value?: { answer: { answers: unknown[] } } } }
    expect(body.result.ok).toBe(true)
    expect(body.result.value?.answer.answers).toEqual([{ id: 'q1', selected: ['B'] }])
    expect(h.cardUpdateCalls()).toBeGreaterThan(0) // 卡片更新为已结束
    expect(h.api.respond).toHaveBeenCalledTimes(1) // 不重复结算
  })

  it('多选勾选（askm）切换选择，确认（asksubmit）整批结算', async () => {
    const h = makeHarness()
    await h.sendFrame(requestedFrame({
      questions: [{ id: 'q1', question: '多选', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
    }))
    await h.emitCardAction('askm|rpc-1|0|0') // 勾 A
    expect(h.api.respond).not.toHaveBeenCalled() // 多选不即时结算
    await h.emitCardAction('askm|rpc-1|0|1') // 勾 B
    await h.emitCardAction('askm|rpc-1|0|0') // 取消 A
    await h.emitCardAction('asksubmit|rpc-1')
    expect(h.api.respond).toHaveBeenCalledTimes(1)
    const body = h.api.respond.mock.calls[0]![0] as { result: { value?: { answer: { answers: unknown[] } } } }
    expect(body.result.value?.answer.answers).toEqual([{ id: 'q1', selected: ['B'] }])
  })

  it('未知 rpcId 忽略；未知前缀但 rpcId 命中时按单选处理（源码行为）', async () => {
    const h = makeHarness()
    await h.sendFrame(requestedFrame())
    await h.emitCardAction('ask|rpc-nope|0|0')
    expect(h.api.respond).not.toHaveBeenCalled() // 未知 rpcId：忽略
    // 注意：onCardAction 只对 askm/asksubmit 特判，其他前缀（含 other）
    // 落到单选分支——这里锁定该行为，防止误改
    await h.emitCardAction('other|rpc-1|0|0')
    expect(h.api.respond).toHaveBeenCalledTimes(1)
  })

  it('question/resolved 帧 → 撤卡收尾（update 调用，不再 respond）', async () => {
    const h = makeHarness()
    await h.sendFrame(requestedFrame())
    const updatesBefore = h.cardUpdateCalls()
    await h.sendFrame({
      rpcId: 'rpc-1',
      payload: { type: 'question/resolved', sessionId: 'sess-1', questionRpcId: 'rpc-1', outcome: 'answered' },
    })
    expect(h.cardUpdateCalls()).toBeGreaterThan(updatesBefore)
    expect(h.api.respond).not.toHaveBeenCalled()
  })
})

describe('questions 自由文本作答', () => {
  it('无选项问题：answerPendingFreeText 提交 custom 答案并结算', async () => {
    const h = makeHarness()
    await h.sendFrame(requestedFrame({ questions: [{ id: 'q1', question: '请描述' }] }))
    const consumed = await h.bridge.answerPendingFreeText('oc_chat', '我的答案')
    expect(consumed).toBe(true)
    expect(h.api.respond).toHaveBeenCalledTimes(1)
    const body = h.api.respond.mock.calls[0]![0] as { result: { value?: { answer: { answers: unknown[] } } } }
    expect(body.result.value?.answer.answers).toEqual([{ id: 'q1', selected: [], custom: '我的答案' }])
    // 结算后再次作答 → false
    expect(await h.bridge.answerPendingFreeText('oc_chat', '再来')).toBe(false)
  })

  it('未知 chat / 无 pending → false', async () => {
    const h = makeHarness()
    expect(await h.bridge.answerPendingFreeText('oc_unknown', 'x')).toBe(false)
    expect(await h.bridge.answerPendingFreeText('oc_chat', 'x')).toBe(false)
  })
})

describe('questions mux 断流重订阅与卸载', () => {
  it('mux 流结束 → 2s 退避后重新订阅', async () => {
    vi.useFakeTimers()
    const h = makeHarness({ ended: true })
    expect(h.api.mux).toHaveBeenCalledTimes(1) // 首次订阅
    await vi.advanceTimersByTimeAsync(2000)
    await flushAsync(30)
    expect(h.api.mux).toHaveBeenCalledTimes(2) // 2s 退避后重订阅
    await vi.advanceTimersByTimeAsync(2000)
    await flushAsync(30)
    expect(h.api.mux).toHaveBeenCalledTimes(3) // 持续重订阅
  })

  it('dispose：中止订阅、pending 卡片以 cancelled 回投 host，且不再重订阅', async () => {
    const h = makeHarness()
    await h.sendFrame(requestedFrame())
    h.bridge.dispose()
    await flushAsync(30)
    expect(h.api.respond).toHaveBeenCalledTimes(1)
    const body = h.api.respond.mock.calls[0]![0] as { result: { ok: boolean; error?: { code: string } } }
    expect(body.result.ok).toBe(false) // cancelled 信封
    expect(body.result.error?.code).toBe('cancelled')
    expect(h.api.mux).toHaveBeenCalledTimes(1) // 卸载后不重订阅
  })

  it('dispose 幂等：重复调用不重复回投', async () => {
    const h = makeHarness()
    await h.sendFrame(requestedFrame())
    h.bridge.dispose()
    h.bridge.dispose()
    await flushAsync(30)
    expect(h.api.respond).toHaveBeenCalledTimes(1)
  })
})
