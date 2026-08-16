/**
 * Markdown → 飞书 CardKit 结构化渲染（纯函数模块，零 index.ts 依赖）。
 *
 * 借鉴自 amlyczz/dsh-lark-link (MIT) src/presentation/cards.ts 的
 * looksLikeMarkdown 检测与「markdown 单元素 + 结构提示」转换思路，化用为
 * 本机回复卡（src/index.ts replyCard 的 elements 产出层）：检测标题/列表/
 * 代码块/表格等结构，输出 CardKit schema 2.0 的 markdown / div / hr 元素
 * 数组，供 index.ts 接线时替换 replyCard 中单一 `markdown` 元素。
 *
 * 转换取舍（飞书 CardKit 能力边界内）：
 * - 标题 → markdown 元素加粗（lark_md 不支持 # 标题语法）；
 * - 列表 → markdown 元素原样（lark_md 原生支持 `- ` 无序与 `1. ` 有序）；
 * - 代码块 → markdown 元素（CardKit 无代码块元素，围栏剥离后原样输出保内容）；
 * - 表格 → 每行一个 div 元素 + fields 单元格（CardKit 无表格元素，fields
 *   是最接近的行内格子布局；表头行加粗；列过多/行过多时整表回退 markdown）；
 * - 分隔线 → hr 元素；引用块 → 段落（剥离 `>` 前缀）。
 *
 * 阈值与降级：行数/总长度超限或解析异常 → 整体回退为单个 markdown 元素
 * 原样输出（degraded=true），保证任何输入都不会让卡片发送失败。
 */

import type { InteractiveCardElement } from '@larksuiteoapi/node-sdk'

/** 与飞书 CardKit 兼容的元素类型（SDK 中即 InteractiveCardElement）。 */
export type CardElement = InteractiveCardElement

/** renderReply 的可调阈值。 */
export interface RenderReplyOptions {
	/** 行数上限：超过则整体回退单个 markdown 元素（默认 60）。 */
	maxLines?: number
	/** 总字符上限：超过则整体回退单个 markdown 元素（默认 4000，对齐 config.maxReplyChars）。 */
	maxChars?: number
}

/** renderReply 的产出：元素数组 + 是否发生降级。 */
export interface RenderReplyResult {
	elements: CardElement[]
	/** true = 超限/解析异常，已回退为单个 markdown 元素原样输出。 */
	degraded: boolean
}

const DEFAULT_MAX_LINES = 60
const DEFAULT_MAX_CHARS = 4000

/** 段落内部的行结构检测（借鉴 lark-link looksLikeMarkdown 的正则思路）。 */
const HEADING_RE = /^\s{0,3}#{1,6}(?=\s|$)/
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+/
const CODE_FENCE_RE = /^\s*```/
const HR_RE = /^\s*([-*_])\s*(?:\1\s*){2,}$/
const QUOTE_RE = /^\s*>\s?/
/** 表格行：行首行尾都是 |，且至少两个 |（表头分隔行也算）。 */
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/
/** 表头分隔行：| --- | :--: | ---: | 之类。 */
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|\s*$/

/** 分割一个表格行（剥离首尾 |，按未转义 | 切分，去掉转义）。 */
function splitTableRow(line: string): string[] {
	const inner = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '')
	return inner
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim().replace(/\\([|\\])/g, '$1'))
}

/** 启发式：这段回复是否值得按 markdown 结构化渲染（lark-link 同源思路）。 */
export function looksLikeMarkdown(text: string): boolean {
	const t = text.trim()
	if (t === '') return false
	if (
		/(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s|\*\*|\|.*\|)/.test(t) ||
		t.includes('\n\n')
	) {
		return true
	}
	return false
}

/** 行→元素的分段器产出（内部中间表示）。 */
type Segment =
	| { kind: 'heading'; content: string }
	| { kind: 'list'; content: string }
	| { kind: 'code'; content: string }
	| { kind: 'table'; header: string[]; rows: string[][] }
	| { kind: 'hr' }
	| { kind: 'paragraph'; content: string }

/** 把分段器产出转成 CardKit 元素。 */
function segmentToElements(segment: Segment): CardElement[] {
	switch (segment.kind) {
		case 'heading':
			// lark_md 无标题语法 → 加粗近似标题。
			return [{ tag: 'markdown', content: `**${segment.content}**` }]
		case 'list':
		case 'paragraph':
		case 'code':
			// 列表/段落由 lark_md 原生渲染；代码块无元素可映射，原样输出保内容。
			return [{ tag: 'markdown', content: segment.content }]
		case 'hr':
			return [{ tag: 'hr' }]
		case 'table': {
			// 表头行加粗；数据行用 div.fields 呈现（CardKit 最接近表格的格子布局）。
			const elements: CardElement[] = []
			if (segment.header.length > 0) {
				const [first, ...rest] = segment.header
				elements.push({
					tag: 'div',
					text: { tag: 'lark_md', content: `**${first}**` },
					fields: rest.map((cell) => ({
						is_short: true,
						text: { tag: 'lark_md', content: `**${cell}**` },
					})),
				})
			}
			for (const row of segment.rows) {
				const [first, ...rest] = row
				if (first === undefined) continue
				elements.push({
					tag: 'div',
					text: { tag: 'plain_text', content: first },
					fields: rest.map((cell) => ({
						is_short: true,
						text: { tag: 'plain_text', content: cell },
					})),
				})
			}
			return elements
		}
	}
}

/** 整段文本原样回退（超限或解析异常的统一降级出口）。 */
function fallback(text: string): RenderReplyResult {
	return { elements: [{ tag: 'markdown', content: text }], degraded: true }
}

/**
 * 把一段 Markdown 文本渲染成 CardKit 元素数组。
 *
 * 空输入返回空元素数组（调用方应先过滤空回复）。行数/总长度超限或解析
 * 异常时返回单个 markdown 元素原样输出（degraded=true），绝不抛异常。
 */
export function renderReply(markdownText: string, options?: RenderReplyOptions): RenderReplyResult {
	const text = markdownText ?? ''
	const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES
	const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS

	const trimmed = text.trim()
	if (trimmed === '') return { elements: [], degraded: false }

	// 阈值决策：超限直接整体回退，不做半结构化（截断的半张表比纯文本更糟）。
	if (text.length > maxChars || text.split('\n').length > maxLines) {
		return fallback(trimmed)
	}

	// 无任何 Markdown 结构 → 单元素，等价于现状（不算降级）。
	if (!looksLikeMarkdown(text)) {
		return { elements: [{ tag: 'markdown', content: trimmed }], degraded: false }
	}

	try {
		const lines = text.split('\n')
		const segments: Segment[] = []
		let i = 0
		while (i < lines.length) {
			const line = lines[i]!
			// 空行 = 分段边界。
			if (line.trim() === '') {
				i += 1
				continue
			}
			// 代码块：``` 起，到下一个 ``` 或文末止。
			if (CODE_FENCE_RE.test(line)) {
				const buf: string[] = []
				i += 1
				while (i < lines.length && !CODE_FENCE_RE.test(lines[i]!)) {
					buf.push(lines[i]!)
					i += 1
				}
				i += 1 // 跳过闭合围栏（或文末的 i===length）
				segments.push({ kind: 'code', content: buf.join('\n').replace(/\n+$/, '') })
				continue
			}
			// 标题。
			const heading = HEADING_RE.exec(line)
			if (heading !== null) {
				segments.push({ kind: 'heading', content: line.slice(heading[0].length).trim() })
				i += 1
				continue
			}
			// 分隔线。
			if (HR_RE.test(line)) {
				segments.push({ kind: 'hr' })
				i += 1
				continue
			}
			// 表格：当前行 + 后续连续表格行；第二行是分隔行 → 表头。
			if (TABLE_ROW_RE.test(line)) {
				const start = i
				const rows: string[][] = [splitTableRow(line)]
				let j = i + 1
				let isSeparatorNext = false
				if (j < lines.length && TABLE_SEPARATOR_RE.test(lines[j]!.trim())) {
					isSeparatorNext = true
					j += 1
				}
				while (j < lines.length && TABLE_ROW_RE.test(lines[j]!)) {
					rows.push(splitTableRow(lines[j]!))
					j += 1
				}
				i = j
				const header = isSeparatorNext ? rows.shift() ?? [] : []
				// 列过多（>6）或行过多（>12）的表整块回退 markdown 原样。
				const maxCells = Math.max(header.length, ...rows.map((r) => r.length))
				if (maxCells > 6 || rows.length > 12) {
					segments.push({
						kind: 'paragraph',
						content: lines.slice(start, i).join('\n').trim(),
					})
					continue
				}
				segments.push({ kind: 'table', header, rows })
				continue
			}
			// 列表：连续列表行合并为一个 markdown 元素（保留原标记）。
			if (LIST_RE.test(line)) {
				const buf: string[] = []
				while (i < lines.length && lines[i]!.trim() !== '' && LIST_RE.test(lines[i]!)) {
					buf.push(lines[i]!)
					i += 1
				}
				segments.push({ kind: 'list', content: buf.join('\n') })
				continue
			}
			// 普通段落（含引用块：剥离 > 前缀；行内 **bold** / `code` / 链接由 lark_md 原生渲染）。
			const buf: string[] = []
			while (
				i < lines.length &&
				lines[i]!.trim() !== '' &&
				!HEADING_RE.test(lines[i]!) &&
				!HR_RE.test(lines[i]!) &&
				!TABLE_ROW_RE.test(lines[i]!) &&
				!LIST_RE.test(lines[i]!) &&
				!CODE_FENCE_RE.test(lines[i]!)
			) {
				buf.push(lines[i]!.replace(QUOTE_RE, ''))
				i += 1
			}
			segments.push({ kind: 'paragraph', content: buf.join('\n').trim() })
		}

		const elements = segments.flatMap(segmentToElements)
		// 全部段落化失败（理论不可达）也要保证有内容可发。
		return elements.length > 0
			? { elements, degraded: false }
			: fallback(trimmed)
	} catch {
		// 解析异常降级：单个 markdown 元素原样输出，绝不因渲染失败阻塞回复。
		return fallback(trimmed)
	}
}
