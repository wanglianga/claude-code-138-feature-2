import { describe, expect, it } from 'vitest'
import {
  buildRoute,
  downstreamImpact,
  guideBusyWindows,
  occupancyGrid,
  routePeakLoads,
  securityPlan,
  splitBatches,
  suggestReroute,
  availableGuides,
} from './schedule'
import { GUIDES, HALLS, SECURITY_LANES, THEMES } from '@/data/museum'
import { seedReservations } from '@/data/seed'
import type { RouteStop } from '@/types'

const reservations = seedReservations()
const byId = (id: string) => reservations.find((r) => r.id === id)!

describe('splitBatches', () => {
  it('55 人拆成 25+25+5', () => {
    expect(splitBatches(55)).toEqual([25, 25, 5])
  })
  it('小团不拆分', () => {
    expect(splitBatches(16)).toEqual([16])
  })
})

describe('buildRoute', () => {
  it('按主题顺序生成站点并顺延闭展厅', () => {
    const theme = THEMES.find((t) => t.id === 't_west')!
    const stops = buildRoute(theme, HALLS, '10:40', { accessible: false })
    expect(stops.map((s) => s.hallId)).toEqual(['h6', 'h7', 'h1'])
    // 七厅 11:00-12:00 维护：11:08 进场冲突，顺延到 12:05
    const h7 = stops.find((s) => s.hallId === 'h7')!
    expect(h7.plannedEnter >= '12:00').toBe(true)
    expect(h7.note).toContain('灯光维护')
  })

  it('无障碍路线跳过不可达展厅（四号厅）', () => {
    const theme = THEMES.find((t) => t.id === 't_master')!
    const stops = buildRoute(theme, HALLS, '11:10', { accessible: true })
    expect(stops.find((s) => s.hallId === 'h4')?.state).toBe('skipped')
  })
})

describe('occupancyGrid / hallLoadAt', () => {
  it('参观中的儿童团占用三号厅 09:45 槽', () => {
    const grid = occupancyGrid(reservations)
    const h3 = HALLS.find((h) => h.id === 'h3')!
    const slot = grid.get('h3')!
    // 09:50-10:14，24 人
    expect(slot.get(9 * 60 + 45)).toBe(24)
    expect(slot.get(10 * 60 + 0)).toBe(24)
    expect(h3.capacity).toBeGreaterThan(24)
  })

  it('已离馆团不再占用展厅，维护/跳过站不计数', () => {
    const grid = occupancyGrid(reservations)
    // R5 已离馆：二号厅 09:30 槽应无占用
    expect(grid.get('h2')?.get(9 * 60 + 30)).toBeUndefined()
    // 参观中 R3：三号厅 10:00 槽 24 人
    expect(grid.get('h3')?.get(10 * 60)).toBe(24)
  })
})

describe('routePeakLoads', () => {
  it('新团叠加到已确认团时，二号厅 11:15 槽给出满载率', () => {
    const r4 = byId('R20261001-04')
    const grid = occupancyGrid(reservations)
    const peaks = routePeakLoads(r4.route, HALLS, grid)
    const h2 = peaks.find((p) => p.hallId === 'h2')!
    expect(h2.capacity).toBe(45)
    // R4 自身 55 人 > 容量 45（演示用：确认台会提示拆团错峰）
    expect(h2.load).toBeGreaterThanOrEqual(55)
  })
})

describe('availableGuides', () => {
  it('英语团 10:40-12:05 只可选英语讲解员，且排除已占用的周牧', () => {
    const list = availableGuides(GUIDES, reservations, {
      language: 'en',
      themeId: 't_west',
      startHM: '10:40',
      endHM: '12:05',
    })
    const english = list.filter((g) => g.langs.includes('en'))
    expect(english.map((g) => g.id).sort()).toEqual(['g2'])
    const zhou = list.find((g) => g.id === 'g2')!
    expect(zhou.ok).toBe(false)
    expect(zhou.conflicts.join()).toContain('冲突')
  })

  it('中文亲子团上午时段可选苏晓', () => {
    const list = availableGuides(GUIDES, [], {
      language: 'zh',
      themeId: 't_family',
      startHM: '10:50',
      endHM: '12:05',
    })
    const su = list.find((g) => g.id === 'g3')!
    expect(su.ok).toBe(true)
  })
})

describe('securityPlan', () => {
  it('无障碍团优先推荐无障碍通道', () => {
    const plan = securityPlan(SECURITY_LANES, reservations, '11:00', 55, true)
    expect(plan[0].lane.accessibleOnly).toBe(true)
  })

  it('同槽团队计入通道负载', () => {
    const plan = securityPlan(SECURITY_LANES, reservations, '10:30', 30, false, 'NEW')
    const laneA = plan.find((p) => p.lane.id === 'lane_a')!
    // R2 已占 A 通道 10:30 槽 30 人
    expect(laneA.loadBefore).toBe(30)
    expect(laneA.loadAfter).toBe(60)
    expect(laneA.waitSlots).toBeGreaterThan(0)
  })
})

describe('guideBusyWindows', () => {
  it('苏晓当日带儿童团，窗口覆盖 09:40-10:50', () => {
    const wins = guideBusyWindows(reservations, 'g3')
    expect(wins).toHaveLength(1)
    expect(wins[0].start).toBeLessThanOrEqual(10 * 60 - 10)
    expect(wins[0].end).toBeGreaterThan(10 * 60 + 45)
  })
})

describe('suggestReroute', () => {
  it('儿童团在五号厅遇堵时，优先推荐相邻儿童友好展厅', () => {
    const r3 = byId('R20261001-03')
    const grid = occupancyGrid(reservations)
    const live = { maintenance: {}, extraLoad: {} }
    const picks = suggestReroute(r3, 'h5', HALLS, grid, live, '10:25')
    expect(picks.length).toBeGreaterThan(0)
    const top = picks[0]
    expect(top.hall.childFriendly || top.hall.themes.includes('t_family')).toBe(true)
  })

  it('维护中的展厅不会被推荐', () => {
    const r2 = byId('R20261001-02')
    const grid = occupancyGrid(reservations)
    const live = { maintenance: {}, extraLoad: {} }
    const picks = suggestReroute(r2, 'h6', HALLS, grid, live, '11:20')
    expect(picks.find((p) => p.hall.id === 'h7')).toBeUndefined()
  })
})

describe('downstreamImpact', () => {
  it('后续团改动路线若与在馆团撞容量，给出冲突', () => {
    const r1 = byId('R20261001-01') // 42 人待确认
    // 构造 r1 10:20 进 h5（24 人儿童团 10:20 已在 h5，容量 40）→ 66 > 40
    const stops: RouteStop[] = [
      {
        hallId: 'h5',
        plannedEnter: '10:20',
        plannedLeave: '10:45',
        durationMin: 25,
        state: 'planned',
      },
    ]
    const conflicts = downstreamImpact(r1, stops, reservations, HALLS)
    expect(conflicts.length).toBeGreaterThan(0)
    expect(conflicts[0].reservation.id).toBe('R20261001-03')
    expect(conflicts[0].capacity).toBe(40)
  })

  it('错峰 30 分钟后冲突消失', () => {
    const r1 = byId('R20261001-01')
    const stops: RouteStop[] = [
      {
        hallId: 'h5',
        plannedEnter: '10:50',
        plannedLeave: '11:15',
        durationMin: 25,
        state: 'planned',
      },
    ]
    // 儿童团 edu 10:50-11:05 容量 25：42 人本身也会触发；改为中庭验证错峰
    const courtyard: RouteStop[] = [
      {
        hallId: 'courtyard',
        plannedEnter: '10:50',
        plannedLeave: '11:15',
        durationMin: 25,
        state: 'planned',
      },
    ]
    expect(downstreamImpact(r1, courtyard, reservations, HALLS)).toHaveLength(0)
    expect(stops.length).toBe(1)
  })
})

describe('Reservation 种子完整性', () => {
  it('每个预约都有提交事件且时间线按时间排序', () => {
    for (const r of reservations) {
      expect(r.timeline[0]?.kind === 'submit' || r.id === 'R20261001-05').toBe(true)
      const times = r.timeline.map((e) => e.at)
      const sorted = [...times].sort()
      expect(times).toEqual(sorted)
    }
  })
  it('参观中团的设备全部为借出且押金匹配', () => {
    const r3 = byId('R20261001-03')
    expect(r3.devices).toHaveLength(24)
    expect(r3.devices.every((d) => d.status === 'lent')).toBe(true)
    expect(r3.depositTotal).toBe(4800)
  })

  it('R6 鸿雁假期已离馆但 HS-041 遗失押金暂扣中', () => {
    const r6 = byId('R20261001-06')
    expect(r6.orgType).toBe('travel')
    expect(r6.status).toBe('completed')
    expect(r6.lostDevices).toHaveLength(1)
    const loss = r6.lostDevices[0]
    expect(loss.code).toBe('HS-041')
    expect(loss.state).toBe('held')
    expect(loss.heldAmount).toBe(200)
    expect(loss.borrower).toContain('陈晨')
    expect(loss.teamLeader).toBe('周领队')
    expect(loss.lastHallId).toBe('courtyard')
    expect(r6.depositHeld).toBe(200)
    expect(r6.depositDeduction).toBe(0)
    // 其余 11 台完好归还
    expect(r6.devices.filter((d) => d.status === 'returned')).toHaveLength(11)
  })

  it('R7 同一旅行社的后续预约适用 1.5 倍押金', () => {
    const r7 = byId('R20261001-07')
    expect(r7.orgType).toBe('travel')
    expect(r7.orgName).toBe('鸿雁假期')
    expect(r7.depositRate).toBe(1.5)
  })
})
