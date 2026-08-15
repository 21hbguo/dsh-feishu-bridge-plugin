/**
 * Pure text helpers ported from bridge.mjs M10: @-mention stripping,
 * over-length truncation, and compact token-count formatting.
 */
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'

/** Strip every @-mention key from a message body (bridge.mjs stripMentions). */
export function stripMentions(msg: NormalizedMessage): string {
  let text = msg.content ?? ''
  for (const m of msg.mentions ?? []) {
    if (m.key) text = text.replaceAll(m.key, '').replaceAll(`@${m.key}`, '')
  }
  return text.trim()
}

/** Truncate an over-long reply with a trailing notice (bridge.mjs truncate). */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n…(回复过长已截断)`
}

/** Compact token count, same shape as the web GUI: 517 / 12.2K / 517K / 1.2M. */
export function formatTokens(n: number): string {
  const scaled = (v: number) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** One-line whitespace-collapsed excerpt, capped (bridge.mjs excerpt). */
export function excerpt(s: string, max = 60): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t === '' ? '' : t.length > max ? `${t.slice(0, max)}…` : t
}

/** First sentence of a reply (split at sentence-ending punctuation), capped. */
export function firstSentence(s: string, max = 60): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  if (t === '') return ''
  const m = t.match(/^.*?[。！？!?\n]/)
  const first = (m !== null ? m[0] : t).trim()
  return first === '' ? '' : first.length > max ? `${first.slice(0, max)}…` : first
}
