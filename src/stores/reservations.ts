import { defineStore } from 'pinia'
import { DAMAGE_FEE, LOST_FEE, REPAIR_FEE } from '@/data/museum'
import { seedReservations } from '@/data/seed'
import {
  buildRoute,
  plannedDuration,
} from '@/lib/schedule'
import { depositPerUnit, depositRateFor } from '@/lib/deposit'
import { addHM, hmOfISO, toMin, uid } from '@/lib/time'
import { useMuseumStore } from './museum'
import type {
  AgeBand,
  EventKind,
  GroupType,
  HallClosure,
  Language,
  LossDisposition,
  LostDeviceRecord,
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
    /** 全馆仍未结案的耳麦遗失档案（现场寻找中 / 押金暂扣中） */
    outstandingLosses(s): { res: Reservation; loss: LostDeviceRecord }[] {
      const out: { res: Reservation; loss: LostDeviceRecord }[] = []
      for (const r of s.list) {
        for (const loss of r.lostDevices ?? []) {
          if (loss.state === 'searching' || loss.state === 'held') out.push({ res: r, loss })
        }
      }
      return out.sort((a, b) => b.loss.reportedAt.localeCompare(a.loss.reportedAt))
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
      const rate = depositRateFor(this.list, input.orgType, input.orgName)
      const r: Reservation = {
        id: `R20261001-${seq}`,
        ...input,
        status: 'submitted',
        createdAt: museum.nowISO,
        assignedGuideIds: [],
        route,
        durationMin: plannedDuration(route),
        devices: [],
        depositTotal: 0,
        depositDeduction: 0,
        depositHeld: 0,
        depositRefunded: 0,
        depositRate: rate,
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

    handoutHeadsets(id: string, count: number, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || !r.needHeadsets) return
      const at = museum.nowISO
      const picked = museum.lendFromPool(count, r.id, at)
      const unit = depositPerUnit(r.depositRate)
      for (const d of picked) d.deposit = unit
      r.devices = picked
      r.depositTotal = picked.length * unit
      const codes = picked.length ? `${picked[0].code} ~ ${picked[picked.length - 1].code}` : ''
      const rateNote = r.depositRate > 1 ? `（该旅行社有耳麦遗失记录，押金按 ${r.depositRate} 倍 ¥${unit}/台收取）` : ''
      this.log(r, 'device_handout', `发放耳麦 ${picked.length} 台（${codes}）`, at, by, {
        amount: r.depositTotal,
        detail: `押金 ¥${r.depositTotal.toLocaleString()} 已收取${rateNote}${picked.length < count ? '，库存不足部分未发' : ''}`,
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
      const newCode = museum.exchangeFromPool(oldCode, r.id, museum.nowISO, note)
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
          deposit: depositPerUnit(r.depositRate),
          resId: r.id,
          lentAt: museum.nowISO,
        })
      }
      this.log(r, 'device_exchange', `耳麦 ${oldCode} 损坏${newCode ? `，补发 ${newCode}` : '（库存不足，未补发）'}`, museum.nowISO, by, {
        detail: `${note}；赔偿待离馆押金结算。`,
      })
    },

    // ---------- 离馆：设备归还 / 耳麦遗失押金处理 ----------
    /** 重算预约的押金两项：已确定扣款、暂扣中（已退金额在找回时累计） */
    recalcDeposit(r: Reservation) {
      let deduction = 0
      let held = 0
      for (const d of r.devices) {
        if (d.status === 'damaged' || d.status === 'repairing') deduction += d.damageFee ?? DAMAGE_FEE
        else if (d.status === 'lost') {
          const loss = (r.lostDevices ?? []).find((l) => l.code === d.code)
          if (!loss) deduction += LOST_FEE
          else if (loss.state === 'paid') deduction += loss.finalFee ?? LOST_FEE
          else if (loss.state === 'repaired') deduction += loss.finalFee ?? REPAIR_FEE
          else if (loss.state === 'held' || loss.state === 'searching') held += loss.heldAmount
          // refunded（找回完好）：无扣款，退还金额累计在 depositRefunded
        }
      }
      r.depositDeduction = deduction
      r.depositHeld = held
    },

    /**
     * 离馆逐台清点：完好 / 损坏直接结算；遗失当场赔付的直接建遗失档案结案。
     * 需要「现场寻找 / 押金暂扣」的遗失，请在清点后调用 reportLostDevice 走挂账流程。
     */
    returnDevices(
      id: string,
      results: { code: string; result: 'ok' | 'damaged' | 'lost'; note?: string }[],
      by: string,
    ) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      let okN = 0
      let dmgN = 0
      let lostN = 0
      for (const item of results) {
        const dev = r.devices.find((d) => d.code === item.code)
        if (!dev) continue
        if (item.result === 'ok') {
          dev.status = 'returned'
          dev.returnedAt = museum.nowISO
          museum.syncPoolDevice(item.code, 'returned', { returnedAt: museum.nowISO })
          okN++
        } else if (item.result === 'damaged') {
          dev.status = 'damaged'
          dev.damageFee = DAMAGE_FEE
          dev.note = item.note ?? '设备损坏'
          dev.returnedAt = museum.nowISO
          museum.syncPoolDevice(item.code, 'damaged', {
            returnedAt: museum.nowISO,
            damageFee: DAMAGE_FEE,
            note: item.note,
          })
          dmgN++
        } else {
          // 清点为遗失：默认建遗失档案（团队可在页面改为现场寻找/押金暂扣）
          const lastHallId =
            r.route.find((s) => s.state === 'current' || s.state === 'congested')?.hallId ??
            [...r.route].reverse().find((s) => s.state === 'done')?.hallId ??
            r.route[r.route.length - 1]?.hallId ??
            ''
          this.reportLostDevice(r.id, {
            code: item.code,
            borrower: item.note?.trim() || '离馆清点未找到使用人',
            teamLeader: r.contactName,
            lastHallId,
            note: '离馆清点设备缺失',
            disposition: 'paid',
          }, by)
          lostN++
        }
      }
      this.recalcDeposit(r)
      this.log(r, 'device_return', `归还耳麦：完好 ${okN}，损坏 ${dmgN}，遗失 ${lostN}`, museum.nowISO, by)
    },

    /**
     * 离馆发现耳麦缺失：前台标记设备编号、借出人、团队负责人、最后使用展厅，
     * 并选择处置方式：现场寻找 / 押金暂扣 / 当场赔付。
     */
    reportLostDevice(
      id: string,
      payload: {
        code: string
        borrower: string
        teamLeader: string
        lastHallId: string
        note: string
        disposition: LossDisposition
      },
      by: string,
    ): LostDeviceRecord | null {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return null
      const dev = r.devices.find((d) => d.code === payload.code)
      if (!dev) return null
      const at = museum.nowISO
      const unit = dev.deposit || depositPerUnit(r.depositRate)

      const record: LostDeviceRecord = {
        id: uid('loss'),
        code: payload.code,
        borrower: payload.borrower,
        teamLeader: payload.teamLeader,
        lastHallId: payload.lastHallId,
        reportedAt: at,
        note: payload.note,
        disposition: payload.disposition,
        state: payload.disposition === 'paid' ? 'paid' : payload.disposition === 'hold' ? 'held' : 'searching',
        heldAmount: payload.disposition === 'paid' ? 0 : unit,
        finalFee: payload.disposition === 'paid' ? LOST_FEE : undefined,
      }
      r.lostDevices.push(record)

      // 设备池同步为遗失挂账，损坏/遗失设备不会再被分配给下一场团队
      const poolNote = `${payload.note}；借出人 ${payload.borrower}；负责人 ${payload.teamLeader}；最后使用 ${museum.hallById(payload.lastHallId)?.name ?? '—'}`
      if (payload.disposition === 'paid') museum.markPoolPaidLost(payload.code, poolNote)
      else museum.markPoolLost(payload.code, r.id, poolNote)
      dev.status = 'lost'
      dev.resId = undefined
      dev.lostResId = r.id
      dev.damageFee = payload.disposition === 'paid' ? LOST_FEE : undefined
      dev.returnedAt = undefined
      dev.note = `遗失：${payload.note}`

      const hallName = museum.hallById(payload.lastHallId)?.name ?? '—'
      this.log(
        r,
        'device_lost_report',
        `耳麦 ${payload.code} 离馆清点缺失（${payload.disposition === 'paid' ? '当场赔付' : payload.disposition === 'hold' ? '押金暂扣' : '现场寻找'}）`,
        at,
        by,
        {
          amount: payload.disposition === 'paid' ? LOST_FEE : unit,
          detail: `借出人：${payload.borrower}；团队负责人：${payload.teamLeader}；最后使用展厅：${hallName}。${payload.note}`,
        },
      )
      if (payload.disposition === 'hold' || payload.disposition === 'search') {
        this.log(
          r,
          'deposit_held',
          payload.disposition === 'hold'
            ? `押金暂扣 ¥${unit}：等待保洁核查 ${payload.code}`
            : `团队现场寻找 ${payload.code}，押金 ¥${unit} 暂缓结算`,
          at,
          by,
          { amount: unit },
        )
      }
      this.recalcDeposit(r)
      return record
    },

    /**
     * 保洁后续找回设备：按设备状态决定退还押金或扣除维修费。
     * - condition=ok：完好找回，暂扣押金全额退还；
     * - condition=damaged：找回但损坏，扣除维修费 ¥50，余额退还。
     * 「寻找未果」可传 found=false 转当场赔付（扣 ¥200）。
     */
    resolveLostDevice(
      id: string,
      lossId: string,
      payload: { found: boolean; condition?: 'ok' | 'damaged'; note?: string; foundBy?: string },
      by: string,
    ) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const loss = r.lostDevices.find((l) => l.id === lossId)
      if (!loss || ['paid', 'refunded', 'repaired'].includes(loss.state)) return
      const at = museum.nowISO
      const dev = r.devices.find((d) => d.code === loss.code)
      const unit = loss.heldAmount || dev?.deposit || depositPerUnit(r.depositRate)

      if (payload.found && payload.condition === 'ok') {
        loss.state = 'refunded'
        loss.foundAt = at
        loss.foundCondition = 'ok'
        loss.foundBy = payload.foundBy ?? '保洁'
        loss.resolvedNote = payload.note
        loss.finalFee = 0
        if (dev) {
          dev.status = 'returned'
          dev.returnedAt = at
          dev.damageFee = 0
          dev.note = `保洁找回，设备完好：${payload.note ?? ''}`.trim()
        }
        museum.resolvePoolFound(loss.code, 'ok', at, payload.foundBy ?? '保洁', payload.note)
        r.depositRefunded += unit
        this.log(r, 'device_found', `${payload.foundBy ?? '保洁'}找回 ${loss.code}，设备完好`, at, payload.foundBy ?? '保洁', {
          detail: payload.note ? `找回位置/情况：${payload.note}` : undefined,
        })
        this.log(r, 'deposit_refund', `暂扣押金 ¥${unit} 全额退还 ${r.orgName}`, at, by, { amount: unit })
      } else if (payload.found && payload.condition === 'damaged') {
        loss.state = 'repaired'
        loss.foundAt = at
        loss.foundCondition = 'damaged'
        loss.foundBy = payload.foundBy ?? '保洁'
        loss.resolvedNote = payload.note
        loss.finalFee = REPAIR_FEE
        const back = unit - REPAIR_FEE
        if (dev) {
          dev.status = 'repairing'
          dev.returnedAt = at
          dev.damageFee = REPAIR_FEE
          dev.note = `保洁找回但已损坏，扣维修费：${payload.note ?? ''}`.trim()
        }
        museum.resolvePoolFound(loss.code, 'damaged', at, payload.foundBy ?? '保洁', payload.note)
        r.depositRefunded += Math.max(0, back)
        this.log(r, 'device_found', `保洁找回 ${loss.code}，但设备已损坏，转维修`, at, payload.foundBy ?? '保洁', {
          detail: payload.note ? `损坏情况：${payload.note}` : undefined,
        })
        this.log(
          r,
          'deposit_refund',
          `暂扣押金 ¥${unit} 扣除维修费 ¥${REPAIR_FEE}，退还 ¥${Math.max(0, back)}`,
          at,
          by,
          { amount: REPAIR_FEE },
        )
      } else {
        // 寻找未果 → 转赔付结案
        loss.state = 'paid'
        loss.finalFee = LOST_FEE
        loss.resolvedNote = payload.note ?? '保洁核查后仍未找到，按遗失赔付结案'
        loss.heldAmount = 0
        if (dev) {
          dev.status = 'lost'
          dev.damageFee = LOST_FEE
          dev.note = loss.resolvedNote
        }
        museum.markPoolPaidLost(loss.code, loss.resolvedNote)
        this.log(r, 'device_lost_report', `寻找未果，${loss.code} 按遗失结案`, at, by, {
          detail: loss.resolvedNote,
        })
      }
      this.recalcDeposit(r)
    },

    settleDeposit(id: string, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r) return
      const settled = r.depositDeduction
      const held = r.depositHeld
      const back = r.depositTotal - settled - held
      this.log(
        r,
        'deposit_settle',
        held > 0
          ? `押金阶段性结算：¥${r.depositTotal.toLocaleString()} 中扣除 ¥${settled}、暂扣 ¥${held} 待保洁核查，现退 ¥${back.toLocaleString()}`
          : `押金结算：¥${r.depositTotal.toLocaleString()} 中扣除 ¥${settled}，退还 ¥${back.toLocaleString()}`,
        museum.nowISO,
        by,
        { amount: settled },
      )
    },

    complete(id: string, satisfaction: number, by: string) {
      const r = this.byId(id)
      const museum = useMuseumStore()
      if (!r || r.status !== 'touring') return
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
    // 兼容旧版本 localStorage 中缺少遗失押金字段的预约
    afterHydrate: (ctx) => {
      for (const r of ctx.store.list as Reservation[]) {
        r.depositHeld ??= 0
        r.depositRefunded ??= 0
        r.depositRate ??= 1
        r.lostDevices ??= []
      }
    },
  },
})
