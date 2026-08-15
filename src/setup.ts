/**
 * 一键扫码配置：基于 SDK registerApp（OAuth 2.0 Device Authorization Grant，
 * RFC 8628）的创建/授权流程，加上本地凭据持久化
 * （~/.dsh/dsh-feishu-bridge/credentials.json，0600）。
 *
 * 流程两段式设计（/setup 命令与 feishu_setup 工具共用）：
 * - beginSetupFlow() 只启动一次 registerApp；qrReady 在授权链接生成后立即兑现
 *   （秒级），result 在用户扫码完成授权后兑现凭据。调用方先拿链接回复用户，
 *   再在后台 await result，成功后 saveCredentials + 重建飞书连接。
 */
import { registerApp } from '@larksuiteoapi/node-sdk'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 持久化凭据（credentials.json 的内容）。 */
export interface BridgeCredentials {
  appId: string
  appSecret: string
}

const CREDENTIALS_FILE = join(homedir(), '.dsh', 'dsh-feishu-bridge', 'credentials.json')

/** 读取持久化凭据；文件不存在或损坏返回 null（不抛）。 */
export function loadCredentials(): BridgeCredentials | null {
  try {
    const parsed = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')) as Partial<BridgeCredentials>
    if (typeof parsed.appId === 'string' && parsed.appId !== ''
      && typeof parsed.appSecret === 'string' && parsed.appSecret !== '') {
      return { appId: parsed.appId, appSecret: parsed.appSecret }
    }
    return null
  } catch {
    return null
  }
}

/**
 * 写持久化凭据：目录自动创建；先写临时文件再 rename 原子落盘（避免半截 JSON）；
 * 权限强制 0600。rename 失败（罕见）退化为直接写目标文件。
 */
export function saveCredentials(credentials: BridgeCredentials): void {
  const dir = dirname(CREDENTIALS_FILE)
  mkdirSync(dir, { recursive: true })
  const text = `${JSON.stringify(credentials, null, 2)}\n`
  const tmp = join(dir, `.credentials.tmp-${process.pid}`)
  writeFileSync(tmp, text, { mode: 0o600 })
  try {
    renameSync(tmp, CREDENTIALS_FILE)
  } catch {
    writeFileSync(CREDENTIALS_FILE, text, { mode: 0o600 })
    try { unlinkSync(tmp) } catch { /* already gone */ }
  }
  try { chmodSync(CREDENTIALS_FILE, 0o600) } catch { /* best effort */ }
}

/** 授权链接信息（SDK QRCodeInfo 的结构视图）。 */
export interface SetupQRInfo {
  url: string
  expireIn: number
}

/** 状态变化（SDK StatusChangeInfo 的结构视图：polling / slow_down / domain_switched）。 */
export interface SetupStatusInfo {
  status: string
  interval?: number
}

/** beginSetupFlow 的可选回调。 */
export interface SetupFlowHandlers {
  onStatusChange?(info: SetupStatusInfo): void
}

/** 一次扫码配置流程的句柄。 */
export interface SetupFlow {
  /** 授权链接就绪即兑现（秒级）。 */
  qrReady: Promise<SetupQRInfo>
  /** 用户完成授权后兑现凭据；被拒/过期/中止/网络失败则 reject。 */
  result: Promise<BridgeCredentials>
  /** 主动中止流程（AbortSignal 传给 registerApp）。 */
  abort(): void
}

/** qrReady 兜底超时：begin() 网络挂起时不至于让调用方永久等待。 */
const QR_READY_TIMEOUT_MS = 30_000

/**
 * 启动扫码配置流程：registerApp 只调一次，qrReady / result 共享同一底层流程。
 * appPreset 带 {user} 占位（替换为扫码者名字）；addons 增量申请机器人收发权限、
 * im.message.receive_v1 事件与 card.action.trigger 回调；createOnly 只允许创建
 * 新应用。注意：addons 需要平台灰度、可能被忽略（被忽略时权限预填不生效，但
 * 创建流程仍可用），调用方在文案里提示用户后台补开权限。
 */
export function beginSetupFlow(handlers: SetupFlowHandlers = {}): SetupFlow {
  const abortController = new AbortController()
  let resolveQR: (info: SetupQRInfo) => void = () => {}
  let rejectQR: (error: unknown) => void = () => {}
  let qrTimer: NodeJS.Timeout | undefined
  // SDK 怪癖：requestRegistration 不带 signal，abort 后 in-flight 轮询仍会继续
  // 排程直到设备码过期（期间会持续回调 onStatusChange）——中止后不再转发状态。
  let aborted = false
  const qrReady = new Promise<SetupQRInfo>((resolve, reject) => {
    resolveQR = (info) => {
      if (qrTimer !== undefined) clearTimeout(qrTimer)
      resolve(info)
    }
    rejectQR = reject
    qrTimer = setTimeout(() => {
      reject(Object.assign(new Error('授权链接生成超时'), { code: 'qr_timeout' }))
      abortController.abort()
    }, QR_READY_TIMEOUT_MS)
  })
  const result = registerApp({
    source: 'dsh-feishu-bridge',
    signal: abortController.signal,
    createOnly: true,
    appPreset: {
      name: '{user} 的 DSH 飞书桥',
      desc: '由 DSH 飞书桥插件一键创建',
    },
    addons: {
      scopes: { tenant: ['im:message', 'im:message:send_as_bot'] },
      events: { items: { tenant: ['im.message.receive_v1'] } },
      callbacks: { items: ['card.action.trigger'] },
    },
    onQRCodeReady: (info) => resolveQR({ url: info.url, expireIn: info.expireIn }),
    onStatusChange: (info) => {
      if (aborted) return
      try {
        handlers.onStatusChange?.({ status: info.status, interval: info.interval })
      } catch { /* 回调异常不影响轮询 */ }
    },
  }).then((r) => {
    if (!r.client_secret) throw new Error('registerApp 未返回 client_secret')
    return { appId: r.client_id, appSecret: r.client_secret }
  })
  // registerApp 可能在生成链接前就失败（如网络不通）：让 qrReady 同样 reject，
  // 避免调用方在 await qrReady 上挂死。
  void result.catch((error) => rejectQR(error))
  return {
    qrReady,
    result,
    abort: () => {
      aborted = true
      abortController.abort()
      rejectQR(Object.assign(new Error('配置流程已中止'), { code: 'abort' }))
    },
  }
}

/** 把流程错误映射成友好中文文案（SDK e.code + 网络/未知兜底）。 */
export function setupErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown }).code
  switch (code) {
    case 'access_denied':
      return '授权被拒绝（你在飞书端取消了授权），未写入任何凭据。'
    case 'expired_token':
      return '授权链接已过期，请重新发起配置获取新链接。'
    case 'abort':
      return '配置流程已中止，未写入任何凭据。'
    case 'qr_timeout':
      return '授权链接生成超时（网络过慢），未写入任何凭据，请重试。'
    default:
      if (/fetch failed|network|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|timeout/i.test(detail)) {
        return `网络错误，无法连接飞书授权服务：${detail}`
      }
      return `配置失败：${detail}`
  }
}
