/** 领域模型：美术馆团体参观预约 · 设备借还 · 展厅分流 */

export type GroupType = 'school' | 'enterprise' | 'travel'
export type AgeBand = 'children' | 'youth' | 'adult' | 'senior' | 'mixed'
export type Language = 'zh' | 'en' | 'ja'

export type ReservationStatus =
  | 'submitted' // 已提交，待馆方确认
  | 'confirmed' // 馆方已确认
  | 'arrived' // 已到馆，前台核验中
  | 'touring' // 参观进行中
  | 'completed' // 已离馆
  | 'rejected' // 馆方驳回
  | 'cancelled' // 预约方取消

export const STATUS_LABEL: Record<ReservationStatus, string> = {
  submitted: '待确认',
  confirmed: '已确认',
  arrived: '已到馆',
  touring: '参观中',
  completed: '已离馆',
  rejected: '已驳回',
  cancelled: '已取消',
}

export const GROUP_TYPE_LABEL: Record<GroupType, string> = {
  school: '学校',
  enterprise: '企业',
  travel: '旅行社',
}

export const AGE_LABEL: Record<AgeBand, string> = {
  children: '儿童为主',
  youth: '青少年',
  adult: '成人',
  senior: '银发长者',
  mixed: '年龄混合',
}

export const LANG_LABEL: Record<Language, string> = {
  zh: '中文',
  en: '英语',
  ja: '日语',
}

/** 路线站点 */
export interface RouteStop {
  hallId: string
  plannedEnter: string // HH:mm
  plannedLeave: string
  durationMin: number
  actualEnter?: string
  actualLeave?: string
  /** planned 待参观 / current 正在参观 / done 已完成 / skipped 跳过 / maintenance 临时维护 / congested 拥堵避让 */
  state: 'planned' | 'current' | 'done' | 'skipped' | 'maintenance' | 'congested'
  note?: string
}

export type EventKind =
  | 'submit'
  | 'confirm'
  | 'reject'
  | 'cancel'
  | 'arrive'
  | 'headcount'
  | 'device_handout'
  | 'device_exchange'
  | 'guide_assign'
  | 'guide_swap'
  | 'batch_admit'
  | 'start_tour'
  | 'hall_congestion'
  | 'late'
  | 'child_lost'
  | 'device_broken'
  | 'device_lost_report'
  | 'deposit_held'
  | 'device_found'
  | 'deposit_refund'
  | 'reroute'
  | 'maintenance'
  | 'wait'
  | 'device_return'
  | 'deposit_settle'
  | 'satisfaction'
  | 'complete'
  | 'complaint'

export interface TimelineEvent {
  id: string
  at: string // ISO 时间
  kind: EventKind
  title: string
  detail?: string
  amount?: number // 涉及金额（元）
  by: string // 操作人/系统
}

export type DeviceStatus = 'available' | 'lent' | 'returned' | 'damaged' | 'lost' | 'repairing'

export const DEVICE_STATUS_LABEL: Record<DeviceStatus, string> = {
  available: '在库',
  lent: '借出',
  returned: '已归还',
  damaged: '损坏',
  lost: '遗失',
  repairing: '送修',
}

/** 离馆遗失处置方式 */
export type LossDisposition = 'search' | 'hold' | 'paid'
export const LOSS_DISPOSITION_LABEL: Record<LossDisposition, string> = {
  search: '现场寻找',
  hold: '押金暂扣',
  paid: '当场赔付',
}

/** 遗失记录的处理状态 */
export type LossState = 'searching' | 'held' | 'paid' | 'refunded' | 'repaired'
export const LOSS_STATE_LABEL: Record<LossState, string> = {
  searching: '现场寻找中',
  held: '押金暂扣中',
  paid: '已赔付结案',
  refunded: '找回无损·押金退还',
  repaired: '找回损坏·扣除维修费',
}

/** 耳麦遗失档案：随预约永久留痕，并计入该旅行社后续押金等级 */
export interface LostDeviceRecord {
  id: string
  code: string
  /** 实际使用/借出该耳麦的团员或工作人员 */
  borrower: string
  /** 团队负责人（老师 / 领队） */
  teamLeader: string
  /** 最后使用展厅 */
  lastHallId: string
  reportedAt: string
  note: string
  disposition: LossDisposition
  state: LossState
  /** 暂扣金额（= 该台押金，按收押金倍率计） */
  heldAmount: number
  /** 最终扣款（赔付 ¥200 或维修费 ¥50） */
  finalFee?: number
  /** 保洁/工作人员找回时间 */
  foundAt?: string
  /** 找回时设备情况 */
  foundCondition?: 'ok' | 'damaged'
  foundBy?: string
  resolvedNote?: string
}

export interface DeviceUnit {
  code: string
  status: DeviceStatus
  deposit: number // 单台押金
  resId?: string // 当前借出预约
  lentAt?: string
  returnedAt?: string
  damageFee?: number // 损坏/遗失扣款
  note?: string
  /** 遗失挂账预约（lost 状态下保留，用于后续找回核销） */
  lostResId?: string
}

export interface Reservation {
  id: string
  orgType: GroupType
  orgName: string
  groupSize: number
  ageBand: AgeBand
  language: Language
  accessible: boolean
  themeId: string
  arriveTime: string // ISO，预计到馆
  contactName: string
  contactPhone: string
  busInfo: string
  needHeadsets: boolean
  headsetCount: number
  note: string

  status: ReservationStatus
  createdAt: string

  // —— 馆方确认 ——
  confirmedAt?: string
  confirmNote?: string
  assignedGuideIds: string[]
  batchNo?: string
  securityLane?: string

  // —— 到馆核验 ——
  actualArrive?: string
  verifiedSize?: number

  // —— 路线与时长 ——
  route: RouteStop[]
  durationMin: number

  // —— 设备与押金 ——
  devices: DeviceUnit[]
  depositTotal: number
  /** 已确定扣款（损坏 ¥50 / 遗失赔付 ¥200 / 找回损坏维修费 ¥50） */
  depositDeduction: number
  /** 押金暂扣总额（遗失待保洁核查，尚未退还也未扣除） */
  depositHeld: number
  /** 已退还押金总额（含暂扣后核查退还） */
  depositRefunded: number
  /** 收押金倍率：有遗失记录的旅行社后续按 1.5 倍收取 */
  depositRate: number
  /** 耳麦遗失档案（影响该旅行社后续押金等级） */
  lostDevices: LostDeviceRecord[]

  // —— 离馆 ——
  departAt?: string
  satisfaction?: number // 1-5
  complaint?: string
  complaintReply?: string

  timeline: TimelineEvent[]
}

export interface Exhibit {
  id: string
  name: string
  hot?: boolean // 热门展品
  noPhoto?: boolean // 禁止拍照
  recommendedAge?: number // 建议最低年龄
}

export interface HallClosure {
  start: string // HH:mm
  end: string
  reason: string
}

export interface Hall {
  id: string
  name: string
  floor: string
  capacity: number
  childFriendly: boolean
  accessible: boolean // 无障碍可达
  quiet: 1 | 2 | 3 // 安静等级：3 最安静
  themes: string[]
  exhibits: Exhibit[]
  closures: HallClosure[] // 当日临时闭展/维护
  nearTo: string[] // 相邻展厅（用于步行时间/分流）
}

export interface Theme {
  id: string
  name: string
  desc: string
  durationMin: number
  hallIds: string[] // 标准参观顺序
}

export interface GuideShift {
  start: string
  end: string
}

export interface Guide {
  id: string
  name: string
  langs: Language[]
  themes: string[]
  shifts: GuideShift[] // 当日排班
  phone: string
  rating: number // 近30日好评率
}

export interface SecurityLane {
  id: string
  name: string
  perSlot: number // 每 15 分钟可检人数
  accessibleOnly?: boolean
}
