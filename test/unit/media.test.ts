/**
 * P2 入站多媒体解析单元测试（vitest）。
 *
 * 被测功能与来源：src/media.ts「resolveInboundMedia」（图片→ImageBlock+双落盘/
 * 文件→150KB 界+8000 截断文本提取/二进制仅元信息/下载失败提示/auth 失败安静
 * 降级/路径安全清洗）——commit 1425087「feat: P2 入站多媒体（图片→ImageBlock/
 * 文件→文本提取）与出站文件工具 lark_send_local_file，借鉴 lark-link」。
 *
 * 测试策略：channel.downloadResource / attachmentStore 全假；mediaDir 用
 * os.tmpdir 临时目录；覆盖正常路径 + 边界 + 失败降级三档。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TEXT_EXTRACT_MAX_BYTES,
  TEXT_EXTRACT_MAX_CHARS,
  isAuthFailure,
  resolveInboundMedia,
  type InboundMediaOptions,
} from '../../src/media.js'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { AttachmentStoreLike } from '../../src/media.js'

/** PNG magic bytes 打头的最小假图片。 */
function pngBytes(size = 64): Buffer {
  const buf = Buffer.alloc(size)
  buf[0] = 0x89
  buf[1] = 0x50
  return buf
}

function makeMediaDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-media-'))
  createdDirs.push(dir)
  return dir
}

/** 已创建的临时目录（afterEach 统一清理，无残留）。 */
const createdDirs: string[] = []

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Harness {
  mediaDir: string
  download: ReturnType<typeof vi.fn>
  saveImage: ReturnType<typeof vi.fn>
  logs: unknown[][]
  run: (msg: Partial<NormalizedMessage>, overrides?: Partial<InboundMediaOptions>) => Promise<Awaited<ReturnType<typeof resolveInboundMedia>>>
}

function makeHarness(overrides: Partial<InboundMediaOptions> = {}): Harness {
  const mediaDir = makeMediaDir()
  const download = vi.fn(async () => Buffer.from('file-content'))
  const saveImage = vi.fn(async (_input: Parameters<AttachmentStoreLike['saveImage']>[0]) => ({
    attachmentId: 'att-1',
    mediaType: 'image/png',
    bytes: 64,
    width: 8,
    height: 8,
  }))
  const logs: unknown[][] = []
  const channel = {
    downloadResource: download,
  } as unknown as LarkChannel
  const run = (msg: Partial<NormalizedMessage>, opts: Partial<InboundMediaOptions> = {}) =>
    resolveInboundMedia({
      msg: { messageId: 'm1', rawContentType: 'image', resources: [], ...msg } as NormalizedMessage,
      channel,
      mediaDir,
      log: (...args: unknown[]) => logs.push(args),
      ...overrides,
      ...opts,
    })
  return { mediaDir, download, saveImage, logs, run }
}

function textBlocks(content: ContentBlock[]): string {
  return content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n')
}

describe('media 图片路径', () => {
  it('图片 → 本地落盘 + attachment saveImage + ImageBlock 内容块', async () => {
    const h = makeHarness()
    h.download.mockResolvedValue(pngBytes())
    const r = await h.run({
      rawContentType: 'image',
      resources: [{ type: 'image', fileKey: 'fk1' }],
    }, { attachmentStore: { saveImage: h.saveImage } as unknown as AttachmentStoreLike })
    expect(r.kind).toBe('media')
    if (r.kind !== 'media') return
    expect(h.saveImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'image/png', name: expect.stringMatching(/^feishu-m1-.*\.png$/) }))
    expect(textBlocks(r.content)).toContain('📷 用户发来一张图片')
    const imageBlock = r.content.find((b) => b.type === 'image') as { attachment?: unknown } | undefined
    expect(imageBlock?.attachment).toMatchObject({ attachmentId: 'att-1' })
    // 双落盘：本地文件存在且为 PNG 扩展名
    const files = readdirSync(h.mediaDir)
    expect(files.some((f) => f.endsWith('.png'))).toBe(true)
    const saved = readFileSync(join(h.mediaDir, files[0]!))
    expect(saved.length).toBe(64)
  })

  it('attachmentStore 未装配 → 仅本地落盘 + 路径注记，无 ImageBlock', async () => {
    const h = makeHarness()
    h.download.mockResolvedValue(pngBytes())
    const r = await h.run({ rawContentType: 'image', resources: [{ type: 'image', fileKey: 'fk1' }] })
    expect(r.kind).toBe('media')
    if (r.kind !== 'media') return
    expect(r.content.some((b) => b.type === 'image')).toBe(false)
    expect(textBlocks(r.content)).toContain('当前未附加图片块')
    expect(readdirSync(h.mediaDir)).toHaveLength(1)
  })

  it('saveImage 抛错 → 降级为本地文件注记（不抛异常）', async () => {
    const h = makeHarness()
    h.download.mockResolvedValue(pngBytes())
    h.saveImage.mockRejectedValue(new Error('store full'))
    const r = await h.run({ rawContentType: 'image', resources: [{ type: 'image', fileKey: 'fk1' }] }, { attachmentStore: { saveImage: h.saveImage } as unknown as AttachmentStoreLike })
    expect(r.kind).toBe('media')
    if (r.kind !== 'media') return
    expect(r.content.some((b) => b.type === 'image')).toBe(false)
    expect(h.logs.some((l) => String(l[0]).startsWith('inbound image attachment save failed'))).toBe(true)
  })

  it('JPEG magic bytes → .jpg 落盘', async () => {
    const h = makeHarness()
    const jpeg = Buffer.alloc(32)
    jpeg[0] = 0xff
    jpeg[1] = 0xd8
    h.download.mockResolvedValue(jpeg)
    await h.run({ rawContentType: 'image', resources: [{ type: 'image', fileKey: 'fk1' }] })
    expect(readdirSync(h.mediaDir).some((f) => f.endsWith('.jpg'))).toBe(true)
  })

  it('图片缺 resource/fileKey → failed + userHint，不调下载', async () => {
    const h = makeHarness()
    const r = await h.run({ rawContentType: 'image', resources: [] })
    expect(r).toEqual({ kind: 'failed', quiet: false, userHint: '⚠️ 图片下载失败，请重试。' })
    expect(h.download).not.toHaveBeenCalled()
  })

  it('下载空字节 → failed + userHint', async () => {
    const h = makeHarness()
    h.download.mockResolvedValue(Buffer.alloc(0))
    const r = await h.run({ rawContentType: 'image', resources: [{ type: 'image', fileKey: 'fk1' }] })
    expect(r.kind).toBe('failed')
    if (r.kind !== 'failed') return
    expect(r.quiet).toBe(false)
    expect(r.userHint).toContain('图片下载失败')
  })

  it('下载抛 401/403（auth 失败）→ 安静降级 quiet=true，不打扰用户', async () => {
    const h = makeHarness()
    h.download.mockRejectedValue({ response: { status: 403 } })
    const r = await h.run({ rawContentType: 'image', resources: [{ type: 'image', fileKey: 'fk1' }] })
    expect(r).toEqual({ kind: 'failed', quiet: true })
    expect(h.logs.some((l) => String(l[0]).startsWith('inbound image resolve failed'))).toBe(true)
  })

  it('下载抛普通错误 → failed + userHint', async () => {
    const h = makeHarness()
    h.download.mockRejectedValue(new Error('network down'))
    const r = await h.run({ rawContentType: 'image', resources: [{ type: 'image', fileKey: 'fk1' }] })
    expect(r.kind).toBe('failed')
    if (r.kind !== 'failed') return
    expect(r.quiet).toBe(false)
    expect(r.userHint).toContain('图片下载失败')
  })
})

describe('media 文件路径', () => {
  it('文本文件 → 本地落盘 + 内容注入 agent（原始文件名清洗）', async () => {
    const h = makeHarness()
    h.download.mockResolvedValue(Buffer.from('hello world 你好'))
    const r = await h.run({
      rawContentType: 'file',
      resources: [{ type: 'file', fileKey: 'fk1', fileName: 'notes/../evil..txt' }],
    })
    expect(r.kind).toBe('media')
    if (r.kind !== 'media') return
    const note = textBlocks(r.content)
    expect(note).toContain('hello world 你好')
    expect(note).toContain('「notes/../evil..txt」') // note 保留原始文件名
    const files = readdirSync(h.mediaDir)
    expect(files.some((f) => f.includes('evil..txt'))).toBe(true)
    expect(files.some((f) => f.includes('/'))).toBe(false)
  })

  it('文本超 8000 字符 → 截断 + 截断提示', async () => {
    const h = makeHarness()
    h.download.mockResolvedValue(Buffer.from('a'.repeat(TEXT_EXTRACT_MAX_CHARS + 100)))
    const r = await h.run({ rawContentType: 'file', resources: [{ type: 'file', fileKey: 'fk1', fileName: 'long.txt' }] })
    expect(r.kind).toBe('media')
    if (r.kind !== 'media') return
    const note = textBlocks(r.content)
    expect(note).toContain('(内容过长已截断)')
    const excerpt = note.split('[文件内容]')[1] ?? ''
    expect(excerpt.length).toBeLessThanOrEqual(TEXT_EXTRACT_MAX_CHARS + 50)
  })

  it('二进制（UTF-8 替换符）→ 仅元信息注记，不提取内容', async () => {
    const h = makeHarness()
    h.download.mockResolvedValue(Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]))
    const r = await h.run({ rawContentType: 'file', resources: [{ type: 'file', fileKey: 'fk1', fileName: 'bin.dat' }] })
    expect(r.kind).toBe('media')
    if (r.kind !== 'media') return
    expect(textBlocks(r.content)).toContain('二进制文件，未提取内容')
    expect(textBlocks(r.content)).not.toContain('[文件内容]')
  })

  it('超过 150KB 字节界 → 文件过大，不提取', async () => {
    const h = makeHarness()
    h.download.mockResolvedValue(Buffer.alloc(TEXT_EXTRACT_MAX_BYTES + 1, 0x61))
    const r = await h.run({ rawContentType: 'file', resources: [{ type: 'file', fileKey: 'fk1', fileName: 'big.txt' }] })
    expect(r.kind).toBe('media')
    if (r.kind !== 'media') return
    expect(textBlocks(r.content)).toContain('文件过大，未提取内容')
  })

  it('文件缺 resource → failed + userHint', async () => {
    const h = makeHarness()
    const r = await h.run({ rawContentType: 'file', resources: [] })
    expect(r.kind).toBe('failed')
    if (r.kind !== 'failed') return
    expect(r.userHint).toContain('文件下载失败')
  })
})

describe('media 工具函数与杂项', () => {
  it('isAuthFailure：HTTP 401/403/407 与飞书权限错误码判定', () => {
    expect(isAuthFailure({ response: { status: 401 } })).toBe(true)
    expect(isAuthFailure({ response: { status: 403 } })).toBe(true)
    expect(isAuthFailure({ status: 407 })).toBe(true)
    expect(isAuthFailure({ code: 99991661 })).toBe(true)
    expect(isAuthFailure({ code: 99991668 })).toBe(true)
    expect(isAuthFailure({ code: 99991669 })).toBe(false)
    expect(isAuthFailure({ response: { status: 500 } })).toBe(false)
    expect(isAuthFailure(new Error('boom'))).toBe(false)
  })

  it('非 image/file 的 rawContentType → 安静 failed（不处理）', async () => {
    const h = makeHarness()
    const r = await h.run({ rawContentType: 'audio' })
    expect(r).toEqual({ kind: 'failed', quiet: true })
    expect(h.download).not.toHaveBeenCalled()
  })
})
