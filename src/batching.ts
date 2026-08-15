/**
 * Message burst batching for the Feishu bridge.
 *
 * 同一聊天（chatId）在短时间窗口内连续到达的「普通消息」合并为一条文本，
 * 窗口到期后一次 flush 交给既有回复管线（一次 thinkTurn），省 LLM 调用。
 * 语义参考 hermes-agent 的消息突发批处理（连发 0.6s 内合并进队列）。
 *
 * 窗口是滑动（debounce）语义：每来一条新消息重置计时器，直到窗口内不再
 * 有新消息才 flush——「连续发送」多久，窗口就延续多久。多条消息按原样以
 * 换行拼接（保持可读、不改动内容）。
 *
 * 本模块只处理「普通消息」：命令（/ 开头）与 /steer、/squeeze 强制模式
 * 消息由调用方在 push 之前旁路（直接走原路径），不进批处理窗口；窗口内
 * 若先有普通消息后又来命令，命令立即执行，已累积的普通文本仍按原窗口
 * flush（互不吞并）。
 */

export interface BatcherOptions<T> {
  /** 批处理窗口时长（ms）。0 = 禁用（调用方应跳过 batcher 直接处理）。 */
  windowMs: number
  /** 窗口到期（或手动 flush）时回调；text 为合并后的整段消息。 */
  onFlush(chatId: string, text: string, count: number, payload: T): void
  /** 可选日志（缺省静默）。 */
  log?(...args: unknown[]): void
}

export interface MessageBatcher<T> {
  /** 累积一条普通消息进 chatId 的批处理窗口（重置该窗口计时）。 */
  push(chatId: string, text: string, payload: T): void
  /** 立即 flush 指定 chat 的残留窗口；省略 chatId 时 flush 全部。 */
  flush(chatId?: string): void
  /** 清理全部定时器并丢弃残留窗口（插件卸载时调用，不触发 onFlush）。 */
  dispose(): void
}

interface PendingWindow<T> {
  parts: string[]
  count: number
  payload: T
  timer: NodeJS.Timeout
}

export function createBatcher<T>(options: BatcherOptions<T>): MessageBatcher<T> {
  const log = options.log ?? (() => {})
  const windows = new Map<string, PendingWindow<T>>()
  let disposed = false

  function flushChat(chatId: string): void {
    const pending = windows.get(chatId)
    if (pending === undefined) return
    windows.delete(chatId)
    clearTimeout(pending.timer)
    const text = pending.parts.join('\n')
    if (text === '') return
    log(`batched ${pending.count} message(s) into one turn (chat=${chatId})`)
    try {
      options.onFlush(chatId, text, pending.count, pending.payload)
    } catch (error) {
      log('batcher flush failed:', error instanceof Error ? error.message : String(error))
    }
  }

  return {
    push(chatId, text, payload) {
      if (disposed) return
      const t = (text ?? '').trim()
      if (t === '') return
      const existing = windows.get(chatId)
      if (existing !== undefined) {
        existing.parts.push(t)
        existing.count += 1
        existing.payload = payload
        clearTimeout(existing.timer)
        existing.timer = setTimeout(() => flushChat(chatId), options.windowMs)
        return
      }
      windows.set(chatId, {
        parts: [t],
        count: 1,
        payload,
        timer: setTimeout(() => flushChat(chatId), options.windowMs),
      })
    },
    flush(chatId) {
      if (chatId === undefined) {
        for (const key of [...windows.keys()]) flushChat(key)
        return
      }
      flushChat(chatId)
    },
    dispose() {
      if (disposed) return
      disposed = true
      const dropped = windows.size
      for (const pending of windows.values()) clearTimeout(pending.timer)
      windows.clear()
      if (dropped > 0) log(`batcher disposed: dropped ${dropped} pending window(s)`)
    },
  }
}
