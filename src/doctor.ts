/**
 * /doctor 一键诊断包（P2）：收集当前 chat 对应 DSH 会话的完整 session log
 * （宿主 sessionPersistence.readRaw，与 WebUI「Session log」下载同源）、
 * 脱敏配置（插件凭据打码）与 ISSUE.md，用 fflate 打成单个 ZIP，以飞书文件
 * 消息发回当前 chat。任一收集项失败 → 跳过并写入 ISSUE.md「收集失败」节；
 * zip 失败 / 发送失败 → 向上抛出（commands.ts 回文本错误卡片）。
 *
 * （整体设计借鉴自 amlyczz/dsh-lark-link (MIT)：
 *   - src/application/diagnostics-service.ts —— 脱敏诊断文本 + ISSUE.md 模板；
 *   - src/index.ts 的 /doctor 接线 —— sessionPersistence.readRaw 取会话日志、
 *     fflate zipSync 打包、上传文件后发 file 消息；
 *   - src/application/status-formatter.ts 的 redactSecrets —— 秘密值替换 +
 *     32 位长 token 正则打码。
 * 化用差异：
 *   - 只收集插件数据目录（~/.dsh/dsh-feishu-bridge）的凭据与配置，宿主配置
 *     文件不收集；凭据按 key 名（secret/token/appid/password）递归打码；
 *   - 日志取当前 chat 的会话（sessionId 由 commands.ts 注入），不收集子代理
 *     日志（宿主 traceSession 未接线）；
 *   - 发送走本地 LarkChannel.send({ file })（SDK 内部按扩展名映射
 *     file_type，zip → stream），不直接调 im/v1/files；
 *   - 体积上限 10MB：超限裁掉 session log 保留其余并在 ISSUE.md 注明。）
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { LarkChannel } from '@larksuiteoapi/node-sdk'
import type { Context } from 'cordis'

/** 插件数据目录（凭据 / state / 连接历史都在此）。 */
const DATA_DIR = join(homedir(), '.dsh', 'dsh-feishu-bridge')

/** ZIP 体积上限：超过则裁掉 session log 保留其余（飞书文件消息上限亦为 10MB）。 */
const MAX_ZIP_BYTES = 10 * 1024 * 1024

/** session log 文本上限：先截断再打包，避免内存峰值与超限重试。 */
const MAX_LOG_CHARS = 8 * 1024 * 1024

// ---------------------------------------------------------------------------
// 宿主服务面的进程内视图（结构镜像，不 import 未声明的包；同 types.ts 政策）
// ---------------------------------------------------------------------------

/** sessionPersistence.readRaw 的返回（mirror of SessionRawArtifact）。 */
interface DoctorRawArtifact {
  meta?: unknown
  filename: string
  content: string
}

/** 宿主 sessionPersistence 的 readRaw 面（local types.ts 只声明 list/inspect）。 */
interface DoctorSessionPersistence {
  readRaw?(id: string, signal?: AbortSignal): Promise<DoctorRawArtifact | undefined>
}

/** 宿主 sessions 存储的 flush 面（live 会话先落盘再读，对齐 session-log-export）。 */
interface DoctorSessionStore {
  get?(id: string): unknown
  flush?(session: unknown): Promise<void>
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

/** 敏感 key 名（值整体打码）：secret/token/password/appid 等。 */
const SENSITIVE_KEY = /(secret|token|password|passwd|credential|appid|app_id)/i

/** 打码单个值：appId 类保留前 7 字符前缀便于对照，其余整体打码。 */
function maskValue(key: string, value: unknown): string {
  const s = String(value)
  if (s === '') return s
  if (/appid|app_id/i.test(key) && s.length > 8) return `${s.slice(0, 7)}***`
  return '***'
}

/**
 * 递归脱敏任意 JSON 值：敏感 key 的值整体打码；字符串再做秘密值替换 +
 * 长 token 正则兜底（借鉴自 lark-link redactSecrets）。
 */
function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? maskValue(k, v) : redactValue(v, secrets)
    }
    return out
  }
  if (typeof value === 'string') return redactSecrets(value, secrets)
  return value
}

/** 秘密值替换 + 32 位以上 token 正则打码（借鉴自 lark-link status-formatter.ts redactSecrets）。 */
export function redactSecrets(input: string, secrets: readonly string[]): string {
  let out = input
  // 先长后短替换，避免短秘密值先命中截断长值。
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret === undefined || secret === null || secret === '') continue
    out = out.split(secret).join('***')
  }
  out = out.replace(/\b[0-9A-Za-z_\-]{32,}\b/g, '***')
  return out
}

// ---------------------------------------------------------------------------
// 环境信息
// ---------------------------------------------------------------------------

/** 插件版本：读自身 package.json（lib/ 上一级；打包安装后同构）。 */
function pluginVersion(): string {
  try {
    const req = createRequire(import.meta.url)
    const pkg = req('../package.json') as { version?: string }
    return pkg.version !== undefined && pkg.version !== '' ? pkg.version : '未知'
  } catch {
    return '未知'
  }
}

/** DSH 版本：以 @deepseek-ai/dsh-llm 包版本为代表（宿主同仓库统一发版）。 */
function dshVersion(): string {
  try {
    const req = createRequire(import.meta.url)
    const pkg = req('@deepseek-ai/dsh-llm/package.json') as { version?: string }
    return pkg.version !== undefined && pkg.version !== '' ? pkg.version : '未知'
  } catch {
    return '未知'
  }
}

// ---------------------------------------------------------------------------
// 收集 + 打包 + 发送
// ---------------------------------------------------------------------------

/** runDoctor 的运行时依赖（由 commands.ts 注入；statusText 避免循环 import）。 */
export interface DoctorDeps {
  ctx: Context
  channel: LarkChannel
  chatId: string
  /** 当前 chat 的 DSH 会话 id（runtime.sessionIdForChat(chatId)）。 */
  sessionId: string
  appId: string
  /** /status 同源状态快照文本（commands.ts 注入 renderStatus）。 */
  statusText(): Promise<string>
  /** 插件运行时已知配置摘记（如流式默认值），并入脱敏配置。 */
  extraConfig: Record<string, unknown>
  log(...args: unknown[]): void
}

/** 一次收集项的产物或失败说明。 */
interface CollectedEntry {
  name: string
  bytes?: number
}

/**
 * 生成并发送诊断包。成功返回摘要文本（由命令层回给 chat）；zip 或发送失败
 * 抛出 Error（命令层回文本错误卡片）。
 */
export async function runDoctor(deps: DoctorDeps): Promise<string> {
  const collected: CollectedEntry[] = []
  const failures: Array<{ item: string; reason: string }> = []

  // ------------------------------------------------------- ① session log
  let sessionFile: { filename: string; content: string } | undefined
  try {
    const persistence = deps.ctx.get('sessionPersistence') as DoctorSessionPersistence | undefined
    if (persistence?.readRaw === undefined) {
      throw new Error('宿主 sessionPersistence 服务未装配或后端不支持 readRaw')
    }
    // live 会话先经存储 flush 屏障落盘（与宿主 session-log-export 一致），
    // 拿不到 flush 也继续（jsonl 后端本身逐事件落盘）。
    try {
      const store = deps.ctx.get('sessions') as DoctorSessionStore | undefined
      const live = store?.get?.(deps.sessionId)
      if (live !== undefined && store?.flush !== undefined) await store.flush(live)
    } catch (error) {
      deps.log('doctor: live-session flush skipped:', error instanceof Error ? error.message : String(error))
    }
    const artifact = await persistence.readRaw(deps.sessionId)
    if (artifact === undefined || artifact.content === '') {
      throw new Error(`会话 ${deps.sessionId} 没有已落盘的日志（readRaw 返回空）`)
    }
    let content = artifact.content
    if (content.length > MAX_LOG_CHARS) {
      content = `${content.slice(0, MAX_LOG_CHARS)}\n...(截断：日志超过 ${MAX_LOG_CHARS} 字符，仅保留开头)`
      failures.push({ item: 'session log 截断', reason: `原始 ${artifact.content.length} 字符，超过上限` })
    }
    sessionFile = { filename: artifact.filename ?? 'session.jsonl', content }
    collected.push({ name: sessionFile.filename, bytes: content.length })
  } catch (error) {
    failures.push({ item: 'session log', reason: error instanceof Error ? error.message : String(error) })
  }

  // ------------------------------------------------------- ② 脱敏配置
  let configSnapshot: Record<string, unknown>
  try {
    const secrets: string[] = []
    let credentials: unknown = null
    try {
      const raw = JSON.parse(readFileSync(join(DATA_DIR, 'credentials.json'), 'utf8')) as Record<string, unknown>
      for (const v of Object.values(raw)) {
        if (typeof v === 'string' && v !== '') secrets.push(v)
      }
      credentials = raw
    } catch {
      // 无凭据文件（未配置）——不视为失败，配置节里如实标注。
    }
    let dataDirFiles: string[] = []
    try {
      dataDirFiles = readdirSync(DATA_DIR)
    } catch { /* 目录不存在 */ }
    configSnapshot = {
      appId: maskValue('appId', deps.appId),
      credentials: credentials === null ? '(未找到 credentials.json)' : redactValue(credentials, secrets),
      dataDirFiles,
      ...deps.extraConfig,
    }
    collected.push({ name: 'config.sanitized.json' })
  } catch (error) {
    failures.push({ item: '脱敏配置', reason: error instanceof Error ? error.message : String(error) })
    configSnapshot = { note: '配置收集失败' }
  }

  // ------------------------------------------------------- ③ ISSUE.md
  const statusText = await deps.statusText().catch((error) => `（状态快照失败：${error instanceof Error ? error.message : String(error)}）`)
  const issueMd = [
    '# dsh-feishu-bridge 诊断包',
    '',
    `- 生成时间: ${new Date().toISOString()}`,
    `- 插件版本: ${pluginVersion()}`,
    `- DSH 版本: ${dshVersion()}`,
    `- 系统: ${process.platform} ${process.arch} / Node ${process.version}`,
    `- bot: ${typeof deps.extraConfig.botName === 'string' ? deps.extraConfig.botName : deps.appId}（App ID: ${configSnapshot.appId ?? '***'}）`,
    `- chat: ${deps.chatId}`,
    '',
    '## 当前 chat 状态快照',
    '```',
    statusText,
    '```',
    '',
    '## 配置（脱敏）',
    '```json',
    JSON.stringify(configSnapshot, null, 2),
    '```',
    '',
    '## 收集失败',
    failures.length > 0
      ? failures.map((f) => `- ${f.item}: ${f.reason}`).join('\n')
      : '- （无）',
    '',
    '## 问题描述（请填写）',
    '- 现象：',
    '- 复现步骤：',
    '- 期望结果：',
    '- 涉及命令：',
    '',
    '## 已知症状模板（勾选适用项）',
    '- [ ] 消息收不到 / 延迟',
    '- [ ] 流式卡片不更新 / 卡住',
    '- [ ] 命令无响应 / 未知命令',
    '- [ ] 模型切换后仍用旧模型',
    '- [ ] 权限 / 审批异常',
    '- [ ] 重启后状态丢失',
    '- [ ] 其他：____',
    '',
  ].join('\n')

  // ------------------------------------------------------- 打包（fflate）
  const readmeTxt = [
    '本压缩包内容：',
    '- session.jsonl（或后端原始文件名）: 当前会话的 DSH session log（与 WebUI「Session log」下载同源）',
    '- config.sanitized.json: 脱敏后的插件凭据与配置',
    '- ISSUE.md: 诊断信息 + 问题描述模板',
    '',
    '将本包直接发给维护者，或贴 ISSUE.md 给 AI 即可定位问题。',
  ].join('\n')

  function buildZip(withLog: boolean): Uint8Array {
    const entries: Record<string, Uint8Array> = {
      'config.sanitized.json': strToU8(JSON.stringify(configSnapshot, null, 2)),
      'ISSUE.md': strToU8(issueMd),
      'README.txt': strToU8(readmeTxt),
    }
    if (withLog && sessionFile !== undefined) {
      entries[sessionFile.filename] = strToU8(sessionFile.content)
    }
    return zipSync(entries, { level: 6 })
  }

  let zip = buildZip(true)
  let logDropped = false
  if (zip.length > MAX_ZIP_BYTES) {
    // 超限：裁掉 session log 保留其余并注明（与 lark-link 的降级精神一致）。
    logDropped = true
    zip = buildZip(false)
    failures.push({ item: 'session log（体积超限已裁掉）', reason: `ZIP 超过 ${MAX_ZIP_BYTES} 字节上限` })
  }

  // ------------------------------------------------------- 发送
  const fileName = `dsh-feishu-bridge-doctor-${Date.now()}.zip`
  await deps.channel.send(deps.chatId, { file: { source: Buffer.from(zip), fileName } }, {})

  const parts = collected.map((c) => c.name)
  if (logDropped) parts.push('session log 已裁掉')
  deps.log(`doctor: zip sent (${fileName}, ${zip.length} bytes, files: ${parts.join(', ')})`)
  return `✅ 诊断包已发送：${fileName}（${(zip.length / 1024).toFixed(0)} KB）\n`
    + `内含：${parts.join('、') || '（空包）'}\n`
    + `收集失败 ${failures.length} 项（详见包内 ISSUE.md）。`
}
