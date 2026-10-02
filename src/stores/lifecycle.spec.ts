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
})

describe('耳麦遗失押金处理', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('押金暂扣：离馆登记遗失 → 暂扣 ¥200 → 保洁完好找回 → 全额退还，设备重新在库', () => {
    const museum = useMuseumStore()
    const store = useReservationsStore()
    museum.setNow('10:50')
    const r3 = store.byId('R20261001-03')!
    const code = r3.devices[0].code // HS-001

    store.reportLostDevice(r3.id, {
      code,
      borrower: '三年级学生李小华',
      teamLeader: '孙老师',
      lastHallId: 'h5',
      note: '五号厅沉浸光影区散场后遗漏',
      disposition: 'hold',
    }, '前台主管 沈姐')

    const loss = r3.lostDevices.find((l) => l.code === code)!
    expect(loss.state).toBe('held')
    expect(loss.heldAmount).toBe(200)
    expect(r3.depositHeld).toBe(200)
    expect(r3.devices.find((d) => d.code === code)?.status).toBe('lost')
    // 池中遗失挂账，不会再分配
    expect(museum.headsets.find((d) => d.code === code)?.status).toBe('lost')
    expect(museum.headsets.find((d) => d.code === code)?.lostResId).toBe(r3.id)
    expect(museum.lendFromPool(5, 'X', '2026-10-01T11:00:00').some((d) => d.code === code)).toBe(false)
    expect(r3.timeline.some((e) => e.kind === 'deposit_held' && e.amount === 200)).toBe(true)

    // 保洁在五号厅长椅下找到，设备完好
    museum.setNow('11:40')
    store.resolveLostDevice(r3.id, loss.id, {
      found: true,
      condition: 'ok',
      foundBy: '保洁 王阿姨',
      note: '五号厅长椅缝隙中找到，外观与通电均正常',
    }, '前台主管 沈姐')

    expect(loss.state).toBe('refunded')
    expect(loss.finalFee).toBe(0)
    expect(r3.depositHeld).toBe(0)
    expect(r3.depositRefunded).toBe(200)
    expect(r3.devices.find((d) => d.code === code)?.status).toBe('returned')
    // 完好找回：重新进入在库，可再次借出
    expect(museum.headsets.find((d) => d.code === code)?.status).toBe('available')
    expect(r3.timeline.some((e) => e.kind === 'deposit_refund' && e.amount === 200)).toBe(true)
  })

  it('暂扣后找回但已损坏：扣维修费 ¥50、退还 ¥150，设备转送修且不再分配', () => {
    const museum = useMuseumStore()
    const store = useReservationsStore()
    const r3 = store.byId('R20261001-03')!
    const code = r3.devices[1].code // HS-002

    const loss = store.reportLostDevice(r3.id, {
      code,
      borrower: '家长志愿者赵阿姨',
      teamLeader: '孙老师',
      lastHallId: 'edu',
      note: '教育体验室活动后未收回',
      disposition: 'hold',
    }, '沈姐')!
    expect(r3.depositHeld).toBe(200)

    store.resolveLostDevice(r3.id, loss.id, {
      found: true,
      condition: 'damaged',
      foundBy: '保洁 王阿姨',
      note: '耳罩断裂、头梁变形',
    }, '沈姐')

    expect(loss.state).toBe('repaired')
    expect(loss.finalFee).toBe(50)
    expect(r3.depositHeld).toBe(0)
    expect(r3.depositDeduction).toBe(50)
    expect(r3.depositRefunded).toBe(150)
    // 送修设备不会被再次分配
    const poolDev = museum.headsets.find((d) => d.code === code)!
    expect(poolDev.status).toBe('repairing')
    expect(poolDev.damageFee).toBe(50)
    expect(museum.lendFromPool(10, 'X', '2026-10-01T12:00:00').some((d) => d.code === code)).toBe(false)
  })

  it('现场寻找未果可转赔付：扣款 ¥200 结案，遗失记录保留并影响旅行社信用', () => {
    const museum = useMuseumStore()
    const store = useReservationsStore()
    const r3 = store.byId('R20261001-03')!
    const code = r3.devices[2].code // HS-003

    const loss = store.reportLostDevice(r3.id, {
      code,
      borrower: '学生一名',
      teamLeader: '孙老师',
      lastHallId: 'h3',
      note: '团队先在现场寻找',
      disposition: 'search',
    }, '沈姐')!
    expect(loss.state).toBe('searching')
    expect(r3.depositHeld).toBe(200)

    store.resolveLostDevice(r3.id, loss.id, { found: false, note: '闭馆清场仍未找到' }, '沈姐')
    expect(loss.state).toBe('paid')
    expect(loss.finalFee).toBe(200)
    expect(r3.depositHeld).toBe(0)
    expect(r3.depositDeduction).toBe(200)
    expect(museum.headsets.find((d) => d.code === code)?.status).toBe('lost')
  })

  it('当场赔付直接扣款 ¥200 且无需暂扣', () => {
    const museum = useMuseumStore()
    const store = useReservationsStore()
    const r3 = store.byId('R20261001-03')!
    const code = r3.devices[3].code

    store.reportLostDevice(r3.id, {
      code,
      borrower: '学生一名',
      teamLeader: '孙老师',
      lastHallId: 'h3',
      note: '团队放弃寻找，当场赔付',
      disposition: 'paid',
    }, '沈姐')

    expect(r3.depositHeld).toBe(0)
    expect(r3.depositDeduction).toBe(200)
    const loss = r3.lostDevices.find((l) => l.code === code)!
    expect(loss.state).toBe('paid')
    expect(museum.headsets.find((d) => d.code === code)?.damageFee).toBe(200)
  })

  it('有未结案遗失记录的旅行社，后续预约押金按 1.5 倍（¥300/台）收取', () => {
    const museum = useMuseumStore()
    const store = useReservationsStore()
    // 种子 R6 鸿雁假期有 HS-041 遗失暂扣中
    const r6 = store.byId('R20261001-06')!
    expect(r6.orgName).toBe('鸿雁假期')
    expect(store.outstandingLosses.some((x) => x.res.id === r6.id)).toBe(true)
    // R7 为该旅行社的下午后续预约，创建时已标记 1.5 倍
    const r7 = store.byId('R20261001-07')!
    expect(r7.depositRate).toBe(1.5)

    museum.setNow('13:00')
    const r = store.create({
      orgType: 'travel',
      orgName: '鸿雁假期',
      groupSize: 10,
      ageBand: 'adult',
      language: 'zh',
      accessible: false,
      themeId: 't_west',
      arriveTime: '2026-10-01T15:00:00',
      contactName: '周领队',
      contactPhone: '137****9032',
      busInfo: '中巴',
      needHeadsets: true,
      headsetCount: 10,
      note: '',
    })
    expect(r.depositRate).toBe(1.5)
    store.confirm(r.id, { guideIds: ['g2'], laneId: 'lane_a', batchNo: 'B1500', note: '' }, '沈姐')
    store.markArrived(r.id)
    store.verifyHeadcount(r.id, 10, '小唐')
    store.handoutHeadsets(r.id, 10, '老郭')
    expect(r.depositTotal).toBe(3000) // 10 × ¥300
    expect(r.devices.every((d) => d.deposit === 300)).toBe(true)
  })

  it('遗失设备完好找回并退押金后，该旅行社后续预约恢复正常押金倍率', () => {
    const store = useReservationsStore()
    const r6 = store.byId('R20261001-06')!
    const loss = r6.lostDevices[0]
    store.resolveLostDevice(r6.id, loss.id, { found: true, condition: 'ok', foundBy: '保洁 王阿姨' }, '沈姐')
    expect(store.outstandingLosses.some((x) => x.res.id === r6.id)).toBe(false)

    const r = store.create({
      orgType: 'travel',
      orgName: '鸿雁假期',
      groupSize: 10,
      ageBand: 'adult',
      language: 'zh',
      accessible: false,
      themeId: 't_west',
      arriveTime: '2026-10-01T16:00:00',
      contactName: '周领队',
      contactPhone: '137****9032',
      busInfo: '中巴',
      needHeadsets: true,
      headsetCount: 10,
      note: '',
    })
    expect(r.depositRate).toBe(1)
  })

  it('学校/企业团体即使同名有遗失记录也不上浮押金（规则仅针对旅行社）', () => {
    const store = useReservationsStore()
    const r = store.create({
      orgType: 'school',
      orgName: '鸿雁假期', // 同名但类型为学校
      groupSize: 10,
      ageBand: 'youth',
      language: 'zh',
      accessible: false,
      themeId: 't_family',
      arriveTime: '2026-10-01T16:00:00',
      contactName: '老师',
      contactPhone: '13800000000',
      busInfo: '大巴',
      needHeadsets: true,
      headsetCount: 10,
      note: '',
    })
    expect(r.depositRate).toBe(1)
  })
})
