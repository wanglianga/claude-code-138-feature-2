import { HEADSET_DEPOSIT, SURCHARGE_DEPOSIT } from '@/data/museum'
import type { GroupType, Reservation } from '@/types'

/**
 * 押金风险规则：
 * 旅行社历史上有「确认遗失」（当场赔付，或暂扣后保洁确认无法找回）的记录后，
 * 其后续团队借用耳麦按加收费率收取押金；学校 / 企业团始终执行标准费率。
 */

export interface DepositRate {
  /** 本团单台押金费率 */
  perUnit: number
  /** 是否触发加收 */
  risk: boolean
  /** 历史确认遗失次数 */
  lostCount: number
  reason: string
}

/** 该单位（旅行社）历史上已确认遗失的耳麦数：当场赔付，或暂扣后保洁确认无法找回 */
export function confirmedLostCount(list: Reservation[], orgName: string, beforeISO?: string): number {
  let n = 0
  for (const r of list) {
    if (r.orgName !== orgName) continue
    for (const l of r.lostDevices ?? []) {
      if (l.outcome !== 'forfeit') continue
      const at = l.resolvedAt ?? l.paidAt ?? r.departAt
      if (!beforeISO || (at !== undefined && at < beforeISO)) n++
    }
  }
  return n
}

/**
 * 计算某团体的耳麦押金费率。
 * @param beforeISO 仅统计该时间之前已结案的遗失（避免把尚未发生/当前预约自身计入历史）
 */
export function resolveDepositRate(
  orgType: GroupType,
  orgName: string,
  history: Reservation[],
  beforeISO?: string,
): DepositRate {
  if (orgType !== 'travel') {
    return { perUnit: HEADSET_DEPOSIT, risk: false, lostCount: 0, reason: '标准押金' }
  }
  const lostCount = confirmedLostCount(history, orgName, beforeISO)
  if (lostCount > 0) {
    return {
      perUnit: SURCHARGE_DEPOSIT,
      risk: true,
      lostCount,
      reason: `该旅行社历史确认遗失耳麦 ${lostCount} 台，本次押金按 ¥${SURCHARGE_DEPOSIT}/台 加收`,
    }
  }
  return { perUnit: HEADSET_DEPOSIT, risk: false, lostCount: 0, reason: '标准押金（无历史遗失记录）' }
}
