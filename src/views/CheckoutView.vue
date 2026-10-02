<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DAMAGE_FEE, LOST_FEE, REPAIR_FEE } from '@/data/museum'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'
import { useSessionStore } from '@/stores/session'
import { hmOfISO } from '@/lib/time'
import StatusBadge from '@/components/StatusBadge.vue'
import { LOSS_STATE_LABEL, type LossDisposition } from '@/types'

const store = useReservationsStore()
const museum = useMuseumStore()
const session = useSessionStore()
const route = useRoute()
const router = useRouter()

/** 参观中待核销 + 已离馆但耳麦遗失押金尚未结案（保洁可能后续找回） */
const queue = computed(() =>
  [...store.list]
    .filter(
      (r) =>
        r.status === 'touring' ||
        (r.status === 'completed' && (r.lostDevices ?? []).some((l) => ['searching', 'held'].includes(l.state))),
    )
    .sort((a, b) => (b.actualArrive ?? '').localeCompare(a.actualArrive ?? '')),
)
const selectedId = ref((route.params.id as string) || '')
watch(queue, (q) => {
  if (!q.some((r) => r.id === selectedId.value) && q[0]) selectedId.value = q[0].id
}, { immediate: true })

const r = computed(() => store.byId(selectedId.value))

type CheckResult = 'ok' | 'damaged' | 'lost'
const checks = ref<Record<string, { result: CheckResult; note: string }>>({})
const satisfaction = ref(5)

interface LossForm {
  borrower: string
  teamLeader: string
  lastHallId: string
  disposition: LossDisposition
  note: string
}
const lossForms = ref<Record<string, LossForm>>({})

watch(
  selectedId,
  () => {
    checks.value = {}
    satisfaction.value = 5
    lossForms.value = {}
    if (r.value) {
      const lastHall =
        [...r.value.route].reverse().find((s) => s.state === 'done')?.hallId ??
        r.value.route[r.value.route.length - 1]?.hallId ??
        ''
      for (const d of r.value.devices) {
        const loss = r.value.lostDevices?.find((l) => l.code === d.code)
        checks.value[d.code] = {
          result: d.status === 'damaged' || d.status === 'repairing' ? 'damaged' : d.status === 'lost' ? 'lost' : 'ok',
          note: d.note ?? '',
        }
        if (d.status === 'lent') {
          lossForms.value[d.code] = {
            borrower: '',
            teamLeader: r.value.contactName,
            lastHallId: lastHall,
            disposition: 'hold',
            note: '',
          }
        } else if (loss) {
          lossForms.value[d.code] = {
            borrower: loss.borrower,
            teamLeader: loss.teamLeader,
            lastHallId: loss.lastHallId,
            disposition: loss.disposition,
            note: loss.note,
          }
        }
      }
    }
  },
  { immediate: true },
)

const stats = computed(() => {
  let ok = 0, damaged = 0, lost = 0
  for (const v of Object.values(checks.value)) {
    if (v.result === 'ok') ok++
    else if (v.result === 'damaged') damaged++
    else lost++
  }
  return { ok, damaged, lost }
})

/** 提交前预估：当场赔付台数 / 暂扣台数（按该团实际单台押金） */
const preview = computed(() => {
  let paid = 0
  let held = 0
  for (const code of lostCodesPending.value) {
    const f = lossForms.value[code]
    const dev = r.value?.devices.find((d) => d.code === code)
    if (f.disposition === 'paid') paid++
    else held += dev?.deposit ?? 0
  }
  return {
    paid,
    held,
    deduction: stats.value.damaged * DAMAGE_FEE + paid * LOST_FEE,
  }
})

const returned = computed(() =>
  r.value?.timeline.some((e) => e.kind === 'device_return' || e.kind === 'device_lost_report'),
)
const settled = computed(() => r.value?.timeline.some((e) => e.kind === 'deposit_settle'))

/** 已离馆后的未结案遗失（现场寻找中 / 押金暂扣中） */
const outstandingLosses = computed(() =>
  (r.value?.lostDevices ?? []).filter((l) => l.state === 'searching' || l.state === 'held'),
)
const closedLosses = computed(() =>
  (r.value?.lostDevices ?? []).filter((l) => !['searching', 'held'].includes(l.state)),
)

/** 保洁找回登记表单 */
const resolveForms = ref<Record<string, { foundBy: string; note: string }>>({})
watch(outstandingLosses, (list) => {
  for (const l of list) {
    if (!resolveForms.value[l.id]) resolveForms.value[l.id] = { foundBy: '保洁', note: '' }
  }
}, { immediate: true })

function lossFormValid(code: string): boolean {
  const f = lossForms.value[code]
  return !!f && !!f.borrower.trim() && !!f.teamLeader.trim() && !!f.lastHallId
}

/** 切换清点状态；切到遗失时确保登记表单已初始化（含途中换机已损坏的设备） */
function setResult(code: string, result: CheckResult) {
  checks.value[code].result = result
  if (result === 'lost' && !lossForms.value[code] && r.value) {
    const lastHall =
      [...r.value.route].reverse().find((s) => s.state === 'done')?.hallId ??
      r.value.route[r.value.route.length - 1]?.hallId ??
      ''
    lossForms.value[code] = {
      borrower: '',
      teamLeader: r.value.contactName,
      lastHallId: lastHall,
      disposition: 'hold',
      note: '',
    }
  }
}
const lostCodesPending = computed(() =>
  Object.entries(checks.value)
    .filter(([, v]) => v.result === 'lost')
    .map(([code]) => code),
)
const canSubmitReturn = computed(() => lostCodesPending.value.every(lossFormValid))

function submitReturn() {
  if (!r.value || !canSubmitReturn.value) return
  // 完好 / 损坏走批量清点
  const normal = Object.entries(checks.value)
    .filter(([, v]) => v.result !== 'lost')
    .map(([code, v]) => ({ code, result: v.result as 'ok' | 'damaged', note: v.note }))
  if (normal.length) store.returnDevices(selectedId.value, normal, session.staffName)
  // 遗失逐台登记：设备编号 + 借出人 + 团队负责人 + 最后使用展厅 + 处置方式
  for (const code of lostCodesPending.value) {
    if (r.value.lostDevices?.some((l) => l.code === code)) continue
    const f = lossForms.value[code]
    store.reportLostDevice(
      selectedId.value,
      {
        code,
        borrower: f.borrower.trim(),
        teamLeader: f.teamLeader.trim(),
        lastHallId: f.lastHallId,
        note: f.note.trim() || '离馆清点设备缺失',
        disposition: f.disposition,
      },
      session.staffName,
    )
  }
}
function settle() {
  store.settleDeposit(selectedId.value, session.staffName)
}
function finish() {
  store.complete(selectedId.value, satisfaction.value, session.staffName)
  router.push('/trace/' + selectedId.value)
}

function resolveFound(lossId: string, condition: 'ok' | 'damaged') {
  const f = resolveForms.value[lossId]
  store.resolveLostDevice(
    selectedId.value,
    lossId,
    { found: true, condition, foundBy: f.foundBy.trim() || '保洁', note: f.note.trim() },
    session.staffName,
  )
}
function resolvePaid(lossId: string) {
  const f = resolveForms.value[lossId]
  store.resolveLostDevice(
    selectedId.value,
    lossId,
    { found: false, foundBy: f.foundBy.trim() || '保洁', note: f.note.trim() || '保洁核查后仍未找到，按遗失 ¥200 赔付结案' },
    session.staffName,
  )
}

const hallName = (id: string) => museum.hallById(id)?.name ?? '—'
</script>

<template>
  <div v-if="!r" class="card empty">没有等待离馆核销、或有遗失押金待处理的团队。</div>

  <div v-else class="grid" style="grid-template-columns: 280px 1fr; align-items:start">
    <div class="card" style="padding:6px">
      <div class="card-title" style="margin:6px 8px">待核销 / 押金挂账</div>
      <div v-for="q in queue" :key="q.id" class="queue-item"
           :style="q.id === selectedId ? 'background:var(--paper-2)' : ''" @click="selectedId = q.id">
        <strong style="font-size:13px">{{ q.orgName }}</strong>
        <div class="small muted">{{ q.verifiedSize ?? q.groupSize }} 人 · 借出 {{ q.devices.length }} 台</div>
        <div style="margin-top:4px; display:flex; gap:6px; align-items:center; flex-wrap:wrap">
          <StatusBadge :status="q.status" />
          <span v-if="(q.lostDevices ?? []).some((l) => ['searching','held'].includes(l.state))"
                class="tag tag-maint">押金暂扣中</span>
        </div>
      </div>
    </div>

    <div style="display:flex; flex-direction:column; gap:14px">
      <div class="card">
        <div class="card-title">
          {{ r.orgName }} · {{ r.id }}
          <span class="aside">
            入馆 {{ r.actualArrive?.slice(11, 16) }}
            <template v-if="r.depositRate > 1"> · 押金倍率 {{ r.depositRate }}×（有遗失记录旅行社）</template>
          </span>
        </div>

        <div class="grid grid-4">
          <div><div class="stat-label">应还耳麦</div><div class="stat-num">{{ r.devices.length }}</div></div>
          <div><div class="stat-label">完好</div><div class="stat-num" style="color:var(--green)">{{ stats.ok }}</div></div>
          <div><div class="stat-label">损坏 / 遗失</div><div class="stat-num" style="color:var(--red)">{{ stats.damaged }} / {{ stats.lost }}</div></div>
          <div><div class="stat-label">押金暂扣</div><div class="stat-num money" style="color:var(--amber)">¥{{ r.depositHeld }}</div></div>
        </div>
      </div>

      <!-- ============ 已离馆：保洁找回后续处理 ============ -->
      <template v-if="r.status === 'completed'">
        <div class="card" :style="outstandingLosses.length ? 'border-color:var(--amber)' : ''">
          <div class="card-title">
            耳麦遗失后续处理（保洁核查）
            <span class="aside">按找回设备状态：完好退押金 · 损坏扣维修费 ¥{{ REPAIR_FEE }} · 找不到转赔付 ¥{{ LOST_FEE }}</span>
          </div>

          <div v-if="!outstandingLosses.length" class="empty">
            该团没有待核查的遗失设备。
          </div>

          <div v-for="loss in outstandingLosses" :key="loss.id" class="callout warn" style="margin-bottom:12px">
            <div style="display:flex; flex-wrap:wrap; gap:6px 20px; align-items:baseline">
              <strong class="mono" style="font-size:15px">{{ loss.code }}</strong>
              <span class="tag tag-maint">{{ LOSS_STATE_LABEL[loss.state] }}</span>
              <span class="small muted">登记于 {{ hmOfISO(loss.reportedAt) }} · 暂扣 ¥{{ loss.heldAmount }}</span>
            </div>
            <table class="data" style="margin:8px 0">
              <tbody>
                <tr><td class="small muted" style="width:110px">借出人</td><td class="small">{{ loss.borrower }}</td></tr>
                <tr><td class="small muted">团队负责人</td><td class="small">{{ loss.teamLeader }}</td></tr>
                <tr><td class="small muted">最后使用展厅</td><td class="small">{{ hallName(loss.lastHallId) }}</td></tr>
                <tr><td class="small muted">登记说明</td><td class="small">{{ loss.note }}</td></tr>
              </tbody>
            </table>
            <div class="form-row" style="align-items:end; gap:10px">
              <div class="field" style="margin:0; width:170px">
                <label>找回/核查人</label>
                <input v-model="resolveForms[loss.id].foundBy" placeholder="如：保洁 王阿姨" />
              </div>
              <div class="field" style="margin:0; flex:1">
                <label>找回位置 / 设备情况</label>
                <input v-model="resolveForms[loss.id].note" placeholder="如：中庭长椅缝隙找到，外观完好 / 耳罩已开裂" />
              </div>
            </div>
            <div class="pill-row" style="margin-top:10px">
              <button class="btn-sm" style="border-color:var(--green); color:var(--green)"
                      @click="resolveFound(loss.id, 'ok')">
                ✓ 找回且完好——退还押金 ¥{{ loss.heldAmount }}
              </button>
              <button class="btn-sm" style="border-color:var(--amber); color:var(--amber)"
                      @click="resolveFound(loss.id, 'damaged')">
                🔧 找回但损坏——扣维修费 ¥{{ REPAIR_FEE }}，退 ¥{{ Math.max(0, loss.heldAmount - REPAIR_FEE) }}
              </button>
              <button class="btn-sm btn-danger" @click="resolvePaid(loss.id)">
                ✕ 仍未找到——按遗失赔付 ¥{{ LOST_FEE }} 结案
              </button>
            </div>
          </div>

          <div v-if="closedLosses.length">
            <div class="small muted" style="margin:8px 0 4px">已结案遗失记录（计入该旅行社押金信用）</div>
            <table class="data">
              <thead><tr><th>设备编号</th><th>状态</th><th>扣款</th><th>找回/结案时间</th><th>说明</th></tr></thead>
              <tbody>
                <tr v-for="loss in closedLosses" :key="loss.id">
                  <td class="mono small"><strong>{{ loss.code }}</strong></td>
                  <td class="small">{{ LOSS_STATE_LABEL[loss.state] }}</td>
                  <td class="small money">{{ loss.finalFee ? `¥${loss.finalFee}` : '¥0' }}</td>
                  <td class="small mono">{{ loss.foundAt ? hmOfISO(loss.foundAt) : hmOfISO(loss.reportedAt) }}</td>
                  <td class="small muted">{{ loss.resolvedNote || loss.note }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 已离馆团的押金总览 -->
        <div class="card">
          <div class="card-title">押金流水</div>
          <dl class="kv">
            <dt>已收押金</dt><dd class="money">¥{{ r.depositTotal.toLocaleString() }}</dd>
            <dt>累计扣款</dt><dd class="money">¥{{ r.depositDeduction }}（损坏维修 / 遗失赔付）</dd>
            <dt>暂扣中</dt><dd class="money" :style="r.depositHeld ? 'color:var(--amber)' : ''">¥{{ r.depositHeld }}</dd>
            <dt>已退还</dt><dd class="money" style="color:var(--green)">¥{{ r.depositRefunded }}</dd>
          </dl>
          <RouterLink class="btn-sm btn-gold" :to="`/trace/${r.id}`">查看完整追溯档案</RouterLink>
        </div>
      </template>

      <!-- ============ 参观中：离馆清点 ============ -->
      <template v-else>
        <div class="card">
          <div class="card-title">
            逐台核对耳麦归还
            <span class="aside">损坏 ¥{{ DAMAGE_FEE }}/台 · 遗失 ¥{{ LOST_FEE }}/台；标记遗失需登记借出人、负责人与最后使用展厅</span>
          </div>
          <div v-if="!r.devices.length" class="empty">该团未借用耳麦。</div>
          <table v-else class="data">
            <thead><tr><th>设备编号</th><th>借出时间</th><th>归还状态</th><th>备注 / 遗失登记</th></tr></thead>
            <tbody>
              <tr v-for="d in r.devices" :key="d.code">
                <td class="mono"><strong>{{ d.code }}</strong></td>
                <td class="small mono">{{ d.lentAt?.slice(11, 16) }}</td>
                <td>
                  <div class="pill-row">
                    <button class="btn-sm" :style="checks[d.code]?.result === 'ok' ? 'background:var(--green);color:#fff;border-color:var(--green)' : ''"
                            @click="setResult(d.code, 'ok')">✓ 完好归还</button>
                    <button class="btn-sm btn-danger" :style="checks[d.code]?.result === 'damaged' ? 'background:var(--red);color:#fff' : ''"
                            @click="setResult(d.code, 'damaged')">损 坏</button>
                    <button class="btn-sm" style="border-color:#7a6740;color:var(--amber)"
                            :style="checks[d.code]?.result === 'lost' ? 'background:var(--amber);color:#fff;border-color:var(--amber)' : ''"
                            @click="setResult(d.code, 'lost')">遗 失</button>
                  </div>
                </td>
                <td style="min-width:300px">
                  <!-- 遗失登记：设备编号即本行编码 -->
                  <div v-if="checks[d.code]?.result === 'lost'" style="display:flex; flex-direction:column; gap:7px">
                    <div class="grid grid-2" style="gap:7px">
                      <input v-model="lossForms[d.code].borrower" placeholder="* 借出人（团员/工作人员）"
                             :class="lossForms[d.code]?.borrower ? '' : 'input-warn'" />
                      <input v-model="lossForms[d.code].teamLeader" placeholder="* 团队负责人" />
                    </div>
                    <select v-model="lossForms[d.code].lastHallId">
                      <option value="" disabled>* 最后使用展厅</option>
                      <option v-for="s in r.route" :key="s.hallId" :value="s.hallId">{{ hallName(s.hallId) }}</option>
                    </select>
                    <input v-model="lossForms[d.code].note" placeholder="遗失情况说明（可选）" />
                    <div class="pill-row">
                      <button class="btn-sm" :style="lossForms[d.code].disposition === 'search' ? 'background:var(--blue);color:#fff;border-color:var(--blue)' : 'border-color:var(--blue);color:var(--blue)'"
                              @click="lossForms[d.code].disposition = 'search'">🔍 现场寻找</button>
                      <button class="btn-sm" :style="lossForms[d.code].disposition === 'hold' ? 'background:var(--amber);color:#fff' : 'border-color:var(--amber);color:var(--amber)'"
                              @click="lossForms[d.code].disposition = 'hold'">⏸ 押金暂扣</button>
                      <button class="btn-sm btn-danger" :style="lossForms[d.code].disposition === 'paid' ? 'background:var(--red);color:#fff' : ''"
                              @click="lossForms[d.code].disposition = 'paid'">💴 当场赔付 ¥{{ LOST_FEE }}</button>
                    </div>
                    <div class="small muted">
                      <template v-if="lossForms[d.code].disposition === 'search'">团队先在场馆内寻找，押金暂缓结算；闭馆前未找到可转暂扣或赔付。</template>
                      <template v-else-if="lossForms[d.code].disposition === 'hold'">暂扣该台押金 ¥{{ d.deposit }}，保洁后续找到再按设备状况退押金或扣维修费。</template>
                      <template v-else>团队当场赔付 ¥{{ LOST_FEE }}，设备按遗失销账，不再等待找回。</template>
                    </div>
                  </div>
                  <input v-else v-model="checks[d.code].note" :disabled="checks[d.code]?.result === 'ok'"
                         :placeholder="checks[d.code]?.result === 'damaged' ? '损坏部位描述' : ''" />
                </td>
              </tr>
            </tbody>
          </table>
          <div style="margin-top:12px; display:flex; align-items:center; gap:12px">
            <button class="btn-primary" :disabled="returned || !canSubmitReturn" @click="submitReturn">
              {{ returned ? '✓ 归还已登记' : '确认归还清点结果' }}
            </button>
            <span v-if="!canSubmitReturn && lostCodesPending.length" class="small" style="color:var(--red)">
              请为 {{ lostCodesPending.length }} 台遗失设备补全借出人、团队负责人与最后使用展厅
            </span>
          </div>
        </div>

        <div class="grid grid-2" style="align-items:start">
          <div class="card">
            <div class="card-title">押金结算</div>
            <dl class="kv">
              <dt>已收押金<span v-if="r.depositRate > 1" class="small muted">（{{ r.depositRate }}× 倍率）</span></dt>
              <dd class="money">¥{{ r.depositTotal.toLocaleString() }}</dd>
              <dt>损坏赔偿</dt><dd>{{ stats.damaged }} 台 × ¥{{ DAMAGE_FEE }} = ¥{{ stats.damaged * DAMAGE_FEE }}</dd>
              <dt>遗失赔偿（当场赔付）</dt><dd>{{ preview.paid }} 台 × ¥{{ LOST_FEE }} = ¥{{ preview.paid * LOST_FEE }}</dd>
              <dt>押金暂扣（寻找/暂扣中）</dt>
              <dd style="color:var(--amber)">{{ outstandingLosses.length }} 台 · ¥{{ returned ? r.depositHeld : preview.held }}</dd>
              <dt>本次应退金额</dt>
              <dd class="money" style="font-size:17px">
                ¥{{ (r.depositTotal - (returned ? r.depositDeduction : preview.deduction) - (returned ? r.depositHeld : preview.held)).toLocaleString() }}
              </dd>
            </dl>
            <button class="btn-gold" style="width:100%; justify-content:center; margin-top:10px"
                    :disabled="!returned || settled" @click="settle">
              {{ settled ? '✓ 押金流水已记录' : '完成押金结算并记录流水' }}
            </button>
            <div v-if="r.depositHeld" class="callout warn" style="margin-top:10px; margin-bottom:0">
              团队可先行离馆；保洁后续找到设备后，在本页继续处理押金退还/维修费扣除。
            </div>
          </div>

          <div class="card">
            <div class="card-title">满意度与离馆</div>
            <label class="field"><span class="muted small">团体整体满意度</span></label>
            <div style="font-size:30px; letter-spacing:6px; cursor:pointer">
              <span v-for="n in 5" :key="n"
                    :style="n <= satisfaction ? '' : 'opacity:.25'"
                    :class="n <= satisfaction ? 'stars' : ''"
                    @click="satisfaction = n">★</span>
              <span class="small muted" style="font-size:13px; margin-left:8px">{{ ['', '很不满意', '不满意', '一般', '满意', '非常满意'][satisfaction] }}</span>
            </div>
            <div class="callout info" style="margin:10px 0">
              遗失押金暂扣不影响团队离馆；满意度 ≤ 3 时建议在「投诉与追溯」页核对讲解时长与改道记录。
            </div>
            <button class="btn-primary" style="width:100%; justify-content:center"
                    :disabled="!returned" @click="finish">
              团队离馆，结束本次预约
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
