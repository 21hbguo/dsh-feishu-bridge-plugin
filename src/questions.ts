/**
 * M18 提问/问答卡片系统（进程内版，bridge.mjs 946-1282 移植）。
 *
 * agent 用 ask_user_question 提问时，host 侧 api-proxy 的 user-questions provider
 * mint rpcId 并把 `question/requested` 帧推送到 events.mux（api-proxy.ts:1377,
 * 1390-1394）；本模块订阅 mux 流（进程内直调 `ctx.apiProxy.events.mux`，不走
 * HTTP/WS），按 `chatIdForSession` 反查飞书 chat，渲染交互卡片；用户点按钮/
 * 勾选/确认后，用 `ctx.apiProxy.respond(ClientResponse)` 把回答提交回 host
 * （api-proxy.ts:3696-3742，不注册 userQuestions provider，避免与 api-proxy
 * 撞 DUPLICATE_PROVIDER）。
 *
 * 与 bridge.mjs 的差异：回答提交从 `fetch POST /api/respond` 换成进程内
 * `api.respond()`；过期 reaper 撤卡片之外还向 host 提交 cancelled（修复
 * bridge 缺口：host 侧 pending 不再永久悬挂）。
 *
 * 接线（由 index.ts 统一做，本文件不 import index.ts）：apply 的 effect 内调用
 * `registerQuestions({ ctx, channel, chatIdForSession, log })`，把返回的
 * `dispose` 并入 teardown；若要在聊天里用文字回答「无选项」问题，把返回的
 * `answerPendingFreeText(chatId, text)` 挂到 message 处理入口（消费返回 true
 * 时不启动回合，bridge.mjs answerPendingFreeText 1099）。
 */
import { randomUUID } from 'node:crypto'
import type { CardActionEvent, LarkChannel } from '@larksuiteoapi/node-sdk'
import type { Context } from 'cordis'

/** Pending ask 有效期：发卡后 10 分钟未答即过期（bridge.mjs 1078）。 */
const QUESTION_TTL_MS = 10 * 60 * 1000
/** 过期回收扫描周期（bridge.mjs 1273）。 */
const REAPER_INTERVAL_MS = 60 * 1000

// ---------------------------------------------------------------------------
// apiproxy 契约的进程内视图（结构镜像，不 import @deepseek-ai/dsh-host-apiproxy
// —— 未声明的依赖；取值自 api/events.ts:69-75、api/rpc.ts:179-193、
// api/questions.ts、api-proxy.ts:716-733、3696-3742）
// ---------------------------------------------------------------------------

/** 卡片回调按钮 value 编码：`ask|rpcId|qIndex|optionIndex`。 */
function questionButtonValue(rpcId: string, qIndex: number, optionIndex: number): string {
  return `ask|${rpcId}|${qIndex}|${optionIndex}`
}

/** 多选勾选 value 编码：`askm|rpcId|qIndex|optionIndex`。 */
function questionCheckValue(rpcId: string, qIndex: number, optionIndex: number): string {
  return `askm|${rpcId}|${qIndex}|${optionIndex}`
}

/** 确认按钮 value 编码：`asksubmit|rpcId`。 */
function questionSubmitValue(rpcId: string): string {
  return `asksubmit|${rpcId}`
}

/** 选项的显示文案：label 优先，其次 value，最后是占位（bridge.mjs 986/995）。 */
function optionLabel(opt: BridgeQuestionOption, optionIndex: number): string {
  return String(opt.label ?? opt.value ?? `选项 ${optionIndex + 1}`)
}

/** AskUserQuestionItem 的进程内视图（dsh-user-questions/types.ts:35-50 镜像）。 */
interface BridgeQuestionOption {
  label?: string
  value?: string
  description?: string
}

/** AskUserQuestionItem 的进程内视图（dsh-user-questions/types.ts:35-50 镜像）。 */
interface BridgeQuestion {
  id: string
  question: string
  detail?: string
  header?: string
  options?: BridgeQuestionOption[]
  multiSelect?: boolean
  intent?: { kind: string; approve: string }
}

/** 一次 ask 批次（question/requested 帧载荷，api/events.ts:74 镜像）。 */
interface BridgeQuestionRequestedFrame {
  type: 'question/requested'
  sessionId: string
  questions: BridgeQuestion[]
}

/** 提问已结算（question/resolved 帧载荷，api/events.ts:75 镜像）。 */
interface BridgeQuestionResolvedFrame {
  type: 'question/resolved'
  sessionId: string
  questionRpcId: string
  outcome: 'answered' | 'cancelled'
}

/** mux 帧载荷：只读本模块关心的字段，其余帧原样透传（含 session/event）。 */
interface BridgeMuxPayload {
  type: string
  sessionId?: string
  questions?: BridgeQuestion[]
  questionRpcId?: string
  outcome?: string
  [key: string]: unknown
}

/** AskUserQuestionAnswerItem 的进程内视图（dsh-user-questions/types.ts:53-60 镜像）。 */
interface BridgeAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** ClientResponse 信封（api/rpc.ts:179-183 镜像；error 只走 cancelled 分支）。 */
interface BridgeClientResponse {
  type: 'client-response'
  rpcId: string
  result:
    | { ok: true; value: { sessionId: string; answer: { answers: BridgeAnswerItem[] } } }
    | { ok: false; error: { code: 'cancelled'; message: string; details: Record<string, never> } }
}

/** RpcReceipt（api/rpc.ts:193 镜像）。 */
type BridgeRpcReceipt = { accepted: true } | { accepted: false; reason: 'not-pending' | 'bad-response' }

/** ApiProxy 的进程内视图：只取 events.mux + respond 两个面（api/index.ts:22-42）。 */
interface BridgeApiProxy {
  events: {
    mux(request: { rpcId: string; payload: Record<string, unknown> }, signal: AbortSignal): AsyncIterable<{ rpcId: string; payload: BridgeMuxPayload }>
  }
  respond(message: BridgeClientResponse): Promise<BridgeRpcReceipt>
}

/** registerQuestions 需要的运行时依赖（由 index.ts 提供；接口在此定义，不改 types.ts）。 */
export interface QuestionRuntime {
  /** cordis 上下文：取 apiProxy / loader 服务。 */
  ctx: Context
  /** 飞书 channel：发卡/更新卡/卡片回调。 */
  channel: LarkChannel
  /** 反查拥有某 DSH sessionId 的飞书 chat（bridge.mjs chatIdForSession 1021）。 */
  chatIdForSession(sessionId: string): string | undefined
  /** 日志（复用 runtime.log）。 */
  log(...args: unknown[]): void
}

/** registerQuestions 的返回值：供 index.ts 接线（teardown + 可选自由文本消费）。 */
export interface QuestionBridge {
  /** 卸载：中止 mux 订阅、摘 cardAction 监听、停 reaper，并把仍在 pending 的 ask 全部 cancelled 提交回 host。 */
  dispose(): void
  /**
   * 消费聊天里的自由文本，作为该 chat 最新 pending 卡片的「无选项」问题答案
   * （bridge.mjs answerPendingFreeText 1099）。返回 true 表示已被消费（消息
   * 处理入口不应再启动回合）。
   */
  answerPendingFreeText(chatId: string, text: string): Promise<boolean>
}

/** 一条 pending ask 的本地登记（bridge.mjs 948-952 的 pendingQuestions 行）。 */
interface PendingQuestionEntry {
  chatId: string
  sessionId: string
  questions: BridgeQuestion[]
  rpcId: string
  answerMap: Map<number, { selected: string[]; custom?: string }>
  cardMessageId: string
  cardId: string
  expiresAt: number
}

/** 任意抛出值的一行错误文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 装配 M18 提问系统：订阅进程内 question/requested → 发飞书交互卡；cardAction
 * 路由 ask/askm/asksubmit；question/resolved → 结算卡片；10 分钟过期 reaper
 * （撤卡 + 向 host 提交 cancelled）。
 *
 * apiProxy 服务可能晚于本插件装配（web-app bundle 顺序不定）：先即时尝试，若
 * 未就绪则等 loader.await() 后再试一次；两种情况下都没有 apiProxy 就静默降级
 * （question 卡片功能关闭，插件其余功能不受影响）。
 */
export function registerQuestions(runtime: QuestionRuntime): QuestionBridge {
  const { ctx, channel, chatIdForSession, log } = runtime

  /** pendingQuestions: question rpcId -> entry（bridge.mjs 950）。 */
  const pendingQuestions = new Map<string, PendingQuestionEntry>()
  /** chatId -> 该 chat 最新的 pending entry（bridge.mjs 952）。 */
  const pendingQuestionByChat = new Map<string, PendingQuestionEntry>()
  /** cardId -> 下一个更新序列号：必须从小递增，飞书拒绝 epoch 时间戳（9499）。 */
  const cardkitSequences = new Map<string, number>()

  const ac = new AbortController()
  const disposers: Array<() => void> = []
  let started = false
  let disposed = false

  /** 发卡片实体 + 引用发送，之后可用 card_id 全量更新（bridge.mjs sendCardkit 1032）。 */
  async function sendCardkit(chatId: string, card: object): Promise<{ messageId: string; cardId: string }> {
    const r = await channel.rawClient.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(card) },
    })
    const cardId = r.data?.card_id
    if (cardId === undefined) throw new Error('cardkit.card.create returned no card_id')
    const { messageId } = await channel.send(chatId, { card: { type: 'card', data: { card_id: cardId } } }, {})
    return { messageId, cardId }
  }

  /** 按 card_id 全量更新卡片实体（bridge.mjs updateCardkit 1047）。 */
  async function updateCardkit(cardId: string, card: object): Promise<void> {
    const sequence = (cardkitSequences.get(cardId) ?? 0) + 1
    cardkitSequences.set(cardId, sequence)
    await channel.rawClient.cardkit.v1.card.update({
      path: { card_id: cardId },
      data: { card: { type: 'card_json', data: JSON.stringify(card) }, sequence },
    })
  }

  /** 从两张登记表摘除一条 pending（bridge.mjs 1123-1124）。 */
  function dropEntry(rpcId: string, chatId: string): void {
    pendingQuestions.delete(rpcId)
    if (pendingQuestionByChat.get(chatId)?.rpcId === rpcId) pendingQuestionByChat.delete(chatId)
  }

  /** question/requested 帧：反查 chat、发卡、登记（bridge.mjs handleQuestionRequested 1059）。 */
  async function handleQuestionRequested(frame: BridgeQuestionRequestedFrame, rpcId: string): Promise<void> {
    const { sessionId, questions } = frame
    const chatId = chatIdForSession(sessionId)
    if (chatId === undefined) {
      log(`question frame for unknown chat (session ${sessionId}) — skipping`)
      return
    }
    if (rpcId === '') {
      log('question frame without rpcId — skipping')
      return
    }
    // 新 ask 直接发新卡，旧卡留在聊天历史里；仅更新本 chat 的"最新卡"指针。
    const answerMap = new Map<number, { selected: string[]; custom?: string }>()
    const card = questionCard(frame, rpcId)
    const { messageId, cardId } = await sendCardkit(chatId, card)
    const entry: PendingQuestionEntry = {
      chatId, sessionId, questions, rpcId, answerMap, cardMessageId: messageId, cardId,
      expiresAt: Date.now() + QUESTION_TTL_MS,
    }
    pendingQuestions.set(rpcId, entry)
    pendingQuestionByChat.set(chatId, entry)
    log(`question card sent: rpcId=${rpcId} chat=${chatId} q=${questions.length} cardId=${cardId}`)
  }

  /** question/resolved 帧：host 已结算（回答或 agent 侧取消）——撤卡收尾（bridge.mjs 1087）。 */
  async function handleQuestionResolved(frame: BridgeQuestionResolvedFrame): Promise<void> {
    const rpcId = frame.questionRpcId
    const entry = pendingQuestions.get(rpcId)
    if (entry === undefined) return
    dropEntry(rpcId, entry.chatId)
    log(`question resolved: rpcId=${rpcId} outcome=${frame.outcome}`)
    await finishQuestionCard(entry, frame.outcome === 'answered' ? 'answered' : 'cancelled')
  }

  /** 消费自由文本，作为该 chat 最新 pending 卡里第一个未答的「无选项」问题答案（bridge.mjs 1099）。 */
  async function answerPendingFreeText(chatId: string, text: string): Promise<boolean> {
    const entry = pendingQuestionByChat.get(chatId)
    if (entry === undefined) return false
    const qIndex = entry.questions.findIndex((q, i) => {
      const hasOptions = Array.isArray(q.options) && q.options.length > 0
      return !hasOptions && !entry.answerMap.has(i)
    })
    if (qIndex === -1) return false
    entry.answerMap.set(qIndex, { selected: [], custom: text })
    log(`free-text answer for rpcId=${entry.rpcId} q=${qIndex}: ${text.slice(0, 60)}`)
    if (allQuestionsAnswered(entry)) {
      await resolveQuestion(entry.rpcId, 'answered')
      await finishQuestionCard(entry, 'answered')
    } else {
      await updateQuestionCard(entry)
    }
    return true
  }

  /**
   * 结算一条 pending：摘表 + 用 `api.respond(ClientResponse)` 提交回答回 host
   * （进程内直调，不走网络；bridge.mjs resolveQuestion 1120 的 fetch 版换成
   * ctx.apiProxy.respond）。cancelled 分支修复 bridge 缺口：过期/卸载也通知
   * host，避免 pending 永久悬挂。
   */
  async function resolveQuestion(rpcId: string, outcome: 'answered' | 'cancelled'): Promise<void> {
    const api = ctx.get('apiProxy') as BridgeApiProxy | undefined
    const entry = pendingQuestions.get(rpcId)
    if (entry === undefined) return
    dropEntry(rpcId, entry.chatId)
    if (api === undefined) {
      log(`question resolve skipped (apiProxy unavailable): rpcId=${rpcId} outcome=${outcome}`)
      return
    }
    const body: BridgeClientResponse = outcome === 'cancelled'
      ? {
          type: 'client-response',
          rpcId,
          result: { ok: false, error: { code: 'cancelled', message: 'the user cancelled the question from Feishu', details: {} } },
        }
      : {
          type: 'client-response',
          rpcId,
          result: {
            ok: true,
            value: {
              sessionId: entry.sessionId,
              answer: {
                answers: [...entry.answerMap.entries()].map(([qIndex, a]) => ({
                  id: entry.questions[qIndex]?.id ?? String(qIndex),
                  selected: a.selected,
                  ...(a.custom !== undefined ? { custom: a.custom } : {}),
                })),
              },
            },
          },
        }
    try {
      const receipt = await api.respond(body)
      const status = receipt.accepted ? 'accepted' : `rejected(${receipt.reason})`
      log(`question resolved via respond: rpcId=${rpcId} outcome=${outcome} ${status}`)
    } catch (error) {
      log('question respond failed:', errorMessage(error))
    }
  }

  /** 批次里每个问题是否都已记录至少一个答案（bridge.mjs allQuestionsAnswered 1155）。 */
  function allQuestionsAnswered(entry: PendingQuestionEntry): boolean {
    return entry.questions.every((_q, qIndex) => entry.answerMap.has(qIndex))
  }

  /** 把当前选择状态渲染回 pending 卡；answered=true 时禁用全部交互元素（bridge.mjs 1162）。 */
  async function updateQuestionCard(entry: PendingQuestionEntry, answered = false): Promise<void> {
    const elements: object[] = []
    entry.questions.forEach((q, qIndex) => {
      const lines = [`**${q.question}**`]
      if (q.header !== undefined) lines.unshift(`<font color=grey>${q.header}</font>`)
      if (q.detail !== undefined) lines.push(`<font color=grey>${q.detail}</font>`)
      if (q.multiSelect === true && !answered) lines.push('<font color=grey>可多选，完成后点下方确认。</font>')
      const a = entry.answerMap.get(qIndex)
      const chosen = a?.selected ?? []
      const custom = a?.custom
      if (chosen.length > 0) lines.push(`<font color=green>已选：${chosen.join('、')}</font>`)
      if (custom !== undefined && custom !== '') lines.push(`<font color=green>答案：${custom}</font>`)
      elements.push({ tag: 'markdown', content: lines.join('\n') })
      if (Array.isArray(q.options) && q.options.length > 0) {
        if (q.multiSelect === true) {
          q.options.forEach((opt, optionIndex) => {
            const label = optionLabel(opt, optionIndex)
            elements.push({
              tag: 'checker',
              text: { tag: 'plain_text', content: label },
              checked: chosen.includes(label),
              disabled: answered,
              behaviors: [{ type: 'callback', value: { key: questionCheckValue(entry.rpcId, qIndex, optionIndex) } }],
            })
          })
        } else {
          q.options.forEach((opt, optionIndex) => {
            const label = optionLabel(opt, optionIndex)
            const isChosen = chosen.includes(label)
            elements.push({
              tag: 'button',
              text: { tag: 'plain_text', content: `${isChosen ? '✅ ' : ''}${label}` },
              type: isChosen ? 'primary' : 'default',
              disabled: answered,
              behaviors: [{ type: 'callback', value: { key: questionButtonValue(entry.rpcId, qIndex, optionIndex) } }],
            })
          })
        }
      }
    })
    // Pending 且存在多选/自由文本问题时保留确认按钮；已结算则移除。
    if (!answered && entry.questions.some((q) => q.multiSelect === true || !(Array.isArray(q.options) && q.options.length > 0))) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '✅ 确认' },
        type: 'primary',
        behaviors: [{ type: 'callback', value: { key: questionSubmitValue(entry.rpcId) } }],
      })
    }
    elements.push({ tag: 'markdown', content: `<font color=grey>${answered ? '✅ 本提问已结束' : '回复 /cancel 可取消本次提问。'}</font>` })
    await updateCardkit(entry.cardId, { schema: '2.0', config: { update_multi: true }, body: { elements } })
  }

  /** 结算一张卡：禁用按钮并标记 answered/cancelled，卡留在聊天历史（bridge.mjs 1263）。 */
  async function finishQuestionCard(entry: PendingQuestionEntry, status: 'answered' | 'cancelled'): Promise<void> {
    try {
      await updateQuestionCard(entry, true)
      log(`question card finalized: msg=${entry.cardMessageId} status=${status}`)
    } catch (error) {
      const code = (error as { code?: unknown }).code
      log(`question card finalize FAILED: ${typeof code === 'string' ? code : ''} ${errorMessage(error)}`)
    }
  }

  /** 卡片按钮回调路由：ask/askm/asksubmit 三种 value（bridge.mjs 1217 起的内联路由）。 */
  async function onCardAction(evt: CardActionEvent): Promise<void> {
    try {
      const value = evt?.action?.value
      if (typeof value !== 'object' || value === null) return
      const key = (value as { key?: unknown }).key
      if (typeof key !== 'string') return
      const parts = key.split('|')
      if (parts[0] === undefined) return
      const [kind, rpcId] = parts
      const entry = pendingQuestions.get(rpcId)
      if (entry === undefined) return

      if (kind === 'asksubmit') {
        // 确认按钮（多选/自由文本批次）：整批按已答结算。
        await resolveQuestion(rpcId, 'answered')
        await finishQuestionCard(entry, 'answered')
        return
      }

      const qIndex = Number(parts[2])
      const optionIndex = Number(parts[3])
      const q = entry.questions[qIndex]
      const opt = q?.options?.[optionIndex]
      if (q === undefined || opt === undefined) return
      let a = entry.answerMap.get(qIndex)
      if (a === undefined) { a = { selected: [] }; entry.answerMap.set(qIndex, a) }
      const label = optionLabel(opt, optionIndex)
      if (kind === 'askm') {
        // 多选：在选中集合里切换该 label。
        if (a.selected.includes(label)) a.selected = a.selected.filter((s) => s !== label)
        else a.selected.push(label)
        await updateQuestionCard(entry)
        return
      }
      // 单选：选中即结算（整批都答完才提交）。
      a.selected = [label]
      await updateQuestionCard(entry)
      if (allQuestionsAnswered(entry)) {
        await resolveQuestion(rpcId, 'answered')
        await finishQuestionCard(entry, 'answered')
      }
    } catch (error) {
      log('cardAction handling failed:', errorMessage(error))
    }
  }

  /** 消费 mux 流：只关心 question/requested 与 question/resolved，其余帧忽略。 */
  async function consumeMux(api: BridgeApiProxy): Promise<void> {
    try {
      const stream = api.events.mux({ rpcId: randomUUID(), payload: {} }, ac.signal)
      for await (const envelope of stream) {
        const rpcId = envelope.rpcId
        if (typeof rpcId !== 'string' || rpcId === '') continue
        const payload = envelope.payload
        if (payload.type === 'question/requested') {
          const { sessionId, questions } = payload
          if (typeof sessionId !== 'string' || !Array.isArray(questions)) continue
          void handleQuestionRequested({ type: 'question/requested', sessionId, questions }, rpcId)
            .catch((error) => log('question handling failed:', errorMessage(error)))
        } else if (payload.type === 'question/resolved') {
          const { questionRpcId, outcome } = payload
          if (typeof questionRpcId !== 'string') continue
          void handleQuestionResolved({
            type: 'question/resolved',
            sessionId: payload.sessionId ?? '',
            questionRpcId,
            outcome: outcome === 'answered' ? 'answered' : 'cancelled',
          }).catch((error) => log('question resolved handling failed:', errorMessage(error)))
        }
      }
    } catch (error) {
      if (!ac.signal.aborted) log('question mux stream ended:', errorMessage(error))
    }
  }

  /** 启动本体：apiProxy 就绪后注册 cardAction 监听 + reaper + mux 消费。 */
  function start(api: BridgeApiProxy): void {
    started = true
    disposers.push(channel.on('cardAction', onCardAction))
    disposers.push(() => ac.abort())
    // 过期回收：撤卡 + 向 host 提交 cancelled（bridge 原缺口：只撤卡不发 cancelled）。
    const reaper = setInterval(() => {
      const now = Date.now()
      const expired: Array<[string, PendingQuestionEntry]> = []
      for (const [rpcId, entry] of pendingQuestions) {
        if (entry.expiresAt < now) expired.push([rpcId, entry])
      }
      for (const [rpcId, entry] of expired) {
        void (async () => {
          await resolveQuestion(rpcId, 'cancelled')
          await finishQuestionCard(entry, 'cancelled')
        })()
      }
    }, REAPER_INTERVAL_MS)
    reaper.unref()
    disposers.push(() => clearInterval(reaper))
    void consumeMux(api)
    log('questions ready: mux subscribed, question cards enabled')
  }

  /** apiProxy 就绪探测：即时尝试一次；未就绪则等 loader 装配完成后重试。 */
  const loader = ctx.get('loader') as { await(): Promise<void> } | undefined
  function trySetup(quiet: boolean): void {
    if (started || disposed) return
    const api = ctx.get('apiProxy') as BridgeApiProxy | undefined
    if (api === undefined) {
      if (!quiet) log('questions: apiProxy service unavailable — question cards disabled')
      return
    }
    start(api)
  }
  trySetup(loader !== undefined)
  if (loader !== undefined) {
    void loader.await()
      .then(() => trySetup(false))
      .catch((error) => log('questions: loader await failed:', errorMessage(error)))
  }

  /** 卸载：停流、摘监听、停 reaper，并把仍在 pending 的 ask 全部 cancelled 提交回 host。 */
  function dispose(): void {
    if (disposed) return
    disposed = true
    ac.abort()
    for (const off of disposers.splice(0)) {
      try { off() } catch { /* already gone */ }
    }
    const remaining = [...pendingQuestions.values()]
    for (const entry of remaining) {
      void (async () => {
        await resolveQuestion(entry.rpcId, 'cancelled')
        await finishQuestionCard(entry, 'cancelled')
      })()
    }
  }

  return { dispose, answerPendingFreeText }
}

/** 构建一张 ask 批次的交互卡：标题/说明 + 按钮单选或勾选多选 + 可选确认（bridge.mjs questionCard 970）。 */
function questionCard(frame: BridgeQuestionRequestedFrame, rpcId: string): object {
  const elements: object[] = []
  const qs = frame.questions ?? []
  let needsSubmit = false // 多选或自由文本问题需要显式确认
  qs.forEach((q, qIndex) => {
    const lines = [`**${q.question}**`]
    if (q.header !== undefined) lines.unshift(`<font color=grey>${q.header}</font>`)
    if (q.detail !== undefined) lines.push(`<font color=grey>${q.detail}</font>`)
    if (q.multiSelect === true) lines.push('<font color=grey>可多选，完成后点下方确认。</font>')
    elements.push({ tag: 'markdown', content: lines.join('\n') })
    if (Array.isArray(q.options) && q.options.length > 0) {
      if (q.multiSelect === true) {
        needsSubmit = true
        q.options.forEach((opt, optionIndex) => {
          elements.push({
            tag: 'checker',
            text: { tag: 'plain_text', content: optionLabel(opt, optionIndex) },
            checked: false,
            behaviors: [{ type: 'callback', value: { key: questionCheckValue(rpcId, qIndex, optionIndex) } }],
          })
        })
      } else {
        q.options.forEach((opt, optionIndex) => {
          elements.push({
            tag: 'button',
            text: { tag: 'plain_text', content: optionLabel(opt, optionIndex) },
            type: 'default',
            behaviors: [{ type: 'callback', value: { key: questionButtonValue(rpcId, qIndex, optionIndex) } }],
          })
        })
      }
    } else {
      // 无选项：用户直接在聊天里回复文字作答。
      needsSubmit = true
      elements.push({ tag: 'markdown', content: '<font color=grey>请直接回复答案（文字消息）。</font>' })
    }
  })
  if (needsSubmit) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '✅ 确认' },
      type: 'primary',
      behaviors: [{ type: 'callback', value: { key: questionSubmitValue(rpcId) } }],
    })
  }
  elements.push({ tag: 'markdown', content: '<font color=grey>回复 /cancel 可取消本次提问。</font>' })
  return { schema: '2.0', config: { update_multi: true }, body: { elements } }
}
