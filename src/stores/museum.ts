import { defineStore } from 'pinia'
import {
  GUIDES,
  HALLS,
  HEADSET_DEPOSIT,
  LOST_FEE,
  REPAIR_FEE,
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

    /** 从在库设备中取 n 台，返回设备编码（不足时返回全部可用）；损坏/遗失/送修设备不会再次分配 */
    lendFromPool(n: number, resId: string, atISO: string): DeviceUnit[] {
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
          d.lostResId = undefined
          picked.push({ ...d })
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
        d.lostResId = undefined
      }
    },

    /** 离馆清点发现设备遗失：池中转为遗失挂账，绝不再分配给后续团队 */
    markPoolLost(code: string, resId: string, note?: string) {
      const d = this.headsets.find((x) => x.code === code)
      if (!d) return
      d.status = 'lost'
      d.resId = undefined
      d.lostResId = resId
      d.returnedAt = undefined
      d.damageFee = undefined
      d.note = note
    },

    /**
     * 保洁找回遗失设备：按设备状况回库。
     * - 完好：重新进入在库，可再次借出；
     * - 已损坏：转「送修」，修复前不参与分配。
     */
    resolvePoolFound(code: string, condition: 'ok' | 'damaged', atISO: string, foundBy: string, note?: string) {
      const d = this.headsets.find((x) => x.code === code)
      if (!d) return
      d.lostResId = undefined
      d.resId = undefined
      if (condition === 'ok') {
        d.status = 'available'
        d.damageFee = undefined
        d.returnedAt = undefined
      } else {
        d.status = 'repairing'
        d.damageFee = REPAIR_FEE
        d.returnedAt = atISO
      }
      d.note = note ? `${foundBy}找回：${note}` : `${foundBy}找回`
    },

    /** 寻找未果、团队当场赔付：维持遗失状态并挂赔付金额（实物未找回，不回库） */
    markPoolPaidLost(code: string, note?: string) {
      const d = this.headsets.find((x) => x.code === code)
      if (!d) return
      d.status = 'lost'
      d.damageFee = LOST_FEE
      if (note) d.note = note
    },

    /** 途中换机：旧机损坏待赔，从池里补一台新机借出 */
    exchangeFromPool(oldCode: string, resId: string, atISO: string, note: string): string | null {
      this.syncPoolDevice(oldCode, 'damaged', { note, damageFee: REPAIR_FEE })
      const [fresh] = this.lendFromPool(1, resId, atISO)
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
