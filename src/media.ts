/**
 * P2 入站多媒体：图片 → 下载 → DSH attachment 存储（ImageBlock，供视觉模型）+
 * 本地落盘；文件 → 下载 → 有界文本提取（文本类截断 8000 字符）/ 元信息注记。
 *
 * 借鉴自 amlyczz/dsh-lark-link (MIT) — src/application/message-handler.ts
 * resolveInboundAttachments：magic bytes 嗅探（sniffImageType/imgExt）、双落盘
 * （本地文件 + ctx.attachments.saveImage → ImageBlock 引用）、150KB 有界文本
 * 提取 + UTF-8 替换符（\uFFFD）过滤判二进制。
 *
 * 降级铁律（与 lark-link 一致）：任何一步失败都不抛异常 —— 提示用户（下载
 * 失败/无资源）或安静降级（401/403 等无凭据场景只记日志），绝不阻塞主流程。
 * 与 lark-link 的差异：① 文本提取在 lark-link 的 150KB 字节界之上追加
 * 8000 字符截断（本任务规格）；② 持久化文件名做路径安全清洗（lark-link 直接
 * 拼接 file_name）。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 有界文本提取的字节上限（超过即视为大文件，只注记元信息）。借鉴 lark-link。 */
export const TEXT_EXTRACT_MAX_BYTES = 150_000
/** 提取文本注入 agent 的字符截断（本任务规格；lark-link 无截断直接全文入提示词）。 */
export const TEXT_EXTRACT_MAX_CHARS = 8_000

/** DSH attachment 存储的进程内结构视图（ctx.get('attachments')，可选服务）。 */
export interface AttachmentStoreLike {
  saveImage(input: {
    data: Uint8Array
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    name?: string
  }): Promise<{
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }>
}

/** 入站媒体解析的输入（由 index.ts 的 handle 媒体分支组装）。 */
export interface InboundMediaOptions {
  msg: NormalizedMessage
  channel: LarkChannel
  /** DSH attachment store；未装配（undefined）时图片降级为仅本地落盘 + 路径注记。 */
  attachmentStore?: AttachmentStoreLike
  /** 本地持久化目录（~/.dsh/dsh-feishu-bridge/media，与 state 同根）。 */
  mediaDir: string
  log(...args: unknown[]): void
}

/** 入站媒体解析结果。 */
export type InboundMediaResult =
  /** 下载/解析失败：quiet = 无凭据类失败（401/403），只记日志不打扰用户。 */
  | { kind: 'failed'; quiet: boolean; userHint?: string }
  /** 解析成功：content = 注入 agent 的内容块（文本注记 + 可选 ImageBlock）。 */
  | { kind: 'media'; content: ContentBlock[]; transcriptText: string }

/**
 * saveImage 返回值的结构视图。attachmentId 是 DSH 品牌类型（AttachmentId），
 * 本包不 import @deepseek-ai/dsh-attachment（未声明依赖），构建 ImageBlock
 * 时以 `as ContentBlock` 断言补上品牌位（运行时即宿主返回的真实 ref）。
 */
type ImageRef = {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** One-line error text from any thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 飞书凭据/权限类失败判定：HTTP 401/403/407 或常见 tenant token / 权限错误码。 */
export function isAuthFailure(error: unknown): boolean {
  const e = error as { response?: { status?: number }; status?: number; code?: number | string }
  const status = e?.response?.status ?? e?.status
  if (status === 401 || status === 403 || status === 407) return true
  const code = typeof e?.code === 'number' ? e.code : Number.NaN
  if (!Number.isFinite(code)) return false
  // 飞书常见凭据/权限错误码：99991661 应用未授权 / 99991663 tenant token 无效 /
  // 99991664 token 过期 / 99991665 应用未启用 / 99991668 无接口权限。
  return [99991661, 99991663, 99991664, 99991665, 99991668].includes(code)
}

/** Sniff image media type from magic bytes (feishu im resources are raw). */
function sniffImageType(buf: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (
    buf.length >= 12 &&
    buf.slice(0, 4).every((b, i) => b === [0x52, 0x49, 0x46, 0x46][i]) &&
    buf.slice(8, 12).every((b, i) => b === [0x57, 0x45, 0x42, 0x50][i])
  ) return 'image/webp'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif'
  return 'image/png' // fallback — attachment store validates against decoded bytes
}

/** File extension (including dot) for an image media type. */
function imgExt(m: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'): string {
  switch (m) {
    case 'image/png': return '.png'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return '.jpg'
  }
}

/** 人类可读文件大小（B/KB/MB）。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 文件名清洗：剔除路径分隔符与危险字符（lark-link 直接拼接 file_name，本机加固）。 */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return cleaned === '' ? 'file' : cleaned.slice(0, 80)
}

/**
 * 把下载字节持久化到 mediaDir（best-effort：写失败只记日志，绝不丢消息）。
 * 图片按嗅探类型命名；文件保留原始文件名（已清洗）。返回落盘路径与显示名。
 */
function persistMedia(
  buf: Buffer,
  kind: 'image' | 'file',
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined,
  messageId: string,
  fileName: string | undefined,
  mediaDir: string,
  log: (...args: unknown[]) => void,
): { path: string; name: string } | undefined {
  try {
    mkdirSync(mediaDir, { recursive: true })
    const name = kind === 'image'
      ? `feishu-${messageId}-${Date.now()}${imgExt(mediaType ?? 'image/png')}`
      : `feishu-${messageId}-${Date.now()}-${sanitizeFileName(fileName ?? 'file')}`
    const path = join(mediaDir, name)
    writeFileSync(path, buf)
    return { path, name }
  } catch (error) {
    log('inbound media persist failed:', errorMessage(error))
    return undefined
  }
}

/**
 * 解析入站媒体消息：image → 下载 → 本地落盘 → attachment 存储 → ImageBlock
 * 内容块；file → 下载 → 本地落盘 → 有界文本提取（或元信息注记）。任何失败
 * 降级为 failed（quiet 区分无凭据场景），绝不抛异常。
 */
export async function resolveInboundMedia(opts: InboundMediaOptions): Promise<InboundMediaResult> {
  const { msg, channel, mediaDir, log } = opts
  const kind: 'image' | 'file' | null =
    msg.rawContentType === 'image' ? 'image' : msg.rawContentType === 'file' ? 'file' : null
  if (kind === null) return { kind: 'failed', quiet: true }

  const resource = (msg.resources ?? []).find((r) => r.type === kind)
  if (resource === undefined || resource.fileKey === '') {
    return {
      kind: 'failed',
      quiet: false,
      userHint: kind === 'image' ? '⚠️ 图片下载失败，请重试。' : '⚠️ 文件下载失败，请重试。',
    }
  }

  try {
    const buf = await channel.downloadResource(resource.fileKey, kind)
    if (buf.length === 0) throw new Error('empty resource download')

    if (kind === 'image') {
      const mediaType = sniffImageType(buf)
      const saved = persistMedia(buf, 'image', mediaType, msg.messageId, undefined, mediaDir, log)
      // DSH attachment 存储（可选服务）：saveImage 失败/未装配 → 降级为仅本地
      // 文件 + 路径注记（非视觉模型/外部工具仍可读磁盘）。
      let imageRef: ImageRef | undefined
      if (opts.attachmentStore !== undefined) {
        try {
          imageRef = await opts.attachmentStore.saveImage({ data: buf, mediaType, name: saved?.name })
        } catch (error) {
          log('inbound image attachment save failed (degraded to local file):', errorMessage(error))
        }
      }
      const baseNote = saved !== undefined
        ? `📷 用户发来一张图片，已保存到 ${saved.path}。`
        : '📷 用户发来一张图片（本地保存失败）。'
      const note = imageRef === undefined
        ? `${baseNote}（当前未附加图片块，如需查看可读取该文件。）`
        : baseNote
      const content: ContentBlock[] = [{ type: 'text', text: note }]
      if (imageRef !== undefined) {
        content.push({ type: 'image', attachment: imageRef } as ContentBlock)
      }
      return { kind: 'media', content, transcriptText: note }
    }

    // file：有界文本提取 —— 字节界内且 UTF-8 无替换符视为文本类，截断 8000 字符。
    const fileName = resource.fileName ?? '附件'
    const saved = persistMedia(buf, 'file', undefined, msg.messageId, fileName, mediaDir, log)
    const sizeNote = `（${formatSize(buf.length)}）`
    const whereNote = saved !== undefined ? `，已保存到 ${saved.path}` : '（本地保存失败）'
    let note: string
    if (buf.length <= TEXT_EXTRACT_MAX_BYTES) {
      const text = buf.toString('utf8')
      if (!text.includes('\uFFFD')) {
        const excerpt = text.length > TEXT_EXTRACT_MAX_CHARS
          ? `${text.slice(0, TEXT_EXTRACT_MAX_CHARS)}\n…(内容过长已截断)`
          : text
        note = `📄 用户发来文件「${fileName}」${sizeNote}${whereNote}。\n\n[文件内容]\n${excerpt}`
      } else {
        note = `📄 用户发来文件「${fileName}」${sizeNote}${whereNote}（二进制文件，未提取内容）。`
      }
    } else {
      note = `📄 用户发来文件「${fileName}」${sizeNote}${whereNote}（文件过大，未提取内容）。`
    }
    return { kind: 'media', content: [{ type: 'text', text: note }], transcriptText: note }
  } catch (error) {
    log(`inbound ${kind} resolve failed:`, errorMessage(error))
    // 无凭据环境（401/403/权限类错误码）：安静降级，只记日志，不回复提示。
    if (isAuthFailure(error)) return { kind: 'failed', quiet: true }
    return {
      kind: 'failed',
      quiet: false,
      userHint: kind === 'image' ? '⚠️ 图片下载失败，请重试。' : '⚠️ 文件下载失败，请重试。',
    }
  }
}
