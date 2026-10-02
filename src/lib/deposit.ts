import { ELEVATED_DEPOSIT_RATE, HEADSET_DEPOSIT } from '@/data/museum'
import type { GroupType, Reservation } from '@/types'

/** 会计入旅行社信用的遗失状态：未结案（寻找中/暂扣中）与实际造成扣款（已赔付/找回损坏） */
const COUNTED_LOSS_STATES = new Set(['searching', 'held', 'paid', 'repaired'])

export interface OrgLossSummary {
  /** 遗失记录总数 */
  total: number
  /** 仍未结案（现场寻找中 / 押金暂扣中） */
  outstanding: number
  /** 已按遗失赔付 */
  paid: number
  /** 找回但已损坏，扣了维修费 */
  repaired: number
  /** 找回完好、押金已退（不影响信用） */
  refunded: number
  /** 是否存在影响后续押金等级的遗失记录 */
  hasCountedLoss: boolean
}

export function emptyLossSummary(): OrgLossSummary {
  return { total: 0, outstanding: 0, paid: 0, repaired: 0, refunded: 0, hasCountedLoss: false }
}

/**
 * 汇总某机构（按单位名称匹配）历史耳麦遗失档案。
 * selfId 用于排除当前预约自身——只有「之前的遗失记录」影响后续预约。
 */
export function orgLossSummary(
  reservations: Reservation[],
  orgName: string,
  selfId?: string,
): OrgLossSummary {
  const s = emptyLossSummary()
  for (const r of reservations) {
    if (r.id === selfId || r.orgName.trim() !== orgName.trim()) continue
    for (const loss of r.lostDevices ?? []) {
      s.total++
      if (loss.state === 'searching' || loss.state === 'held') s.outstanding++
      else if (loss.state === 'paid') s.paid++
      else if (loss.state === 'repaired') s.repaired++
      else if (loss.state === 'refunded') s.refunded++
      if (COUNTED_LOSS_STATES.has(loss.state)) s.hasCountedLoss = true
    }
  }
  return s
}

/**
 * 该机构本次预约的押金倍率：
 * 旅行社（orgType=travel）若有未结案或已造成扣款的耳麦遗失记录，后续按 1.5 倍收取；
 * 学校 / 企业及无遗失记录的旅行社维持 1 倍。
 */
export function depositRateFor(
  reservations: Reservation[],
  orgType: GroupType,
  orgName: string,
  selfId?: string,
): number {
  if (orgType !== 'travel' || !orgName.trim()) return 1
  const summary = orgLossSummary(reservations, orgName, selfId)
  return summary.hasCountedLoss ? ELEVATED_DEPOSIT_RATE : 1
}

/** 按倍率计算单台押金（倍率 1.5 → ¥300/台） */
export function depositPerUnit(rate: number): number {
  return Math.round(HEADSET_DEPOSIT * rate)
}
