/**
 * P1 Markdown→飞书 CardKit 结构化渲染单元测试（vitest）。
 *
 * 被测功能与来源：src/markdown-card.ts「Markdown → 飞书 CardKit 结构化渲染」
 * （标题/列表/代码块/表格 div.fields/hr/引用；60 行/4000 字符阈值降级；异常
 * 降级永不抛）——commit 3e22b6f「feat: Markdown→飞书 CardKit 结构化渲染（标题/
 * 列表/代码块/表格 + 超限与异常降级）」。
 *
 * 纯函数模块，无 IO；覆盖正常路径 + 边界阈值 + 失败降级三档。
 */
import { describe, expect, it } from 'vitest'
import { looksLikeMarkdown, renderReply, type CardElement } from '../../src/markdown-card.js'

type El = { tag?: string; content?: string; text?: unknown; fields?: unknown[] }

function markdownTexts(elements: CardElement[]): string[] {
  return elements
    .map((e) => (e as El).content)
    .filter((c): c is string => typeof c === 'string')
}

function tags(elements: CardElement[]): string[] {
  return elements.map((e) => (e as El).tag ?? '?')
}

describe('markdown-card 基础渲染', () => {
  it('空输入 → 空元素、不降级', () => {
    expect(renderReply('')).toEqual({ elements: [], degraded: false })
    expect(renderReply('   \n ')).toEqual({ elements: [], degraded: false })
  })

  it('无结构纯文本 → 单 markdown 元素、不算降级', () => {
    const r = renderReply('hello world')
    expect(r.degraded).toBe(false)
    expect(markdownTexts(r.elements)).toEqual(['hello world'])
  })

  it('标题 → 加粗 markdown（lark_md 无 # 语法）', () => {
    const r = renderReply('# 大标题')
    expect(markdownTexts(r.elements)).toEqual(['**大标题**'])
  })

  it('列表 → markdown 元素原样（lark_md 原生支持）', () => {
    const r = renderReply('- a\n- b\n1. c')
    expect(r.degraded).toBe(false)
    expect(markdownTexts(r.elements)).toEqual(['- a\n- b\n1. c'])
  })

  it('代码块 → 围栏剥离后原样输出；未闭合围栏不抛', () => {
    const r = renderReply('```js\nconst x = 1\n```')
    expect(markdownTexts(r.elements)).toEqual(['const x = 1'])
    const unclosed = renderReply('```\nno close here')
    expect(unclosed.degraded).toBe(false)
    expect(markdownTexts(unclosed.elements)).toEqual(['no close here'])
  })

  it('分隔线 → hr 元素（需先被启发式判为 markdown，如空行分段场景）', () => {
    const r = renderReply('前面一段\n\n---')
    expect(tags(r.elements)).toEqual(['markdown', 'hr'])
    // 单独一行 --- 不算 markdown 结构（启发式判定），原样单元素输出
    const lone = renderReply('---')
    expect(lone.degraded).toBe(false)
    expect(markdownTexts(lone.elements)).toEqual(['---'])
  })

  it('引用块 → 段落并剥离 > 前缀', () => {
    const r = renderReply('> 引用的内容')
    expect(markdownTexts(r.elements)).toEqual(['引用的内容'])
  })

  it('混合结构顺序保持（标题→列表→hr→段落）', () => {
    const r = renderReply('# t\n- a\n---\nplain')
    expect(tags(r.elements)).toEqual(['markdown', 'markdown', 'hr', 'markdown'])
    const contents = markdownTexts(r.elements)
    expect(contents[0]).toBe('**t**')
    expect(contents[1]).toBe('- a')
    expect(contents[2]).toBe('plain') // hr 无 content，被 markdownTexts 过滤
  })
})

describe('markdown-card 表格', () => {
  it('带分隔行的表格 → 表头加粗 div + 数据行 div.fields', () => {
    const r = renderReply('| 列A | 列B |\n| --- | --- |\n| a1 | b1 |')
    expect(r.degraded).toBe(false)
    expect(tags(r.elements)).toEqual(['div', 'div'])
    const header = r.elements[0] as El
    expect((header.text as { content?: string }).content).toBe('**列A**')
    const fields = (header.fields ?? []) as Array<{ text?: { content?: string } }>
    expect(fields[0]?.text?.content).toBe('**列B**')
    const row = r.elements[1] as El
    expect((row.text as { content?: string }).content).toBe('a1')
    expect((row.fields as Array<{ text?: { content?: string } }>)[0]?.text?.content).toBe('b1')
  })

  it('无分隔行的表格 → 全部按数据行渲染（无表头）', () => {
    const r = renderReply('| a | b |\n| c | d |')
    expect(tags(r.elements)).toEqual(['div', 'div'])
    expect(markdownTexts(r.elements)).toEqual([]) // div 无 content
  })

  it('单元格内转义管道/反斜杠被还原', () => {
    const r = renderReply('| a\\|b | c\\\\ |')
    const row = r.elements[0] as El
    expect((row.text as { content?: string }).content).toBe('a|b')
  })

  it('列过多（>6）→ 整表回退为 markdown 段落（不降级标志）', () => {
    const line = '| a | b | c | d | e | f | g |'
    const r = renderReply(line)
    expect(tags(r.elements)).toEqual(['markdown'])
    expect(markdownTexts(r.elements)[0]).toContain('| a | b')
  })

  it('行过多（>12）→ 整表回退为 markdown 段落', () => {
    const rows = ['| h1 | h2 |']
    for (let i = 0; i < 14; i++) rows.push('| x | y |')
    const r = renderReply(rows.join('\n'))
    expect(tags(r.elements)).toEqual(['markdown'])
  })
})

describe('markdown-card 阈值降级与异常容错', () => {
  it('超过 maxLines（默认 60）→ 整体回退单 markdown + degraded', () => {
    const text = Array.from({ length: 61 }, (_, i) => `line ${i}`).join('\n')
    const r = renderReply(text)
    expect(r.degraded).toBe(true)
    expect(r.elements).toHaveLength(1)
    expect(markdownTexts(r.elements)[0]).toContain('line 60')
  })

  it('恰好在 60 行 → 不降级', () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
    expect(renderReply(text).degraded).toBe(false)
  })

  it('超过 maxChars（默认 4000）→ 整体回退 + degraded', () => {
    const r = renderReply('a'.repeat(4001))
    expect(r.degraded).toBe(true)
    expect(markdownTexts(r.elements)[0]).toBe('a'.repeat(4001)) // 原样保留
  })

  it('恰好在 4000 字符 → 不降级', () => {
    expect(renderReply('a'.repeat(4000)).degraded).toBe(false)
  })

  it('options 可自定义阈值（maxLines/maxChars）', () => {
    const r = renderReply('a\nb\nc', { maxLines: 2 })
    expect(r.degraded).toBe(true)
    const r2 = renderReply('a'.repeat(50), { maxChars: 40 })
    expect(r2.degraded).toBe(true)
  })

  it('孤行管道（无行首 |）→ 段落渲染不抛', () => {
    const r = renderReply('hello | world')
    expect(r.degraded).toBe(false)
    expect(markdownTexts(r.elements)).toEqual(['hello | world'])
  })

  it('异常降级：无效输入也不抛（null/undefined 按空串）', () => {
    expect(renderReply(null as unknown as string).elements).toEqual([])
    expect(renderReply(undefined as unknown as string).elements).toEqual([])
  })
})

describe('markdown-card looksLikeMarkdown 启发式', () => {
  it('识别标题/列表/代码围栏/引用/加粗/表格/空行分段', () => {
    expect(looksLikeMarkdown('# t')).toBe(true)
    expect(looksLikeMarkdown('- item')).toBe(true)
    expect(looksLikeMarkdown('```\ncode')).toBe(true)
    expect(looksLikeMarkdown('> quote')).toBe(true)
    expect(looksLikeMarkdown('**bold**')).toBe(true)
    expect(looksLikeMarkdown('| a | b |')).toBe(true)
    expect(looksLikeMarkdown('para1\n\npara2')).toBe(true)
  })

  it('普通文本/空文本不误判', () => {
    expect(looksLikeMarkdown('just a plain sentence')).toBe(false)
    expect(looksLikeMarkdown('')).toBe(false)
    expect(looksLikeMarkdown('   ')).toBe(false)
  })
})
