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
  | 'device_lost_report'
  | 'deposit_withhold'
  | 'device_found'
  | 'guide_assign'
  | 'guide_swap'
  | 'batch_admit'
  | 'start_tour'
  | 'hall_congestion'
  | 'late'
  | 'child_lost'
  | 'device_broken'
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

export type DeviceStatus =
  | 'available' // 在库可借
  | 'lent' // 借出中
  | 'returned' // 已完好归还
  | 'damaged' // 损坏（已判赔/待赔）
  | 'lost' // 遗失（保洁未找回）
  | 'repairing' // 保洁找回但需维修，暂不可再借出

export const DEVICE_STATUS_LABEL: Record<DeviceStatus, string> = {
  available: '在库',
  lent: '借出',
  returned: '已归还',
  damaged: '损坏',
  lost: '遗失',
  repairing: '维修中',
}

/** 离馆清点时的耳麦遗失登记与押金处置 */
export type LostResolution =
  | 'searching' // 团队选择现场寻找，暂不结算该台
  | 'withheld' // 押金暂扣，等待保洁查找结果
  | 'paid' // 团队直接赔付，押金按遗失扣款

/** 保洁找回设备后的核验结论 */
export type FoundOutcome = 'intact' | 'repair'

export interface LostDeviceRecord {
  /** 登记序号，用于操作定位 */
  key: string
  code: string
  /** 借出人（耳麦实际使用/归还责任人，如团员姓名） */
  borrower: string
  /** 团队负责人（领队/带队老师） */
  leader: string
  /** 最后使用展厅 */
  lastHallId: string
  note?: string
  reportedAt: string
  /** 团队当场选择的处置方式 */
  resolution: LostResolution
  /** 暂扣押金金额（按该团单台押金费率） */
  withheldAmount: number
  paidAt?: string
  /** 保洁找回时间 */
  foundAt?: string
  /** 找回时设备核验结论：完好 / 需维修 */
  foundOutcome?: FoundOutcome
  /** 找回需维修时扣除的维修费 */
  repairFee?: number
  foundBy?: string
  resolvedAt?: string
  /** 最终结论：pending 待保洁结果 / refund 全额退押金 / repair 扣维修费退余额 / forfeit 押金不退（赔付或确认无法找回） */
  outcome: 'pending' | 'refund' | 'repair' | 'forfeit'
}

export interface DeviceUnit {
  code: string
  status: DeviceStatus
  deposit: number // 单台押金（该团实际收取费率，可能为加收费率）
  resId?: string // 当前借出预约
  lentAt?: string
  returnedAt?: string
  damageFee?: number // 损坏/遗失扣款
  note?: string
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
  /** 本团实际执行的单台押金费率（受该旅行社历史遗失记录影响可能加收） */
  depositPerUnit: number
  depositTotal: number
  depositDeduction: number
  /** 离馆清点时登记的遗失耳麦及其押金处置/保洁找回结论 */
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
