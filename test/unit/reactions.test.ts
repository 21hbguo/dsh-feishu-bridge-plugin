/**
 * P1 表情回执单元测试（vitest）。
 *
 * 被测功能与来源：src/reactions.ts「表情回执选择逻辑」（180 枚飞书实测 emoji
 * 全集过滤 + pickReaction/doneReaction、大小写敏感、空池回退）——commit
 * b07a1d4「feat: 表情回执模块——飞书实测 emoji 全集过滤 + pickReaction/
 * doneReaction（借鉴 lark-link MIT）」。
 *
 * 纯函数模块，无 IO；随机池行为用多次抽样断言（恒非 DONE、恒在池内）。
 */
import { describe, expect, it } from 'vitest'
import {
  DONE_EMOJI,
  DEFAULT_RANDOM_POOL,
  VALID_EMOJI_TYPES,
  doneReaction,
  isFeishuEmoji,
  pickReaction,
} from '../../src/reactions.js'

describe('reactions 合法集合', () => {
  it('VALID_EMOJI_TYPES 恰为 180 枚（飞书实测全集）', () => {
    expect(VALID_EMOJI_TYPES.size).toBe(180)
  })

  it('DONE_EMOJI 恒为 "DONE" 且是合法值', () => {
    expect(DONE_EMOJI).toBe('DONE')
    expect(VALID_EMOJI_TYPES.has(DONE_EMOJI)).toBe(true)
    expect(doneReaction()).toBe('DONE')
    expect(isFeishuEmoji(doneReaction())).toBe(true)
  })

  it('isFeishuEmoji 大小写敏感：Fire 有效、FIRE 无效', () => {
    expect(isFeishuEmoji('Fire')).toBe(true)
    expect(isFeishuEmoji('FIRE')).toBe(false)
    expect(isFeishuEmoji('THUMBSUP')).toBe(true)
    expect(isFeishuEmoji('thumbsup')).toBe(false)
    expect(isFeishuEmoji('ROCKET')).toBe(false) // 非飞书合法 emoji_type
    expect(isFeishuEmoji('')).toBe(false)
  })

  it('默认随机池全部合法且不含 DONE', () => {
    for (const t of DEFAULT_RANDOM_POOL) {
      expect(VALID_EMOJI_TYPES.has(t)).toBe(true)
      expect(t).not.toBe(DONE_EMOJI)
    }
  })
})

describe('reactions pickReaction 选择逻辑', () => {
  it('默认池抽样：多次抽取均落在默认池内且合法', () => {
    for (let i = 0; i < 100; i++) {
      const r = pickReaction()
      expect(r).toBeDefined()
      expect(DEFAULT_RANDOM_POOL).toContain(r)
      expect(isFeishuEmoji(r!)).toBe(true)
      expect(r).not.toBe(DONE_EMOJI)
    }
  })

  it('自定义池：非法项被剔除，只返回合法项', () => {
    const r = pickReaction(['THUMBSUP', 'NOT_A_REAL_EMOJI', 'DONE', 'OK'])
    expect(['THUMBSUP', 'OK']).toContain(r)
  })

  it('自定义池全非法 → 回退默认池', () => {
    for (let i = 0; i < 50; i++) {
      const r = pickReaction(['INVALID1', 'INVALID2'])
      expect(DEFAULT_RANDOM_POOL).toContain(r)
    }
  })

  it('自定义池只有 DONE → 回退默认池（永不返回完成标记）', () => {
    for (let i = 0; i < 50; i++) {
      const r = pickReaction(['DONE'])
      expect(r).not.toBe(DONE_EMOJI)
      expect(DEFAULT_RANDOM_POOL).toContain(r)
    }
  })

  it('空池 → 回退默认池', () => {
    const r = pickReaction([])
    expect(DEFAULT_RANDOM_POOL).toContain(r)
  })

  it('单元素合法池 → 恒定返回该元素', () => {
    for (let i = 0; i < 20; i++) {
      expect(pickReaction(['HEART'])).toBe('HEART')
    }
  })
})
