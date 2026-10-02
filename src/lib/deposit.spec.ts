import { describe, expect, it } from 'vitest'
import { HEADSET_DEPOSIT, SURCHARGE_DEPOSIT } from '@/data/museum'
import { seedReservations } from '@/data/seed'
import { confirmedLostCount, resolveDepositRate } from '@/lib/deposit'

describe('押金费率策略 resolveDepositRate', () => {
  const list = seedReservations()

  it('学校 / 企业团始终执行标准押金，即使有遗失记录也不加收', () => {
    const rate = resolveDepositRate('school', '某校', list, '2026-10-01T12:00:00')
    expect(rate.perUnit).toBe(HEADSET_DEPOSIT)
    expect(rate.risk).toBe(false)
  })

  it('旅行社无历史遗失记录时执行标准押金', () => {
    const rate = resolveDepositRate('travel', '无记录旅行社', list, '2026-10-01T12:00:00')
    expect(rate.perUnit).toBe(HEADSET_DEPOSIT)
    expect(rate.risk).toBe(false)
  })

  it('星辉国际旅行社有 1 台当场赔付的确认遗失，后续团按加收费率', () => {
    const rate = resolveDepositRate('travel', '星辉国际旅行社', list, '2026-10-01T10:30:00')
    expect(rate.risk).toBe(true)
    expect(rate.perUnit).toBe(SURCHARGE_DEPOSIT)
    expect(rate.lostCount).toBe(1)
    expect(rate.reason).toContain('加收')
  })

  it('只统计指定时间之前的历史，当前预约自身不会被计入', () => {
    // R7 09:22 结案：在 09:00 时还没有遗失记录
    const before = resolveDepositRate('travel', '星辉国际旅行社', list, '2026-10-01T09:00:00')
    expect(before.risk).toBe(false)
    // 在 10:30 后续团确认时已能查到
    const after = resolveDepositRate('travel', '星辉国际旅行社', list, '2026-10-01T10:30:00')
    expect(after.risk).toBe(true)
  })

  it('鸿雁国旅仅有 1 台暂扣待保洁结果（未结案），不计为确认遗失，暂不加收', () => {
    expect(confirmedLostCount(list, '鸿雁国际旅行社')).toBe(0)
    const rate = resolveDepositRate('travel', '鸿雁国际旅行社', list, '2026-10-01T12:00:00')
    expect(rate.risk).toBe(false)
  })
})
