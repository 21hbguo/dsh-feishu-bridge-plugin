/**
 * 单元测试共享工具（vitest）—— 只服务 test/ 自身，不进入 lib。
 *
 * - makeCommandRuntime：构造一个完整可用的 CommandRuntime 假运行时
 *   （commands.ts 的 registerCommands 消费面），所有宿主服务经
 *   runtime.ctx.get 注入，命令回复/卡片发送被记录到 replies/cards 数组，
 *   cardAction 与 session/created 事件可由 emit* 触发。
 * - makeLarkChannel：可注入 send / on / rawClient.cardkit 的假 channel。
 *
 * 被测模块只允许操作注入的假对象与 os.tmpdir 下的临时目录，禁止触碰
 * 真实 ~/.dsh/dsh-feishu-bridge 数据（state/credentials 写路径在对应
 * 测试里用 vi.mock('../../src/state.js') 短路）。
 */
import { vi, type Mock } from 'vitest'
import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { CommandRuntime } from '../src/commands.js'
import type { BridgeAgent } from '../src/types.js'

/** 测试用 chatId（与各测试文件默认 runtime 预填的 chatEpochs 键一致）。 */
export const TEST_CHAT = 'oc_testchat'

/** 记录一次命令回复。 */
export interface ReplyRecord {
  msg: NormalizedMessage
  text: string
}

/** 记录一次卡片发送。 */
export interface CardRecord {
  chatId: string
  card: unknown
}

/** 假 channel：send / on / cardkit / botIdentity，均可断言。 */
export interface FakeChannel {
  channel: LarkChannel
  send: Mock
  on: Mock
  emit: (event: string, evt: unknown) => void
  cardActionHandlers: Map<string, (evt: CardActionEvent) => void>
}

/** 构造假 channel；send 默认回 messageId，cardkit 默认回 card_id。 */
export function makeLarkChannel(): FakeChannel {
  const cardActionHandlers = new Map<string, (evt: CardActionEvent) => void>()
  const channel = {
    botIdentity: { name: '测试机器人' },
    send: vi.fn(async () => ({ messageId: 'msg-1' })),
    downloadResource: vi.fn(),
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: vi.fn(async () => ({ data: { card_id: 'card-1' } })),
            update: vi.fn(async () => ({})),
          },
        },
      },
    },
    on: vi.fn((event: string, handler: (evt: CardActionEvent) => void) => {
      if (event === 'cardAction') cardActionHandlers.set('cardAction', handler)
      return () => cardActionHandlers.delete(event)
    }),
  } as unknown as LarkChannel
  return {
    channel,
    send: (channel as unknown as { send: Mock }).send,
    on: (channel as unknown as { on: Mock }).on,
    emit(event, evt) {
      if (event !== 'cardAction') return
      const h = cardActionHandlers.get('cardAction')
      if (h !== undefined) h(evt as CardActionEvent)
    },
    cardActionHandlers,
  }
}

/** 假 ctx：get 返回注册服务，on 收集 session/created 监听。 */
export interface FakeCtx {
  services: Record<string, unknown>
  get: Mock
  sessionCreatedHandlers: Array<(session: unknown) => void>
  on: Mock
  emitSessionCreated: (session: unknown) => void
}

/** 构造假 cordis ctx（按服务名注册的 get 表）。 */
export function makeFakeCtx(): FakeCtx {
  const sessionCreatedHandlers: Array<(session: unknown) => void> = []
  const get = vi.fn((name: string) => services[name])
  const on = vi.fn((event: string, handler: (session: unknown) => void) => {
    if (event === 'session/created') sessionCreatedHandlers.push(handler)
    return () => {
      const i = sessionCreatedHandlers.indexOf(handler)
      if (i >= 0) sessionCreatedHandlers.splice(i, 1)
    }
  })
  const services: Record<string, unknown> = {}
  return {
    services,
    get,
    sessionCreatedHandlers,
    on,
    emitSessionCreated(session) {
      for (const h of [...sessionCreatedHandlers]) h(session)
    },
  }
}

/** 假 BridgeAgent（/model /permission /yolo 等命令要碰 options/session）。 */
export function makeFakeAgent(sessionId = 'feishu-test-0-oc_testchat'): BridgeAgent {
  return {
    id: sessionId,
    session: {
      id: sessionId,
      events: [],
      append: vi.fn(),
    } as unknown as BridgeAgent['session'],
    options: { provider: 'p0', model: 'm0' },
    status: 'idle',
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
  }
}

/** 测试用 cardAction 事件的宽松形状（value.key 即回调路由键）。 */
export interface FakeCardAction {
  messageId?: string
  chatId?: string
  action?: { value?: { key?: string } }
}

/** 假 CommandRuntime：字段齐备、方法全 vi.fn，回复/卡片进数组。
 * 注意：ctx 是假对象（非完整 cordis Context），赋值回 CommandRuntime 时
 * 由测试侧 `as unknown as CommandRuntime` 收口。 */
export interface FakeRuntime extends Omit<CommandRuntime, 'ctx'> {
  replies: ReplyRecord[]
  cards: CardRecord[]
  ctx: FakeCtx
  channel: FakeChannel['channel']
  /** 触发 channel.on('cardAction') 注册的回调。 */
  emitCardAction(evt: FakeCardAction): void
  /** 当前 chat 的假 agent（默认一个 idle agent）。 */
  agent: BridgeAgent
}

/** 构造命令运行时；services 可注入 ctx 服务（llm/commands/permissionPresets/approval/agentPresets…）。
 * agent 传 null/undefined 表示「无 agent」（getAgent 返回 undefined）；不传则给默认 idle agent。 */
export function makeCommandRuntime(options: { services?: Record<string, unknown>; agent?: BridgeAgent | null } = {}): FakeRuntime {
  const ctx = makeFakeCtx()
  if (options.services !== undefined) Object.assign(ctx.services, options.services)
  const defaultAgent = makeFakeAgent()
  const hasExplicitAgent = options.agent !== undefined
  const agent = options.agent === undefined ? defaultAgent : (options.agent ?? defaultAgent)
  const chatEpochs = new Map<string, string>([[TEST_CHAT, 'test-0']])
  const replies: ReplyRecord[] = []
  const cards: CardRecord[] = []
  const channelFake = makeLarkChannel()

  const runtime: FakeRuntime = {
    ctx,
    channel: channelFake.channel,
    appId: 'cli_test_app',
    EPOCH: 'test',
    STARTED_AT: Date.now(),
    streamDefault: true,
    chatEpochs,
    chatWorkspaces: new Map(),
    chatSessionOverride: new Map(),
    chatTurns: new Map(),
    chatStreamPrefs: new Map(),
    chatYoloPrefs: new Map(),
    chatModelPrefs: new Map(),
    chatEffortPrefs: new Map(),
    chatModes: new Map(),
    chatTranscript: new Map(),
    log: vi.fn(),
    cmdReply: vi.fn(async (msg: NormalizedMessage, text: string) => {
      replies.push({ msg, text })
    }),
    sessionIdForChat(chatId) {
      const epoch = runtime.epochFor(chatId)
      const slug = chatId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)
      return `feishu-${epoch}-${slug}`
    },
    getAgent: () => (hasExplicitAgent && options.agent == null ? undefined : agent),
    epochFor(chatId) {
      return chatEpochs.get(chatId) ?? `${runtime.EPOCH}-0`
    },
    appendEpoch: vi.fn((chatId: string, epoch: string) => {
      chatEpochs.set(chatId, epoch)
    }),
    persist: vi.fn(),
    queueDepth: () => 0,
    modelLabel: vi.fn(async () => 'p0/m0'),
    readCumulativeUsage: () => null,
    agentPreset: vi.fn(async () => undefined),
    reasoningEffort: vi.fn(async () => undefined),
    restartChannel: vi.fn(async () => {}),
    startSetup: () => null,
    rebuildChannel: vi.fn(async () => {}),
    replies,
    cards,
    agent,
    emitCardAction(evt) {
      channelFake.emit('cardAction', {
        messageId: 'cb-msg-1',
        chatId: TEST_CHAT,
        action: { value: { key: '' } },
        ...evt,
      } as unknown as CardActionEvent)
    },
  }
  // 让 channel.send 同时记录卡片发送（/model /permission /mode 无参走卡片）。
  channelFake.send.mockImplementation(async (chatId: string, payload: { card?: unknown }) => {
    if (payload?.card !== undefined) cards.push({ chatId: String(chatId), card: payload.card })
    return { messageId: 'msg-1' }
  })
  return runtime
}

/** 微任务冲刷：让 fire-and-forget 的异步 handler（如 mux 帧处理）跑完。 */
export async function flushAsync(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** 从卡片对象里取出所有 button/checker 的 callback key 列表。 */
export function cardButtonKeys(card: unknown): string[] {
  const body = (card as { body?: { elements?: unknown[] } }).body
  const keys: string[] = []
  for (const el of body?.elements ?? []) {
    const behaviors = (el as { behaviors?: Array<{ type: string; value: { key: string } }> }).behaviors
    for (const b of behaviors ?? []) {
      if (b.value?.key !== undefined) keys.push(b.value.key)
    }
  }
  return keys
}

/** 从卡片对象里提取全部 markdown 元素文本。 */
export function cardMarkdownTexts(card: unknown): string[] {
  const body = (card as { body?: { elements?: unknown[] } }).body
  const out: string[] = []
  for (const el of body?.elements ?? []) {
    const el2 = el as { tag?: string; content?: string }
    if (el2.tag === 'markdown' && typeof el2.content === 'string') out.push(el2.content)
  }
  return out
}
