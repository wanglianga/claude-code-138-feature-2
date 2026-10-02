import { defineStore } from 'pinia'
import {
  GUIDES,
  HALLS,
  HEADSET_DEPOSIT,
  SECURITY_LANES,
  THEMES,
} from '@/data/museum'
import { seedHeadsets } from '@/data/seed'
import { addHM, hmOfISO } from '@/lib/time'
import type { DeviceUnit, DeviceStatus, Guide, Hall, HallClosure, SecurityLane, Theme } from '@/types'

interface MuseumState {
  halls: Hall[]
  guides: Guide[]
  lanes: SecurityLane[]
  themes: Theme[]
  headsets: DeviceUnit[]
  depositPerUnit: number
  /** 工作人员实时登记的临时维护：hallId -> 闭馆时段 */
  maintenance: Record<string, HallClosure>
  /** 散客实时占用录入 */
  extraLoad: Record<string, number>
  nowHM: string
  running: boolean
}

let timer: ReturnType<typeof setInterval> | null = null

export const useMuseumStore = defineStore('museum', {
  state: (): MuseumState => ({
    halls: JSON.parse(JSON.stringify(HALLS)) as Hall[],
    guides: JSON.parse(JSON.stringify(GUIDES)) as Guide[],
    lanes: JSON.parse(JSON.stringify(SECURITY_LANES)) as SecurityLane[],
    themes: JSON.parse(JSON.stringify(THEMES)) as Theme[],
    headsets: seedHeadsets(),
    depositPerUnit: HEADSET_DEPOSIT,
    maintenance: {},
    extraLoad: { h2: 28, h5: 10 },
    nowHM: '10:25',
    running: false,
  }),

  getters: {
    hallById: (s) => (id: string) => s.halls.find((h) => h.id === id),
    themeById: (s) => (id: string) => s.themes.find((t) => t.id === id),
    guideById: (s) => (id: string) => s.guides.find((g) => g.id === id),
    nowISO: (s) => `2026-10-01T${s.nowHM}:00`,
    inventory(s) {
      const c = { available: 0, lent: 0, returned: 0, damaged: 0, lost: 0, repairing: 0 }
      for (const d of s.headsets) c[d.status]++
      return c
    },
  },

  actions: {
    setNow(hm: string) {
      this.nowHM = hm
    },
    tick() {
      this.nowHM = addHM(this.nowHM, 1)
      if (this.nowHM > '18:00') this.pauseSimulation()
    },
    startSimulation() {
      if (this.running) return
      this.running = true
      timer = setInterval(() => this.tick(), 2000)
    },
    pauseSimulation() {
      this.running = false
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    resetClock() {
      this.pauseSimulation()
      this.nowHM = '10:25'
    },

    setMaintenance(hallId: string, closure: HallClosure) {
      this.maintenance[hallId] = closure
    },
    clearMaintenance(hallId: string) {
      delete this.maintenance[hallId]
    },
    setExtraLoad(hallId: string, n: number) {
      if (n > 0) this.extraLoad[hallId] = n
      else delete this.extraLoad[hallId]
    },

    /** 从在库设备中取 n 台，返回设备编码（不足时返回全部可用）；rate 为本团单台押金费率 */
    lendFromPool(n: number, resId: string, atISO: string, rate: number = HEADSET_DEPOSIT): DeviceUnit[] {
      const picked: DeviceUnit[] = []
      for (const d of this.headsets) {
        if (picked.length >= n) break
        if (d.status === 'available') {
          d.status = 'lent'
          d.resId = resId
          d.lentAt = atISO
          d.returnedAt = undefined
          d.damageFee = undefined
          d.note = undefined
          picked.push({ ...d, deposit: rate })
        }
      }
      return picked
    },

    syncPoolDevice(
      code: string,
      status: DeviceStatus,
      fields: Partial<DeviceUnit> = {},
    ) {
      const d = this.headsets.find((x) => x.code === code)
      if (!d) return
      d.status = status
      Object.assign(d, fields)
      if (status === 'available' || status === 'returned') {
        d.resId = undefined
      }
    },

    /** 离馆清点确认耳麦遗失：池内设备转「遗失」，不会再被 lendFromPool 分配给下一场团队 */
    markPoolLost(code: string, note?: string) {
      const d = this.headsets.find((x) => x.code === code)
      if (!d) return
      d.status = 'lost'
      d.note = note
    },

    /**
     * 保洁找回设备，按核验结论同步库存：
     * - intact 完好：回到在库可借池，下一场团队可正常分配；
     * - repair 需维修：转「维修中」，退出可借池，修复前不会再分配。
     */
    resolvePoolFound(
      code: string,
      outcome: 'intact' | 'repair',
      atISO: string,
      fields: { note?: string; repairFee?: number; foundBy?: string } = {},
    ) {
      const d = this.headsets.find((x) => x.code === code)
      if (!d) return
      d.returnedAt = atISO
      d.note = fields.note
      if (outcome === 'intact') {
        d.status = 'available'
        d.resId = undefined
        d.lentAt = undefined
        d.damageFee = undefined
      } else {
        d.status = 'repairing'
        d.damageFee = fields.repairFee
      }
    },

    /** 维修完成：设备回到可借池 */
    finishRepair(code: string) {
      const d = this.headsets.find((x) => x.code === code)
      if (!d || d.status !== 'repairing') return
      d.status = 'available'
      d.resId = undefined
      d.damageFee = undefined
      d.note = undefined
      d.returnedAt = undefined
    },

    /** 途中换机：旧机损坏待赔，从池里补一台新机借出（沿用该团押金费率，不重复收押金） */
    exchangeFromPool(oldCode: string, resId: string, atISO: string, note: string, rate: number = HEADSET_DEPOSIT): string | null {
      this.syncPoolDevice(oldCode, 'damaged', { note, damageFee: 50 })
      const [fresh] = this.lendFromPool(1, resId, atISO, rate)
      return fresh?.code ?? null
    },

    resetAll() {
      this.pauseSimulation()
      this.$patch({
        headsets: seedHeadsets(),
        maintenance: {},
        extraLoad: { h2: 28, h5: 10 },
        nowHM: hmOfISO('2026-10-01T10:25:00'),
      })
    },
  },

  persist: {
    key: 'museum-world',
    pick: ['maintenance', 'extraLoad', 'nowHM', 'headsets'],
  },
})
