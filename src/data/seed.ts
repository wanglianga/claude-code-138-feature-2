import { HEADSET_DEPOSIT, HALLS, TODAY } from '@/data/museum'
import type { DeviceUnit, LostDeviceRecord, Reservation, RouteStop, TimelineEvent } from '@/types'

export function iso(hm: string, day = TODAY): string {
  return `${day}T${hm}:00`
}

let seq = 0
function ev(
  kind: TimelineEvent['kind'],
  title: string,
  hm: string,
  extra: Partial<TimelineEvent> = {},
): TimelineEvent {
  seq += 1
  return {
    id: `ev_seed_${seq}`,
    at: iso(hm),
    kind,
    title,
    by: extra.by ?? '系统',
    detail: extra.detail,
    amount: extra.amount,
  }
}

function stop(
  hallId: string,
  enter: string,
  leave: string,
  state: RouteStop['state'],
  note?: string,
  actualEnter?: string,
  actualLeave?: string,
): RouteStop {
  const [h1, m1] = enter.split(':').map(Number)
  const [h2, m2] = leave.split(':').map(Number)
  return {
    hallId,
    plannedEnter: enter,
    plannedLeave: leave,
    durationMin: h2 * 60 + m2 - (h1 * 60 + m1),
    state,
    note,
    actualEnter,
    actualLeave,
  }
}

export function makeHeadsets(total: number): DeviceUnit[] {
  return Array.from({ length: total }, (_, i) => ({
    code: `HS-${String(i + 1).padStart(3, '0')}`,
    status: 'available',
    deposit: HEADSET_DEPOSIT,
  }))
}

/** 预置耳麦：R3（参观中）借出 HS-001..024；R5（已离馆）归还 HS-025..040，其中 036 损坏；R6（已离馆）HS-041 遗失暂扣，042..052 已归还 */
function applySeedHeadsets(pool: DeviceUnit[]) {
  for (let i = 0; i < 24; i++) {
    pool[i].status = 'lent'
    pool[i].lentAt = iso('09:45')
  }
  for (let i = 24; i < 40; i++) {
    pool[i].status = 'returned'
    pool[i].lentAt = iso('08:35')
    pool[i].returnedAt = iso('10:05')
  }
  pool[35].status = 'damaged'
  pool[35].damageFee = 50
  pool[35].note = '耳罩开裂'
  // R6 鸿雁假期：HS-041 遗失挂账（押金暂扣中），HS-042..052 已归还
  pool[40].status = 'lost'
  pool[40].lentAt = iso('08:27')
  pool[40].lostResId = 'R20261001-06'
  pool[40].note = '离馆清点缺失；借出人 团员陈晨；团队负责人 周领队；最后使用 中庭 · 公共艺术区'
  for (let i = 41; i < 52; i++) {
    pool[i].status = 'returned'
    pool[i].lentAt = iso('08:27')
    pool[i].returnedAt = iso('10:08')
  }
}

function lentSet(start: number, count: number): DeviceUnit[] {
  return Array.from({ length: count }, (_, i) => ({
    code: `HS-${String(start + i).padStart(3, '0')}`,
    status: 'lent' as const,
    deposit: HEADSET_DEPOSIT,
    lentAt: iso('09:45'),
  }))
}

function returnedSet(start: number, count: number, damagedIdx = -1): DeviceUnit[] {
  return Array.from({ length: count }, (_, i) => ({
    code: `HS-${String(start + i).padStart(3, '0')}`,
    status: i === damagedIdx ? ('damaged' as const) : ('returned' as const),
    deposit: HEADSET_DEPOSIT,
    lentAt: iso('08:35'),
    returnedAt: iso('10:05'),
    damageFee: i === damagedIdx ? 50 : undefined,
    note: i === damagedIdx ? '耳罩开裂' : undefined,
  }))
}

/** R6 鸿雁假期：HS-041 遗失暂扣，HS-042..052 完好归还（共 12 台） */
function r6DeviceSet(): DeviceUnit[] {
  const devs: DeviceUnit[] = [
    {
      code: 'HS-041',
      status: 'lost',
      deposit: HEADSET_DEPOSIT,
      lostResId: 'R20261001-06',
      lentAt: iso('08:27'),
      note: '遗失：离馆清点缺失，最后使用为中庭 · 公共艺术区',
    },
  ]
  for (let i = 41; i < 52; i++) {
    devs.push({
      code: `HS-${String(i + 1).padStart(3, '0')}`,
      status: 'returned',
      deposit: HEADSET_DEPOSIT,
      lentAt: iso('08:27'),
      returnedAt: iso('10:08'),
    })
  }
  return devs
}

const r6Loss: LostDeviceRecord = {
  id: 'loss_seed_hs041',
  code: 'HS-041',
  borrower: '团员陈晨（家长转述）',
  teamLeader: '周领队',
  lastHallId: 'courtyard',
  reportedAt: iso('10:08'),
  note: '团队在中庭公共艺术区自由活动后集合离场，清点时少一台，回拨耳麦无人接听，已通知保洁留意。',
  disposition: 'hold',
  state: 'held',
  heldAmount: 200,
}

export function seedReservations(): Reservation[] {
  seq = 0
  return [
    {
      id: 'R20261001-01',
      orgType: 'school',
      orgName: '云川中学',
      groupSize: 42,
      ageBand: 'youth',
      language: 'zh',
      accessible: false,
      themeId: 't_family',
      arriveTime: iso('10:20'),
      contactName: '赵老师',
      contactPhone: '138****2041',
      busInfo: '大巴 1 辆，停靠团队落客区',
      needHeadsets: true,
      headsetCount: 42,
      note: '初二研学团，含 2 名带队老师，希望互动环节多一些。',
      status: 'submitted',
      createdAt: iso('09:10'),
      assignedGuideIds: [],
      route: [
        stop('h3', '10:20', '10:45', 'planned'),
        stop('h5', '10:50', '11:15', 'planned'),
        stop('edu', '11:20', '11:35', 'planned'),
      ],
      durationMin: 75,
      devices: [],
      depositTotal: 0,
      depositDeduction: 0,
      depositHeld: 0,
      depositRefunded: 0,
      depositRate: 1,
      lostDevices: [],
      timeline: [
        ev('submit', '团体预约已提交', '09:10', { by: '赵老师' }),
      ],
    },
    {
      id: 'R20261001-02',
      orgType: 'travel',
      orgName: '星辉国际旅行社',
      groupSize: 30,
      ageBand: 'adult',
      language: 'en',
      accessible: false,
      themeId: 't_west',
      arriveTime: iso('10:30'),
      contactName: '王领队',
      contactPhone: '139****8810',
      busInfo: '中巴 1 辆，落客区即停即走',
      needHeadsets: true,
      headsetCount: 30,
      note: '外宾团，请安排英语讲解。',
      status: 'confirmed',
      createdAt: iso('09:05'),
      confirmedAt: iso('09:20'),
      confirmNote: '英语讲解员周牧带团，A 通道 10:30 批次入场。',
      assignedGuideIds: ['g2'],
      batchNo: 'B1030',
      securityLane: 'lane_a',
      route: [
        stop('h1', '10:40', '11:08', 'planned'),
        stop('h6', '11:13', '11:41', 'planned'),
        stop('h7', '12:05', '12:33', 'planned', '七厅 11:00-12:00 灯光维护，确认时已调换参观顺序，维护结束后补看'),
      ],
      durationMin: 113,
      devices: [],
      depositTotal: 0,
      depositDeduction: 0,
      depositHeld: 0,
      depositRefunded: 0,
      depositRate: 1,
      lostDevices: [],
      timeline: [
        ev('submit', '团体预约已提交', '09:05', { by: '王领队' }),
        ev('confirm', '预约确认：周牧 / B1030 批次 / A 通道', '09:20', {
          by: '前台主管 沈姐',
          detail: '七厅维护已在路线中标注，视现场情况改道。',
        }),
      ],
    },
    {
      id: 'R20261001-03',
      orgType: 'school',
      orgName: '阳光路第三小学',
      groupSize: 24,
      ageBand: 'children',
      language: 'zh',
      accessible: false,
      themeId: 't_family',
      arriveTime: iso('10:00'),
      contactName: '孙老师',
      contactPhone: '137****5523',
      busInfo: '大巴 2 辆，团队车位 3-4 号',
      needHeadsets: true,
      headsetCount: 24,
      note: '低年级亲子团，已配 6 名家长志愿者。',
      status: 'touring',
      createdAt: iso('08:50'),
      confirmedAt: iso('09:00'),
      assignedGuideIds: ['g3'],
      batchNo: 'B0945',
      securityLane: 'lane_a',
      actualArrive: iso('09:40'),
      verifiedSize: 24,
      route: [
        stop('h3', '09:50', '10:15', 'done', undefined, '09:50', '10:14'),
        stop('h5', '10:20', '10:45', 'current'),
        stop('edu', '10:50', '11:05', 'planned'),
      ],
      durationMin: 75,
      devices: lentSet(1, 24),
      depositTotal: 24 * HEADSET_DEPOSIT,
      depositDeduction: 0,
      depositHeld: 0,
      depositRefunded: 0,
      depositRate: 1,
      lostDevices: [],
      timeline: [
        ev('submit', '团体预约已提交', '08:50', { by: '孙老师' }),
        ev('confirm', '预约确认：苏晓 / B0945 批次', '09:00', { by: '沈姐' }),
        ev('arrive', '团队到馆（比预约早 20 分钟）', '09:40', { by: '孙老师' }),
        ev('headcount', '前台核验人数：24 人，与预约一致', '09:44', { by: '前台 小唐' }),
        ev('device_handout', '发放耳麦 24 台（HS-001 ~ HS-024）', '09:45', {
          by: '设备间 老郭',
          amount: 24 * HEADSET_DEPOSIT,
          detail: '押金 ¥4,800 已收取',
        }),
        ev('guide_assign', '讲解员苏晓就位', '09:46', { by: '苏晓' }),
        ev('batch_admit', 'B0945 批次经 A 通道安检入馆', '09:48', { by: '安检员' }),
        ev('start_tour', '亲子探索线开始讲解', '09:50', { by: '苏晓' }),
      ],
    },
    {
      id: 'R20261001-04',
      orgType: 'enterprise',
      orgName: '远瞻科技',
      groupSize: 55,
      ageBand: 'adult',
      language: 'zh',
      accessible: true,
      themeId: 't_master',
      arriveTime: iso('11:00'),
      contactName: '刘经理',
      contactPhone: '135****7799',
      busInfo: '大巴 2 辆，其中 1 位轮椅使用者需无障碍落客',
      needHeadsets: true,
      headsetCount: 55,
      note: '企业团建，55 人拟分 2~3 批入场；1 人轮椅。',
      status: 'confirmed',
      createdAt: iso('09:15'),
      confirmedAt: iso('09:30'),
      confirmNote: '拆为 25+25+5 三个批次，轮椅成员走红无障碍通道；四号厅无电梯，路线用电梯可达展厅替换。',
      assignedGuideIds: ['g1', 'g5'],
      batchNo: 'B1100',
      securityLane: 'lane_acc',
      route: [
        stop('h2', '11:10', '11:35', 'planned'),
        stop('h6', '11:40', '12:05', 'planned'),
      ],
      durationMin: 55,
      devices: [],
      depositTotal: 0,
      depositDeduction: 0,
      depositHeld: 0,
      depositRefunded: 0,
      depositRate: 1,
      lostDevices: [],
      timeline: [
        ev('submit', '团体预约已提交', '09:15', { by: '刘经理' }),
        ev('confirm', '预约确认：林岚+何田田 / 分 3 批 / 无障碍通道', '09:30', {
          by: '沈姐',
          detail: '四号厅无障碍不可达，已从路线移除并替换为六号厅。',
        }),
      ],
    },
    {
      id: 'R20261001-05',
      orgType: 'school',
      orgName: '晨光职业学校',
      groupSize: 16,
      ageBand: 'youth',
      language: 'zh',
      accessible: false,
      themeId: 't_modern',
      arriveTime: iso('08:30'),
      contactName: '钱老师',
      contactPhone: '136****1188',
      busInfo: '中巴 1 辆',
      needHeadsets: true,
      headsetCount: 16,
      note: '',
      status: 'completed',
      createdAt: iso('08:00'),
      confirmedAt: iso('08:05'),
      assignedGuideIds: ['g5'],
      batchNo: 'B0830',
      securityLane: 'lane_a',
      actualArrive: iso('08:31'),
      verifiedSize: 16,
      route: [
        stop('h1', '08:40', '09:10', 'done', undefined, '08:40', '09:08'),
        stop('h2', '09:15', '09:45', 'congested', '二号厅 09:20 起散客激增，团队压缩至 20 分钟后分流', '09:15', '09:35'),
        stop('h4', '09:40', '10:05', 'done', undefined, '09:40', '10:02'),
      ],
      durationMin: 90,
      devices: returnedSet(25, 16, 11),
      depositTotal: 16 * HEADSET_DEPOSIT,
      depositDeduction: 50,
      depositHeld: 0,
      depositRefunded: 0,
      depositRate: 1,
      lostDevices: [],
      departAt: iso('10:05'),
      satisfaction: 3,
      complaint:
        '二号厅等待和拥挤导致讲解明显缩水，比承诺的 90 分钟少了约 20 分钟，希望给出说明。',
      timeline: [
        ev('submit', '团体预约已提交', '08:00', { by: '钱老师' }),
        ev('confirm', '预约确认：何田田 / B0830 批次', '08:05', { by: '沈姐' }),
        ev('arrive', '团队到馆', '08:31', { by: '钱老师' }),
        ev('headcount', '核验人数：16 人', '08:33', { by: '小唐' }),
        ev('device_handout', '发放耳麦 16 台（HS-025 ~ HS-040）', '08:35', {
          by: '老郭',
          amount: 3200,
        }),
        ev('batch_admit', 'B0830 批次入馆', '08:38', { by: '安检员' }),
        ev('start_tour', '近现代书画线开始讲解', '08:40', { by: '何田田' }),
        ev('hall_congestion', '二号厅散客激增（在场约 44/45），启动分流', '09:20', {
          by: '苏晓',
          detail: '二号厅压缩停留至 20 分钟，提前转入四号厅。',
        }),
        ev('reroute', '路线调整：二号厅 → 四号厅（提前 5 分钟）', '09:35', { by: '何田田' }),
        ev('device_return', '归还耳麦 16 台，HS-036 耳罩开裂', '10:04', {
          by: '老郭',
          detail: '15 台完好，1 台损坏。',
        }),
        ev('deposit_settle', '押金结算：¥3,200 中扣除损坏赔偿 ¥50，退还 ¥3,150', '10:05', {
          by: '老郭',
          amount: 50,
        }),
        ev('complete', '团队离馆，满意度 3/5', '10:05', { by: '小唐' }),
        ev('complaint', '投诉：讲解缩水、等待过长', '10:20', {
          by: '钱老师',
          detail: '二号厅拥挤导致讲解时长缩短约 20 分钟。',
        }),
      ],
    },
    {
      // R6：旅行社团已离馆，但 HS-041 遗失押金暂扣中——用于演示保洁后续核查与押金处理
      id: 'R20261001-06',
      orgType: 'travel',
      orgName: '鸿雁假期',
      groupSize: 12,
      ageBand: 'mixed',
      language: 'zh',
      accessible: false,
      themeId: 't_sculpture',
      arriveTime: iso('08:25'),
      contactName: '周领队',
      contactPhone: '137****9032',
      busInfo: '商务车 1 辆，落客区即停即走',
      needHeadsets: true,
      headsetCount: 12,
      note: '半日精品小团，含 2 名儿童。',
      status: 'completed',
      createdAt: iso('08:00'),
      confirmedAt: iso('08:08'),
      assignedGuideIds: ['g3'],
      batchNo: 'B0830',
      securityLane: 'lane_b',
      actualArrive: iso('08:25'),
      verifiedSize: 12,
      route: [
        stop('h3', '08:35', '09:02', 'done', undefined, '08:35', '09:00'),
        stop('h5', '09:07', '09:34', 'done', undefined, '09:05', '09:32'),
        stop('courtyard', '09:39', '10:06', 'done', undefined, '09:37', '10:06'),
      ],
      durationMin: 91,
      devices: r6DeviceSet(),
      depositTotal: 12 * HEADSET_DEPOSIT,
      depositDeduction: 0,
      depositHeld: 200,
      depositRefunded: 0,
      depositRate: 1,
      lostDevices: [r6Loss],
      departAt: iso('10:09'),
      satisfaction: 4,
      timeline: [
        ev('submit', '团体预约已提交', '08:00', { by: '周领队' }),
        ev('confirm', '预约确认：苏晓 / B0830 批次 / B 通道', '08:08', { by: '沈姐' }),
        ev('arrive', '团队到馆（准时）', '08:25', { by: '周领队' }),
        ev('headcount', '前台核验人数：12 人，与预约一致', '08:26', { by: '小唐' }),
        ev('device_handout', '发放耳麦 12 台（HS-041 ~ HS-052）', '08:27', {
          by: '老郭',
          amount: 12 * HEADSET_DEPOSIT,
          detail: '押金 ¥2,400 已收取',
        }),
        ev('batch_admit', 'B0830 批次经 B 通道安检入馆', '08:30', { by: '安检员' }),
        ev('start_tour', '雕塑与公共艺术线开始讲解', '08:35', { by: '苏晓' }),
        ev('device_return', '归还耳麦 11 台（HS-042 ~ HS-052），HS-041 清点缺失', '10:08', {
          by: '老郭',
          detail: '11 台完好；HS-041 暂按遗失登记。',
        }),
        ev('device_lost_report', '耳麦 HS-041 离馆清点缺失（押金暂扣）', '10:08', {
          by: '前台主管 沈姐',
          amount: 200,
          detail:
            '借出人：团员陈晨（家长转述）；团队负责人：周领队；最后使用展厅：中庭 · 公共艺术区。团队在中庭自由活动后集合离场，回拨耳麦无人接听，已通知保洁留意。',
        }),
        ev('deposit_held', '押金暂扣 ¥200：等待保洁核查 HS-041', '10:08', {
          by: '前台主管 沈姐',
          amount: 200,
        }),
        ev('deposit_settle', '押金阶段性结算：¥2,400 中扣除 ¥0、暂扣 ¥200 待保洁核查，现退 ¥2,200', '10:09', {
          by: '老郭',
          amount: 0,
        }),
        ev('complete', '团队先行离馆，满意度 4/5；遗失设备待保洁后续核查', '10:09', { by: '小唐' }),
      ],
    },
    {
      // R7：同一家旅行社的下午后续预约——受 HS-041 遗失记录影响，押金按 1.5 倍收取
      id: 'R20261001-07',
      orgType: 'travel',
      orgName: '鸿雁假期',
      groupSize: 20,
      ageBand: 'adult',
      language: 'zh',
      accessible: false,
      themeId: 't_master',
      arriveTime: iso('13:30'),
      contactName: '周领队',
      contactPhone: '137****9032',
      busInfo: '中巴 1 辆',
      needHeadsets: true,
      headsetCount: 20,
      note: '同一家旅行社下午加开场次；上午场有一台耳麦遗失暂扣未结案。',
      status: 'submitted',
      createdAt: iso('10:20'),
      assignedGuideIds: [],
      route: [
        stop('h2', '13:40', '14:03', 'planned'),
        stop('h4', '14:08', '14:31', 'planned'),
        stop('h6', '14:36', '14:49', 'planned'),
      ],
      durationMin: 69,
      devices: [],
      depositTotal: 0,
      depositDeduction: 0,
      depositHeld: 0,
      depositRefunded: 0,
      depositRate: 1.5,
      lostDevices: [],
      timeline: [
        ev('submit', '团体预约已提交（系统提示该旅行社有未结案耳麦遗失，押金按 1.5 倍收取）', '10:20', {
          by: '周领队',
          detail: '20 台耳麦 × ¥300 = ¥6,000 押金，确认时向领队明示。',
        }),
      ],
    },
  ]
}

export function seedHeadsets(): DeviceUnit[] {
  const pool = makeHeadsets(120)
  applySeedHeadsets(pool)
  return pool
}

export const ALL_HALL_IDS = HALLS.map((h) => h.id)
