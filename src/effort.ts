/**
 * /effort 命令的思考强度档位枚举与设置逻辑。
 *
 * 调研依据（deepseek-harness 源码，实现前逐条核对过）：
 *
 * 1. 写入路径（web GUI 的真实路径，插件照此实现）：
 *    - web GUI 的 effort 选择器把选择提交到 `session.selectModel` RPC，host 端
 *      写入进程内 per-session selection 后由 agent-scoped `agent/request`
 *      waterfall 注入每次请求的 LlmCallConfig：
 *      packages/core/agent/src/model-selection.ts:54-70（installModelSelection 的
 *      agent/request 监听器：await next() 后以 { ...config, reasoningEffort }
 *      替换提案；档位缺失则清除继承值）。
 *    - AgentOptions 只有 provider/model/maxTokens，没有 reasoningEffort 字段
 *      （packages/core/agent/src/runtime-types.ts:24-31）——所以「创建/恢复时传
 *      agentOptions 里的字段」此路不通；真实路径是 agent setup 里注册 scoped
 *      `agent/request` waterfall（api-proxy.ts:1184-1188 installSelection 在 agent
 *      setup 阶段安装）。本模块 installEffortPref 照搬该机制。
 *    - agent-loop 每次构建请求都会走该 waterfall（packages/core/agent-loop/src/
 *      agent.ts:438-441 buildRequest → dispatch.waterfall('agent/request')），
 *      因此偏好写入 chatEffortPrefs 后下一回合（下一个 step）生效。
 *
 * 2. 档位枚举：
 *    - 统一枚举 API 存在：`ctx.llm.resolveModelInfo(provider, model)` 返回精确
 *      模型的路由元数据 `reasoning.efforts`（适配器声明的能力列表，适配器内
 *      部按模型解析，如 llm-pi-ai 的 getSupportedThinkingLevels(model)）：
 *      packages/llm/llm/src/index.ts:619-625（resolveModelInfo）；
 *      packages/llm/llm/src/types.ts:263-281（LlmModelReasoningInfo）。
 *      host 的 model catalog（web GUI 的目录来源）正是逐模型调它枚举：
 *      packages/host/apiproxy/src/api-proxy.ts:328-377（buildModelCatalog）。
 *    - 适配器拿不到元数据时回退已知适配器的档位表：
 *      - llm-deepseek：off/low/high/max（packages/llm/llm-deepseek/README.md:20
 *        「off | low | high | max — omitted ⇒ high」；serialize.ts:26）。
 *      - llm-pi-ai：off/minimal/low/medium/high/xhigh/max
 *        （packages/llm/llm-pi-ai/README.md:84「pi-ai's level set」）。
 *    - 两者都拿不到 → null（未知模型/未装配 llm，不编造档位）。
 */

import type { Context } from 'cordis'

/** 结构镜像：agent/request waterfall 的 next() 产出（LlmCallConfig）。 */
export interface BridgeCallConfig {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
}

/** agent-scoped context 上注册 agent/request waterfall 的最小结构面。 */
export interface BridgeAgentScope {
  on(
    event: 'agent/request',
    listener: (
      payload: { agent: unknown; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<BridgeCallConfig>,
    ) => Promise<BridgeCallConfig>,
  ): () => void
}

/** 已知适配器的档位表（provider route id 子串匹配；依据见文件头注释）。 */
const KNOWN_EFFORTS: ReadonlyArray<readonly [match: string, efforts: readonly string[]]> = [
  ['deepseek', ['off', 'low', 'high', 'max']],
  ['pi-ai', ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
]

/**
 * 枚举当前模型支持的思考档位（适配器声明的有序列表）。
 * API 优先：llm.resolveModelInfo 的 reasoning.efforts（web GUI 目录同源）；
 * 无元数据/调用失败时按 provider 匹配已知适配器表；两者都拿不到返回 null
 * （未知模型/无推理能力，界面显示「当前: X」而非编造列表）。
 */
export async function supportedEfforts(
  ctx: Context,
  route: { provider?: string; model?: string } | undefined,
): Promise<string[] | null> {
  if (
    route !== undefined
    && route.provider !== undefined && route.provider !== ''
    && route.model !== undefined && route.model !== ''
  ) {
    const llm = ctx.get('llm') as { resolveModelInfo?: (p: string, m: string) => Promise<{ reasoning?: { efforts?: readonly { id: string }[] } }> } | undefined
    if (llm?.resolveModelInfo !== undefined) {
      try {
        const info = await llm.resolveModelInfo(route.provider, route.model)
        const efforts = info.reasoning?.efforts
          ?.map((e) => e.id)
          .filter((id) => id !== undefined && id !== '')
        if (efforts !== undefined && efforts.length > 0) return [...efforts]
      } catch { /* resolveModelInfo 失败（未知模型/适配器异常）— 回退已知表 */ }
    }
  }
  const provider = route?.provider ?? ''
  for (const [match, efforts] of KNOWN_EFFORTS) {
    if (provider.includes(match)) return [...efforts]
  }
  return null
}

/** 读取当前档位所需的最小 runtime 面（CommandRuntime 结构兼容）。 */
export interface EffortReadRuntime {
  chatEffortPrefs: ReadonlyMap<string, string>
  reasoningEffort(chatId: string): Promise<string | undefined>
}

/**
 * 当前生效档位：per-chat 偏好（/effort 设置的）优先，否则读运行时实际值
 * （复用现有 reasoningEffort：live request header → 持久化 request/header 日志）。
 */
export async function currentEffort(runtime: EffortReadRuntime, chatId: string): Promise<string | undefined> {
  const pref = runtime.chatEffortPrefs.get(chatId)
  if (pref !== undefined && pref !== '') return pref
  return await runtime.reasoningEffort(chatId)
}

/**
 * 在 agent-scoped context 上注册 agent/request waterfall：把 read() 读到的
 * effort 偏好注入每次请求的 LlmCallConfig。与 web GUI 的 installModelSelection
 * （packages/core/agent/src/model-selection.ts:54-70）同一机制：waterfall 在
 * agent-loop 每次构建请求时运行（agent.ts:438-441），所以偏好写入 map 后
 * 下一回合生效；无偏好时原样放行（保留会话日志值/适配器默认）。scoped 监听器
 * 随 agent 生命周期自动卸载，无需手动 dispose。
 */
export function installEffortPref(agentCtx: unknown, read: () => string | undefined): void {
  const scoped = agentCtx as BridgeAgentScope
  scoped.on('agent/request', async (_payload, next) => {
    const config = await next()
    const effort = read()
    if (effort === undefined || effort === '') return config
    return { ...config, reasoningEffort: effort }
  })
}
