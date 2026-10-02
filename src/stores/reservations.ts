import { defineStore } from 'pinia'
import { DAMAGE_FEE, HEADSET_DEPOSIT, LOST_FEE, REPAIR_FEE_DEFAULT } from '@/data/museum'
import { seedReservations } from '@/data/seed'
import { resolveDepositRate } from '@/lib/deposit'
import {
  buildRoute,
  plannedDuration,
} from '@/lib/schedule'
import { addHM, hmOfISO, toMin, uid } from '@/lib/time'
import { useMuseumStore } from './museum'
import type {
  AgeBand,
  EventKind,
  FoundOutcome,
  GroupType,
  HallClosure,
  Language,
  LostDeviceRecord,
  LostResolution,
  Reservation,
  ReservationStatus,
  RouteStop,
  TimelineEvent,
} from '@/types'

export interface NewReservationInput {
  orgType: GroupType
  orgName: string
  groupSize: number
  ageBand: AgeBand
  language: Language
  accessible: boolean
  themeId: string
  arriveTime: string // ISO
  contactName: string
  contactPhone: string
  busInfo: string
  needHeadsets: boolean
  headsetCount: number
  note: string
}

export const useReservationsStore = defineStore('reservations', {
  state: () => ({
    list: seedReservations() as Reservation[],
  }),

  getters: {
    byId: (s) => (id: string) => s.list.find((r) => r.id === id),
    byStatus: (s) => (status: ReservationStatus) =>
      [...s.list]
        .filter((r) => r.status === status)
        .sort((a, b) => a.arriveTime.localeCompare(b.arriveTime)),
    /** 当日讲解总时长（分钟），已确认+在馆团 */
    activeList: (s) =>
      s.list.filter((r) => ['confirmed', 'arrived', 'touring'].includes(r.status)),
    /** 全馆尚未结案的遗失登记（保洁查找中/团队现场寻找中） */
    pendingLostReports(s): LostDeviceRecord[] {
      return s.list.flatMap((r) => (r.lostDevices ?? []).filter((l) => l.outcome === 'pending'))
    },
    /** 存在未决遗失登记、尚不能完成押金结算/离馆的预约 */
    reservationsWithPendingLost(s): Reservation[] {
      return s.list.filter((r) => (r.lostDevices ?? []).some((l) => l.outcome === 'pending'))
    },
  },

  actions: {
    // ---------- 基础工具 ----------
    log(r: Reservation, kind: EventKind, title: string, atISO: string, by: string, extra: Partial<TimelineEvent> = {}) {
      const e: TimelineEvent = { id: uid('ev'), at: atISO, kind, title, by, ...extra }
      r.timeline.push(e)
      r.timeline.sort((a, b) => a.at.localeCompare(b.at))
    },
    refreshDuration(r: Reservation) {
      r.durationMin = plannedDuration(r.route)
    },

    // ---------- 预约方 ----------
    create(input: NewReservationInput): Reservation {
      const museum = useMuseumStore()
      const theme = museum.themeById(input.themeId)!
      const enterHM = addHM(hmOfISO(input.arriveTime), 10) // 安检+集结 10 分钟
      const route = buildRoute(theme, museum.halls, enterHM, {
        accessible: input.accessible,
        live: museum.maintenance,
      })
      const seq = String(this.list.length + 1).padStart(2, '0')
      const rate = resolveDepositRate(input.orgType, input.orgName, this.list, input.arriveTime)
      const r: Reservation = {
        id: `R20261001-${seq}`,
        ...input,
        status: 'submitted',
        createdAt: museum.nowISO,
        assignedGuideIds: [],
        route,
        durationMin: plannedDuration(route),
        devices: [],
        depositPerUnit: rate.perUnit,
        depositTotal: 0,
        depositDeduction: 0,
        lostDevices: [],
        timeline: [],
      }
      // 避免 id 冲突
      while (this.list.some((x) => x.id === r.id)) {
        r.id = `${r.id}X`
      }
      this.log(r, 'submit', '团体预约已提交', input.arriveTime, input.contactName, {
        detail: `${input.groupSize} 人 · ${theme.name}`,
      })
      this.list.unshift(r)
      return r
    },

    cancel(id: string, by: string) {
      const r = this.byId(id)
      if (!r || ['completed', 'cancelled'].includes(r.status)) return
      r.status = 'cancelled'
      this.log(r, 'cancel', '预约已取消', useMuseumStore().nowISO, by)
    },

    addComplaint(id: string, text: string, by: string) {
      const r = this.byId(id)
      if (!r) return
      r.complaint = text
      this.log(r, 'complaint', '投诉登记：' + text, useMuseumStore().nowISO, by)
    },
    replyComplaint(id: string, reply: string, by: string) {
      const r = this.byId(id)
      if (!r) return
      r.complaintReply = reply
      this.log(r, 'complaint', '馆方已答复投诉', useMuseumStore().nowISO, by, { detail: reply })
    },

    // ---------- 馆方确认 ----------
    confirm(
      id: string,
      payload: { guideIds: string[]; laneId: string; batchNo: string; note: string },
      by: string,
    ) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || r.status !== 'submitted') return
      r.status = 'confirmed'
      r.confirmedAt = museum.nowISO
      r.assignedGuideIds = payload.guideIds
      r.securityLane = payload.laneId
      r.batchNo = payload.batchNo
      r.confirmNote = payload.note
      const names = payload.guideIds.map((g) => museum.guideById(g)?.name).join('、')
      this.log(r, 'confirm', `预约确认：${names} / ${payload.batchNo} 批次`, museum.nowISO, by, {
        detail: payload.note,
      })
    },

    reject(id: string, reason: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || r.status !== 'submitted') return
      r.status = 'rejected'
      this.log(r, 'reject', '预约驳回：' + reason, museum.nowISO, by)
    },

    // ---------- 前台到馆 ----------
    markArrived(id: string, atISO?: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || r.status !== 'confirmed') return
      r.status = 'arrived'
      r.actualArrive = atISO ?? museum.nowISO
      const plan = hmOfISO(r.arriveTime)
      const actual = hmOfISO(r.actualArrive)
      const delta = toMin(actual) - toMin(plan)
      this.log(r, 'arrive', `团队到馆（${delta === 0 ? '准时' : delta > 0 ? `迟到 ${delta} 分钟` : `早到 ${-delta} 分钟`}）`, r.actualArrive, r.contactName)
    },

    verifyHeadcount(id: string, n: number, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      r.verifiedSize = n
      const diff = n - r.groupSize
      this.log(
        r,
        'headcount',
        `前台核验人数：${n} 人${diff === 0 ? '，与预约一致' : diff > 0 ? `，比预约多 ${diff} 人` : `，比预约少 ${-diff} 人`}`,
        museum.nowISO,
        by,
      )
    },

    /** 查某团体类型/单位当前适用的押金费率（确认台、前台展示用） */
    depositRateFor(orgType: GroupType, orgName: string) {
      return resolveDepositRate(orgType, orgName, this.list, useMuseumStore().nowISO)
    },

    handoutHeadsets(id: string, count: number, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || !r.needHeadsets) return
      const at = museum.nowISO
      // 发放瞬间按该单位最新风险记录确定费率（覆盖创建后产生新遗失记录的情况）
      r.depositPerUnit = resolveDepositRate(r.orgType, r.orgName, this.list, at).perUnit
      const picked = museum.lendFromPool(count, r.id, at, r.depositPerUnit)
      r.devices = picked
      r.depositTotal = picked.length * r.depositPerUnit
      const codes = picked.length ? `${picked[0].code} ~ ${picked[picked.length - 1].code}` : ''
      this.log(r, 'device_handout', `发放耳麦 ${picked.length} 台（${codes}）`, at, by, {
        amount: r.depositTotal,
        detail: `按 ¥${r.depositPerUnit}/台 收取押金 ¥${r.depositTotal.toLocaleString()}${picked.length < count ? '，库存不足部分未发' : ''}`,
      })
    },

    admit(id: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || r.status !== 'arrived') return
      const now = museum.nowHM
      r.status = 'touring'
      const first = r.route.find((s) => s.state === 'planned')
      if (first) {
        first.state = 'current'
        first.actualEnter = now
      }
      this.log(r, 'batch_admit', `${r.batchNo ?? ''} 批次安检入馆`, museum.nowISO, by)
      this.log(r, 'start_tour', `${museum.themeById(r.themeId)?.name ?? ''}开始讲解`, museum.nowISO, museum.guideById(r.assignedGuideIds[0])?.name ?? by)
    },

    // ---------- 途中调度 ----------
    /** 当前站打卡完成，进入下一站 */
    advanceStop(id: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const idx = r.route.findIndex((s) => s.state === 'current')
      if (idx < 0) return
      const cur = r.route[idx]
      cur.state = 'done'
      cur.actualLeave = museum.nowHM
      const next = r.route.slice(idx + 1).find((s) => s.state === 'planned')
      if (next) {
        next.state = 'current'
        next.actualEnter = addHM(museum.nowHM, 5)
      }
      this.log(r, 'wait', `完成「${museum.hallById(cur.hallId)?.name}」参观，转入下一展厅`, museum.nowISO, by)
    },

    /** 团体迟到 / 儿童走散暂停：整体顺延后续计划 */
    delay(id: string, minutes: number, kind: EventKind, title: string, detail: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      for (const s of r.route) {
        if (s.actualEnter || s.state === 'skipped' || s.state === 'maintenance') continue
        s.plannedEnter = addHM(s.plannedEnter, minutes)
        s.plannedLeave = addHM(s.plannedLeave, minutes)
      }
      this.refreshDuration(r)
      this.log(r, kind, title, museum.nowISO, by, { detail: `后续展厅整体顺延 ${minutes} 分钟。${detail}` })
    },

    childLost(id: string, childName: string, pauseMin: number, resolved: boolean, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      this.log(r, 'child_lost', `${resolved ? '儿童走散已找回' : '报告儿童走散'}：${childName}`, museum.nowISO, by, {
        detail: resolved ? `暂停参观 ${pauseMin} 分钟后继续，已通知广播与安保。` : '已通知广播与安保，暂停前进。',
      })
      if (resolved && pauseMin > 0) {
        this.delay(id, pauseMin, 'wait', `等待走散儿童归队（${pauseMin} 分钟）`, '', by)
      }
    },

    /** 展厅拥堵登记（只记录，改道在 applyReroute 中执行） */
    markCongestion(id: string, hallId: string, note: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const stop = r.route.find((s) => s.hallId === hallId && ['current', 'planned'].includes(s.state))
      if (stop) {
        stop.state = 'congested'
        stop.note = note
      }
      this.log(r, 'hall_congestion', `「${museum.hallById(hallId)?.name}」拥堵，启动分流`, museum.nowISO, by, {
        detail: note,
      })
    },

    /** 展厅临时维护：写入全局状态，并把所有在馆/待入场团受影响的站点标记维护 */
    declareMaintenance(hallId: string, closure: HallClosure, by: string) {
      const museum = useMuseumStore()
      museum.setMaintenance(hallId, closure)
      for (const r of this.list) {
        if (!['confirmed', 'arrived', 'touring'].includes(r.status)) continue
        for (const s of r.route) {
          if (s.hallId !== hallId || s.state === 'done' || s.state === 'skipped') continue
          const win = s.actualEnter ?? s.plannedEnter
          if (win < closure.end && s.plannedLeave > closure.start) {
            s.state = 'maintenance'
            s.note = `${closure.reason}（${closure.start}-${closure.end}），临时维护改道`
            this.log(r, 'maintenance', `「${museum.hallById(hallId)?.name}」临时维护（${closure.start}-${closure.end}）`, museum.nowISO, by, {
              detail: closure.reason,
            })
          }
        }
      }
    },

    /**
     * 改道：在被阻站点位置插入替代展厅，并顺延后续
     */
    applyReroute(
      id: string,
      payload: { blockedHallId: string; targetHallId: string; atHM: string; durationMin: number; reason: string },
      by: string,
    ) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const idx = r.route.findIndex(
        (s) => s.hallId === payload.blockedHallId && s.state !== 'done' && s.state !== 'skipped',
      )
      const blocked = idx >= 0 ? r.route[idx] : undefined
      if (blocked) {
        if (blocked.state === 'current') blocked.actualLeave = payload.atHM
        blocked.state = blocked.state === 'maintenance' ? 'maintenance' : 'congested'
        blocked.note = `${blocked.note ?? ''} 改道原因：${payload.reason}`.trim()
      }
      const target = museum.hallById(payload.targetHallId)!
      const fresh: RouteStop = {
        hallId: payload.targetHallId,
        plannedEnter: payload.atHM,
        plannedLeave: addHM(payload.atHM, payload.durationMin),
        durationMin: payload.durationMin,
        state: 'current',
        actualEnter: payload.atHM,
        note: `由${museum.hallById(payload.blockedHallId)?.name ?? ''}改道至此：${payload.reason}`,
      }
      const insertAt = idx >= 0 ? idx : r.route.length
      r.route.splice(insertAt, 0, fresh)
      // 后续计划站顺延
      let cursor = fresh.plannedLeave
      for (let i = insertAt + 1; i < r.route.length; i++) {
        const s = r.route[i]
        if (s.actualEnter || s.state === 'skipped' || s.state === 'maintenance') continue
        s.state = 'planned'
        s.plannedEnter = addHM(cursor, 5)
        s.plannedLeave = addHM(s.plannedEnter, s.durationMin)
        cursor = s.plannedLeave
      }
      this.refreshDuration(r)
      this.log(
        r,
        'reroute',
        `路线调整：${museum.hallById(payload.blockedHallId)?.name ?? '原站'} → ${target.name}`,
        museum.nowISO,
        by,
        { detail: `${payload.reason}；后续团队入场时间已联动顺延。` },
      )
    },

    /** 讲解员临时替换 */
    swapGuide(id: string, oldGuideId: string, newGuideId: string, reason: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const pos = r.assignedGuideIds.indexOf(oldGuideId)
      if (pos >= 0) r.assignedGuideIds.splice(pos, 1, newGuideId)
      else r.assignedGuideIds.push(newGuideId)
      const oldN = museum.guideById(oldGuideId)?.name ?? oldGuideId
      const newN = museum.guideById(newGuideId)?.name ?? newGuideId
      this.log(r, 'guide_swap', `讲解员变更：${oldN} → ${newN}`, museum.nowISO, newN, {
        detail: reason,
      })
    },

    /** 途中耳麦损坏：旧机登记损坏、补发新机 */
    exchangeHeadset(id: string, oldCode: string, note: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const newCode = museum.exchangeFromPool(oldCode, r.id, museum.nowISO, note, r.depositPerUnit || museum.depositPerUnit)
      const oldDev = r.devices.find((d) => d.code === oldCode)
      if (oldDev) {
        oldDev.status = 'damaged'
        oldDev.damageFee = DAMAGE_FEE
        oldDev.note = note
      }
      if (newCode) {
        r.devices.push({
          code: newCode,
          status: 'lent',
          deposit: r.depositPerUnit || museum.depositPerUnit,
          resId: r.id,
          lentAt: museum.nowISO,
        })
      }
      this.log(r, 'device_exchange', `耳麦 ${oldCode} 损坏${newCode ? `，补发 ${newCode}` : '（库存不足，未补发）'}`, museum.nowISO, by, {
        detail: `${note}；赔偿待离馆押金结算。`,
      })
    },

    // ---------- 离馆：耳麦遗失登记与押金处置 ----------
    /**
     * 离馆清点：完好/损坏即时同步库存；
     * 标记为「遗失」的设备：若已在遗失处置档案中登记（现场寻找/押金暂扣），保持其处置状态，
     * 否则按团队当场选择「赔付」直接结案（押金按该台押金费率全额扣除）。
     */
    returnDevices(
      id: string,
      results: { code: string; result: 'ok' | 'damaged' | 'lost'; note?: string }[],
      by: string,
    ) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const at = museum.nowISO
      let okN = 0
      let dmgN = 0
      let lostN = 0
      for (const item of results) {
        const dev = r.devices.find((d) => d.code === item.code)
        if (!dev) continue
        const existing = (r.lostDevices ?? []).find((l) => l.code === item.code)
        if (item.result === 'ok') {
          dev.status = 'returned'
          dev.returnedAt = at
          museum.syncPoolDevice(item.code, 'returned', { returnedAt: at })
          okN++
        } else if (item.result === 'damaged') {
          dev.status = 'damaged'
          dev.damageFee = DAMAGE_FEE
          dev.note = item.note ?? '设备损坏'
          dev.returnedAt = at
          museum.syncPoolDevice(item.code, 'damaged', {
            returnedAt: at,
            damageFee: DAMAGE_FEE,
            note: item.note,
          })
          dmgN++
        } else {
          lostN++
          if (!existing) {
            // 未走暂扣流程：直接按当场赔付登记结案
            const rec: LostDeviceRecord = {
              key: uid('lost'),
              code: item.code,
              borrower: r.contactName,
              leader: r.contactName,
              lastHallId: r.route[r.route.length - 1]?.hallId ?? '',
              note: item.note ?? '离馆清点缺失，团队当场赔付',
              reportedAt: at,
              resolution: 'paid',
              withheldAmount: dev.deposit || r.depositPerUnit || LOST_FEE,
              paidAt: at,
              resolvedAt: at,
              outcome: 'forfeit',
            }
            r.lostDevices.push(rec)
            dev.status = 'lost'
            dev.damageFee = rec.withheldAmount
            dev.note = rec.note
            museum.markPoolLost(item.code, rec.note)
            this.log(r, 'device_lost_report', `耳麦 ${item.code} 遗失，团队选择当场赔付`, at, by, {
              amount: rec.withheldAmount,
              detail: `${rec.note}；扣除押金 ¥${rec.withheldAmount} 结案。`,
            })
          }
        }
      }
      this.recomputeDepositDeduction(r)
      this.log(r, 'device_return', `归还耳麦：完好 ${okN}，损坏 ${dmgN}，遗失 ${lostN}`, at, by)
    },

    /** 登记一台缺失耳麦：设备编号、借出人、团队负责人、最后使用展厅 + 团队处置选择 */
    reportLostDevice(
      id: string,
      payload: {
        code: string
        borrower: string
        leader: string
        lastHallId: string
        note?: string
        resolution: LostResolution
      },
      by: string,
    ): LostDeviceRecord | null {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return null
      const at = museum.nowISO
      const dev = r.devices.find((d) => d.code === payload.code)
      const amount = dev?.deposit || r.depositPerUnit || LOST_FEE
      // 同一台设备重复登记时覆盖原档案
      let rec = r.lostDevices.find((l) => l.code === payload.code)
      if (!rec) {
        rec = {
          key: uid('lost'),
          code: payload.code,
          borrower: payload.borrower,
          leader: payload.leader,
          lastHallId: payload.lastHallId,
          note: payload.note,
          reportedAt: at,
          resolution: payload.resolution,
          withheldAmount: amount,
          outcome: 'pending',
        }
        r.lostDevices.push(rec)
      } else {
        rec.borrower = payload.borrower
        rec.leader = payload.leader
        rec.lastHallId = payload.lastHallId
        rec.note = payload.note
        rec.reportedAt = at
        rec.resolution = payload.resolution
        rec.withheldAmount = amount
        rec.outcome = 'pending'
        rec.foundAt = rec.foundOutcome = rec.repairFee = rec.foundBy = rec.resolvedAt = rec.paidAt = undefined
      }
      const hallName = museum.hallById(payload.lastHallId)?.name ?? '未登记展厅'
      this.log(
        r,
        'device_lost_report',
        `耳麦 ${payload.code} 离馆缺失：借出人 ${payload.borrower} / 负责人 ${payload.leader} / 最后使用 ${hallName}`,
        at,
        by,
        { detail: payload.note },
      )
      this.applyLostResolution(r, rec, payload.resolution, by)
      return rec
    },

    /** 团队改变处置方式：现场寻找 ↔ 押金暂扣 / 当场赔付 */
    changeLostResolution(id: string, key: string, resolution: LostResolution, by: string) {
      const r = this.byId(id)
      if (!r) return
      const rec = r.lostDevices.find((l) => l.key === key)
      if (!rec) return
      rec.resolution = resolution
      // 从已结案状态重新打开（如赔付改暂扣的纠正场景）
      rec.outcome = 'pending'
      rec.resolvedAt = rec.paidAt = rec.foundAt = rec.foundOutcome = rec.repairFee = undefined
      this.applyLostResolution(r, rec, resolution, by)
    },

    /** 按团队选择推进遗失档案状态 */
    applyLostResolution(r: Reservation, rec: LostDeviceRecord, resolution: LostResolution, by: string) {
      const museum = useMuseumStore()
      const at = museum.nowISO
      const dev = r.devices.find((d) => d.code === rec.code)
      if (resolution === 'searching') {
        // 现场寻找：设备责任仍在团，恢复借出状态（但未决门禁保证团队无法带着未结设备离馆）
        rec.outcome = 'pending'
        if (dev) {
          dev.status = 'lent'
          dev.damageFee = undefined
        }
        museum.syncPoolDevice(rec.code, 'lent', { resId: r.id })
        this.log(r, 'deposit_withhold', `耳麦 ${rec.code} 团队选择现场寻找，暂不结算该台押金`, at, by)
      } else if (resolution === 'withheld') {
        rec.outcome = 'pending'
        if (dev) {
          dev.status = 'lost'
          dev.note = `遗失暂扣：借出人 ${rec.borrower}，最后使用 ${museum.hallById(rec.lastHallId)?.name ?? '—'}`
        }
        museum.markPoolLost(rec.code, `离馆缺失待保洁查找，最后见于 ${museum.hallById(rec.lastHallId)?.name ?? '—'}`)
        this.log(r, 'deposit_withhold', `耳麦 ${rec.code} 押金暂扣 ¥${rec.withheldAmount}，等待保洁查找结果`, at, by, {
          amount: rec.withheldAmount,
          detail: '找回完好全额退还；找回损坏扣除维修费；确认无法找回则押金不退。',
        })
      } else {
        // 当场赔付：押金按该台费率全额扣除结案
        rec.outcome = 'forfeit'
        rec.paidAt = at
        rec.resolvedAt = at
        if (dev) {
          dev.status = 'lost'
          dev.damageFee = rec.withheldAmount
        }
        museum.markPoolLost(rec.code, rec.note)
        this.log(r, 'deposit_withhold', `耳麦 ${rec.code} 团队当场赔付，扣除押金 ¥${rec.withheldAmount} 结案`, at, by, {
          amount: rec.withheldAmount,
        })
      }
      this.recomputeDepositDeduction(r)
    },

    /** 保洁找回设备：按核验设备状态决定退还押金或扣除维修费 */
    resolveLostFound(
      id: string,
      key: string,
      payload: { outcome: FoundOutcome; repairFee?: number; note?: string; foundBy?: string },
      by: string,
    ) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const rec = r.lostDevices.find((l) => l.key === key)
      if (!rec || rec.outcome !== 'pending') return
      const at = museum.nowISO
      const dev = r.devices.find((d) => d.code === rec.code)
      rec.foundAt = at
      rec.foundBy = payload.foundBy
      rec.foundOutcome = payload.outcome
      rec.resolvedAt = at
      if (payload.outcome === 'intact') {
        rec.outcome = 'refund'
        rec.repairFee = undefined
        if (dev) {
          dev.status = 'returned'
          dev.damageFee = undefined
          dev.returnedAt = at
          dev.note = `保洁找回，设备完好${payload.note ? `：${payload.note}` : ''}`
        }
        museum.resolvePoolFound(rec.code, 'intact', at, { note: payload.note, foundBy: payload.foundBy })
        this.log(r, 'device_found', `保洁找回耳麦 ${rec.code}，核验完好，暂扣押金 ¥${rec.withheldAmount} 全额退还`, at, by, {
          detail: payload.foundBy ? `找回人：${payload.foundBy}` : undefined,
        })
      } else {
        const fee = payload.repairFee ?? REPAIR_FEE_DEFAULT
        rec.outcome = 'repair'
        rec.repairFee = fee
        if (dev) {
          dev.status = 'repairing'
          dev.damageFee = fee
          dev.returnedAt = at
          dev.note = `保洁找回但已损坏，扣维修费 ¥${fee}${payload.note ? `：${payload.note}` : ''}`
        }
        museum.resolvePoolFound(rec.code, 'repair', at, {
          note: payload.note,
          repairFee: fee,
          foundBy: payload.foundBy,
        })
        this.log(r, 'device_found', `保洁找回耳麦 ${rec.code}，设备损坏需维修，扣除维修费 ¥${fee}、退还 ¥${rec.withheldAmount - fee}`, at, by, {
          amount: fee,
          detail: payload.note,
        })
      }
      this.recomputeDepositDeduction(r)
    },

    /** 保洁确认无法找回：暂扣押金转赔偿，不予退还 */
    confirmLostNotFound(id: string, key: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const rec = r.lostDevices.find((l) => l.key === key)
      if (!rec || rec.outcome !== 'pending') return
      rec.outcome = 'forfeit'
      rec.resolvedAt = museum.nowISO
      const dev = r.devices.find((d) => d.code === rec.code)
      if (dev) {
        dev.status = 'lost'
        dev.damageFee = rec.withheldAmount
      }
      museum.markPoolLost(rec.code, '保洁确认无法找回')
      this.log(r, 'device_found', `保洁确认耳麦 ${rec.code} 无法找回，暂扣押金 ¥${rec.withheldAmount} 不予退还`, museum.nowISO, by, {
        amount: rec.withheldAmount,
      })
      this.recomputeDepositDeduction(r)
    },

    /** 汇总最终扣款：损坏 ¥50/台 + 遗失赔付 + 找回损坏维修费；暂扣/寻找中未决暂不计入 */
    recomputeDepositDeduction(r: Reservation) {
      const pendingCodes = new Set(
        (r.lostDevices ?? []).filter((l) => l.outcome === 'pending').map((l) => l.code),
      )
      let sum = 0
      for (const d of r.devices) {
        if (pendingCodes.has(d.code)) continue
        if (d.status === 'damaged') sum += d.damageFee ?? DAMAGE_FEE
        else if (d.status === 'lost') sum += d.damageFee ?? LOST_FEE
        else if (d.status === 'repairing') sum += d.damageFee ?? REPAIR_FEE_DEFAULT
      }
      r.depositDeduction = sum
    },

    /** 尚未结案的遗失登记数（未决时不能结算押金/离馆） */
    pendingLostCount(id: string): number {
      const r = this.byId(id)
      return r ? r.lostDevices.filter((l) => l.outcome === 'pending').length : 0
    },

    settleDeposit(id: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      if ((r.lostDevices ?? []).some((l) => l.outcome === 'pending')) {
        this.log(r, 'deposit_settle', '押金暂不能结算：尚有耳麦遗失未结案（现场寻找/等待保洁结果）', museum.nowISO, by)
        return
      }
      const refund = r.depositTotal - r.depositDeduction
      this.log(
        r,
        'deposit_settle',
        `押金结算：¥${r.depositTotal.toLocaleString()} 中扣除 ¥${r.depositDeduction}，退还 ¥${refund.toLocaleString()}`,
        museum.nowISO,
        by,
        { amount: r.depositDeduction },
      )
    },

    complete(id: string, satisfaction: number, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || r.status !== 'touring') return
      if ((r.lostDevices ?? []).some((l) => l.outcome === 'pending')) return
      r.status = 'completed'
      r.departAt = museum.nowISO
      r.satisfaction = satisfaction
      // 未关闭的站点统一收尾
      for (const s of r.route) {
        if (s.state === 'current') {
          s.state = 'done'
          s.actualLeave = museum.nowHM
        } else if (s.state === 'planned') {
          s.state = 'skipped'
          s.note = (s.note ?? '') + ' 离馆时未参观'.trim()
        }
      }
      this.log(r, 'complete', `团队离馆，满意度 ${satisfaction}/5`, museum.nowISO, by)
    },

    resetAll() {
      const museum = useMuseumStore()
      museum.resetAll()
      this.list = seedReservations()
    },
  },

  persist: {
    key: 'museum-reservations',
    // 兼容旧版本持久化数据：反序列化后补齐遗失档案与押金费率字段
    serializer: {
      serialize: (v: unknown) => JSON.stringify(v),
      deserialize: (raw: string) => {
        const parsed = JSON.parse(raw) as { list?: Reservation[] }
        for (const r of parsed.list ?? []) {
          if (!Array.isArray(r.lostDevices)) r.lostDevices = []
          if (r.depositPerUnit == null) r.depositPerUnit = r.devices?.[0]?.deposit ?? HEADSET_DEPOSIT
        }
        return parsed
      },
    },
  },
})
