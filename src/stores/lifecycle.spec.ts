import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'

describe('预约全生命周期集成', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('提交→确认→到馆→发设备→入场→途中事件→离馆押金结算', () => {
    const museum = useMuseumStore()
    const store = useReservationsStore()
    museum.setNow('14:00')

    // 1. 预约方提交
    const r = store.create({
      orgType: 'enterprise',
      orgName: '测试科技有限公司',
      groupSize: 30,
      ageBand: 'adult',
      language: 'zh',
      accessible: false,
      themeId: 't_modern',
      arriveTime: '2026-10-01T14:00:00',
      contactName: '测试领队',
      contactPhone: '13800000000',
      busInfo: '大巴 1 辆',
      needHeadsets: true,
      headsetCount: 30,
      note: '',
    })
    expect(r.status).toBe('submitted')
    expect(r.route.length).toBeGreaterThan(0)
    expect(r.timeline[0].kind).toBe('submit')

    // 2. 馆方确认（林岚 09-17 当班且下午空闲）
    store.confirm(r.id, { guideIds: ['g1'], laneId: 'lane_a', batchNo: 'B1400', note: '正常确认' }, '沈姐')
    expect(r.status).toBe('confirmed')
    expect(r.assignedGuideIds).toEqual(['g1'])

    // 3. 到馆（时钟设为 14:05 → 迟到 5 分钟）
    museum.setNow('14:05')
    store.markArrived(r.id)
    expect(r.status).toBe('arrived')
    expect(r.actualArrive).toBe('2026-10-01T14:05:00')
    expect(r.timeline.some((e) => e.kind === 'arrive' && e.title.includes('迟到 5'))).toBe(true)

    // 4. 核验人数：少 2 人
    store.verifyHeadcount(r.id, 28, '小唐')
    expect(r.verifiedSize).toBe(28)

    // 5. 发耳麦
    store.handoutHeadsets(r.id, 28, '老郭')
    expect(r.devices).toHaveLength(28)
    expect(r.devices.every((d) => d.status === 'lent')).toBe(true)
    expect(r.depositTotal).toBe(28 * 200)

    // 6. 入场
    store.admit(r.id, '安检员')
    expect(r.status).toBe('touring')
    expect(r.route.some((s) => s.state === 'current')).toBe(true)
    expect(museum.inventory.lent).toBeGreaterThanOrEqual(28 + 24) // 本团 28 + 种子儿童团 24

    // 7. 迟到顺延 15 分钟
    const before = r.route.find((s) => s.state === 'planned')!.plannedEnter
    store.delay(r.id, 15, 'late', '团体迟到顺延15分钟', '', '沈姐')
    const after = r.route.find((s) => s.state === 'planned')!.plannedEnter
    expect(after > before).toBe(true)

    // 8. 改道：当前站 → h3
    const blocked = r.route.find((s) => s.state === 'current')!.hallId
    store.applyReroute(r.id, {
      blockedHallId: blocked,
      targetHallId: 'h3',
      atHM: museum.nowHM,
      durationMin: 25,
      reason: '游客对雕塑感兴趣',
    }, '林岚')
    expect(r.route.find((s) => s.hallId === 'h3' && s.state === 'current')).toBeTruthy()
    expect(r.timeline.some((e) => e.kind === 'reroute')).toBe(true)

    // 9. 儿童走散（成人团也可调用通用等待事件）
    store.childLost(r.id, '随行儿童一名', 10, true, '林岚')
    expect(r.timeline.some((e) => e.kind === 'child_lost')).toBe(true)

    // 10. 耳麦损坏换机
    const oldCode = r.devices[0].code
    store.exchangeHeadset(r.id, oldCode, '无声音', '老郭')
    expect(r.devices.find((d) => d.code === oldCode)?.status).toBe('damaged')
    expect(r.devices.filter((d) => d.status === 'lent').length).toBe(28)
    expect(r.timeline.some((e) => e.kind === 'device_exchange')).toBe(true)

    // 11. 讲解员替换：何田田下午当班且无团
    store.swapGuide(r.id, 'g1', 'g5', '林岚嗓子不适')
    expect(r.assignedGuideIds).toEqual(['g5'])

    // 12. 离馆：28 台归还，其中 1 台损坏（换机时已登记）、1 台遗失
    const results = r.devices
      .filter((d) => d.status === 'lent')
      .map((d, i) => ({ code: d.code, result: i === 0 ? ('lost' as const) : ('ok' as const) }))
    store.returnDevices(r.id, results, '老郭')
    // 27 完好 + 1 遗失 + 换机旧机损坏
    expect(r.depositDeduction).toBe(200 + 50)
    store.settleDeposit(r.id, '老郭')
    expect(r.timeline.some((e) => e.kind === 'deposit_settle' && e.amount === 250)).toBe(true)

    // 13. 完成
    store.complete(r.id, 4, '小唐')
    expect(r.status).toBe('completed')
    expect(r.satisfaction).toBe(4)
    expect(r.departAt).toBeTruthy()

    // 时间线按时间排序且覆盖关键环节
    const kinds = r.timeline.map((e) => e.kind)
    for (const k of ['submit', 'confirm', 'arrive', 'headcount', 'device_handout', 'batch_admit', 'reroute', 'device_exchange', 'guide_swap', 'device_return', 'deposit_settle', 'complete']) {
      expect(kinds).toContain(k)
    }
    const times = r.timeline.map((e) => e.at)
    expect([...times].sort()).toEqual(times)
  })

  it('临时维护会联动所有在馆/已确认团的受影响站点', () => {
    const museum = useMuseumStore()
    const store = useReservationsStore()
    museum.setNow('10:25')
    // 种子儿童团 R3 正在 h5（10:20-10:45）
    store.declareMaintenance('h5', { start: '10:00', end: '11:00', reason: '光影设备抢修' }, '工程部')
    const r3 = store.byId('R20261001-03')!
    const stop = r3.route.find((s) => s.hallId === 'h5')!
    expect(stop.state).toBe('maintenance')
    expect(museum.maintenance.h5?.reason).toBe('光影设备抢修')
  })

  it('种子 R6：鸿雁国旅 HS-049 遗失暂扣中，未结案不能离馆', () => {
    const store = useReservationsStore()
    const r6 = store.byId('R20261001-06')!
    const rec = r6.lostDevices[0]
    expect(rec.code).toBe('HS-049')
    expect(rec.borrower).toBeTruthy()
    expect(rec.leader).toBe('吴领队')
    expect(rec.lastHallId).toBeTruthy()
    expect(rec.resolution).toBe('withheld')
    expect(rec.outcome).toBe('pending')
    expect(store.pendingLostCount(r6.id)).toBe(1)
    // 池内设备转遗失
    const pool = useMuseumStore().headsets.find((d) => d.code === 'HS-049')!
    expect(pool.status).toBe('lost')
    // 尝试结算/离馆被阻止
    store.settleDeposit(r6.id, '老郭')
    store.complete(r6.id, 5, '小唐')
    expect(r6.status).toBe('touring')
  })
})

describe('耳麦遗失 → 押金处置 → 保洁找回 → 库存联动', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /** 建一个 10 人旅行社团并走到参观中、已发 10 台耳麦 */
  function touringTravelOrg(orgName: string, arrive = '2026-10-01T13:00:00') {
    const museum = useMuseumStore()
    const store = useReservationsStore()
    museum.setNow('13:00')
    const r = store.create({
      orgType: 'travel',
      orgName,
      groupSize: 10,
      ageBand: 'adult',
      language: 'zh',
      accessible: false,
      themeId: 't_modern',
      arriveTime: arrive,
      contactName: '李领队',
      contactPhone: '13800000000',
      busInfo: '中巴 1 辆',
      needHeadsets: true,
      headsetCount: 10,
      note: '',
    })
    store.confirm(r.id, { guideIds: ['g1'], laneId: 'lane_a', batchNo: 'B1300', note: '' }, '沈姐')
    store.markArrived(r.id)
    store.verifyHeadcount(r.id, 10, '小唐')
    store.handoutHeadsets(r.id, 10, '老郭')
    store.admit(r.id, '安检员')
    return { museum, store, r }
  }

  it('暂扣后保洁找回完好：押金全退、设备回可借池、可正常离馆', () => {
    const { museum, store, r } = touringTravelOrg('好运旅行社')
    const code = r.devices[0].code
    museum.setNow('14:00')

    const rec = store.reportLostDevice(r.id, {
      code,
      borrower: '团员 张三',
      leader: '李领队',
      lastHallId: 'h1',
      note: '座位旁',
      resolution: 'withheld',
    }, '小唐')!
    expect(rec.outcome).toBe('pending')
    expect(rec.withheldAmount).toBe(200)
    expect(museum.headsets.find((d) => d.code === code)?.status).toBe('lost')
    // 未结案：不能结算/离馆
    store.settleDeposit(r.id, '老郭')
    store.complete(r.id, 5, '小唐')
    expect(r.status).toBe('touring')
    // 其余 9 台完好归还
    const results = r.devices
      .filter((d) => d.code !== code)
      .map((d) => ({ code: d.code, result: 'ok' as const }))
    store.returnDevices(r.id, results, '老郭')
    expect(store.pendingLostCount(r.id)).toBe(1)
    expect(r.depositDeduction).toBe(0) // 暂扣未决不计扣款

    // 保洁找回、设备完好 → 全退
    store.resolveLostFound(r.id, rec.key, { outcome: 'intact', foundBy: '保洁王姐' }, '老郭')
    expect(museum.headsets.find((d) => d.code === code)?.status).toBe('available')
    const dev = r.devices.find((d) => d.code === code)!
    expect(dev.status).toBe('returned')
    expect(r.depositDeduction).toBe(0)
    store.settleDeposit(r.id, '老郭')
    store.complete(r.id, 5, '小唐')
    expect(r.status).toBe('completed')
    expect(r.timeline.some((e) => e.kind === 'device_found' && e.title.includes('全额退还'))).toBe(true)
  })

  it('暂扣后找回但已损坏：按维修费扣款、设备转维修中且不会被再次借出', () => {
    const { museum, store, r } = touringTravelOrg('磕碰旅行社')
    const code = r.devices[0].code
    museum.setNow('14:00')
    const rec = store.reportLostDevice(r.id, {
      code, borrower: '团员 李四', leader: '李领队', lastHallId: 'h2', resolution: 'withheld',
    }, '小唐')!

    // 维修中的设备不会被 lendFromPool 取出
    store.resolveLostFound(r.id, rec.key, { outcome: 'repair', repairFee: 80 }, '老郭')
    const poolDev = museum.headsets.find((d) => d.code === code)!
    expect(poolDev.status).toBe('repairing')
    const picked = museum.lendFromPool(5, 'OTHER', '2026-10-01T15:00:00')
    expect(picked.some((d) => d.code === code)).toBe(false)
    expect(r.depositDeduction).toBe(80)

    // 维修完成后回到可借池
    museum.finishRepair(code)
    expect(museum.headsets.find((d) => d.code === code)?.status).toBe('available')
    expect(r.timeline.some((e) => e.kind === 'device_found' && e.title.includes('维修费 ¥80'))).toBe(true)
  })

  it('保洁确认无法找回：押金不退并计为该旅行社确认遗失', () => {
    const { museum, store, r } = touringTravelOrg('粗心旅行社')
    const code = r.devices[0].code
    museum.setNow('14:00')
    const rec = store.reportLostDevice(r.id, {
      code, borrower: '团员 王五', leader: '李领队', lastHallId: 'courtyard', resolution: 'withheld',
    }, '小唐')!
    store.confirmLostNotFound(r.id, rec.key, '保洁组')
    expect(r.depositDeduction).toBe(200)
    expect(museum.headsets.find((d) => d.code === code)?.status).toBe('lost')
    store.settleDeposit(r.id, '老郭')
    store.complete(r.id, 4, '小唐')
    expect(r.status).toBe('completed')
  })

  it('团队选择当场赔付：押金立即扣除结案，遗失设备不再分配', () => {
    const { museum, store, r } = touringTravelOrg('爽快旅行社')
    const code = r.devices[0].code
    museum.setNow('14:00')
    const rec = store.reportLostDevice(r.id, {
      code, borrower: '团员 赵六', leader: '李领队', lastHallId: 'h3', resolution: 'paid',
    }, '小唐')
    expect(rec?.outcome).toBe('forfeit')
    expect(r.depositDeduction).toBe(200)
    expect(store.pendingLostCount(r.id)).toBe(0)
    expect(museum.headsets.find((d) => d.code === code)?.status).toBe('lost')
  })

  it('现场寻找可改为押金暂扣；未决期间设备保持责任在团', () => {
    const { museum, store, r } = touringTravelOrg('找找旅行社')
    const code = r.devices[0].code
    museum.setNow('14:00')
    const rec = store.reportLostDevice(r.id, {
      code, borrower: '团员 孙七', leader: '李领队', lastHallId: 'h1', resolution: 'searching',
    }, '小唐')!
    expect(rec.outcome).toBe('pending')
    expect(museum.headsets.find((d) => d.code === code)?.status).toBe('lent')
    expect(r.depositDeduction).toBe(0)
    // 寻找未果转暂扣
    store.changeLostResolution(r.id, rec.key, 'withheld', '小唐')
    expect(museum.headsets.find((d) => d.code === code)?.status).toBe('lost')
  })

  it('旅行社确认遗失后，其后续团队耳麦按加收费率收取', () => {
    const museum = useMuseumStore()
    const store = useReservationsStore()
    museum.setNow('08:00')
    // 第一个团：当场赔付一台
    const first = store.create({
      orgType: 'travel', orgName: '连环旅行社', groupSize: 6, ageBand: 'adult', language: 'zh',
      accessible: false, themeId: 't_modern', arriveTime: '2026-10-01T08:00:00',
      contactName: '周领队', contactPhone: '13800000001', busInfo: '',
      needHeadsets: true, headsetCount: 6, note: '',
    })
    store.confirm(first.id, { guideIds: ['g1'], laneId: 'lane_a', batchNo: 'B0800', note: '' }, '沈姐')
    store.markArrived(first.id)
    store.verifyHeadcount(first.id, 6, '小唐')
    store.handoutHeadsets(first.id, 6, '老郭')
    expect(first.depositPerUnit).toBe(200)
    store.admit(first.id, '安检员')
    museum.setNow('09:00')
    const lostCode = first.devices[0].code
    store.reportLostDevice(first.id, {
      code: lostCode, borrower: '团员', leader: '周领队', lastHallId: 'h1', resolution: 'paid',
    }, '小唐')
    store.returnDevices(first.id,
      first.devices.filter((d) => d.code !== lostCode).map((d) => ({ code: d.code, result: 'ok' as const })), '老郭')
    store.settleDeposit(first.id, '老郭')
    store.complete(first.id, 4, '小唐')

    // 第二个团（同社，稍晚到馆）：发设备时按加收押金
    museum.setNow('13:00')
    const second = store.create({
      orgType: 'travel', orgName: '连环旅行社', groupSize: 8, ageBand: 'adult', language: 'zh',
      accessible: false, themeId: 't_modern', arriveTime: '2026-10-01T13:30:00',
      contactName: '周领队', contactPhone: '13800000001', busInfo: '',
      needHeadsets: true, headsetCount: 8, note: '',
    })
    store.confirm(second.id, { guideIds: ['g2'], laneId: 'lane_a', batchNo: 'B1330', note: '' }, '沈姐')
    store.markArrived(second.id)
    store.verifyHeadcount(second.id, 8, '小唐')
    store.handoutHeadsets(second.id, 8, '老郭')
    expect(second.depositPerUnit).toBe(300)
    expect(second.depositTotal).toBe(2400)
  })
})
