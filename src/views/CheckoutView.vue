<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { DAMAGE_FEE, REPAIR_FEE_DEFAULT, SURCHARGE_DEPOSIT } from '@/data/museum'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'
import { useSessionStore } from '@/stores/session'
import type { FoundOutcome, LostResolution } from '@/types'
import StatusBadge from '@/components/StatusBadge.vue'

const store = useReservationsStore()
const museum = useMuseumStore()
const session = useSessionStore()
const route = useRoute()
const router = useRouter()

const queue = computed(() =>
  [...store.list].filter((r) => r.status === 'touring')
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

interface LostForm {
  borrower: string
  leader: string
  lastHallId: string
  note: string
  resolution: LostResolution
}
const lostForms = ref<Record<string, LostForm>>({})

watch(selectedId, () => {
  checks.value = {}
  satisfaction.value = 5
  lostForms.value = {}
  if (r.value) {
    for (const d of r.value.devices) {
      const lostRec = r.value.lostDevices.find((l) => l.code === d.code)
      if (lostRec) {
        checks.value[d.code] = { result: 'lost', note: lostRec.note ?? '' }
        lostForms.value[d.code] = {
          borrower: lostRec.borrower,
          leader: lostRec.leader,
          lastHallId: lostRec.lastHallId,
          note: lostRec.note ?? '',
          resolution: lostRec.resolution,
        }
      } else {
        checks.value[d.code] = { result: d.status === 'damaged' || d.status === 'lost' ? 'damaged' : 'ok', note: d.note ?? '' }
      }
    }
  }
}, { immediate: true })

/** 该团经过的展厅（含改道插入站），供「最后使用展厅」选择 */
const hallOptions = computed(() => {
  if (!r.value) return []
  const ids: string[] = []
  for (const s of r.value.route) if (!ids.includes(s.hallId)) ids.push(s.hallId)
  return ids.map((id) => ({ id, name: museum.hallById(id)?.name ?? id }))
})

function markLost(code: string) {
  checks.value[code].result = 'lost'
  if (!lostForms.value[code] && r.value) {
    lostForms.value[code] = {
      borrower: '',
      leader: r.value.contactName,
      lastHallId: hallOptions.value[hallOptions.value.length - 1]?.id ?? '',
      note: '',
      resolution: 'withheld',
    }
  }
}

const stats = computed(() => {
  let ok = 0, damaged = 0, lost = 0
  for (const v of Object.values(checks.value)) {
    if (v.result === 'ok') ok++
    else if (v.result === 'damaged') damaged++
    else lost++
  }
  return { ok, damaged, lost }
})

/** 尚未登记完整的缺失设备（缺四要素） */
const incompleteLost = computed(() =>
  Object.entries(checks.value)
    .filter(([, v]) => v.result === 'lost')
    .map(([code]) => ({ code, f: lostForms.value[code] }))
    .filter(({ f }) => !f || !f.borrower.trim() || !f.leader.trim() || !f.lastHallId),
)

const returned = computed(() => r.value?.timeline.some((e) => e.kind === 'device_return'))

const lostRecords = computed(() => r.value?.lostDevices ?? [])
const pendingRecords = computed(() => lostRecords.value.filter((l) => l.outcome === 'pending'))
const pendingWithhold = computed(() =>
  pendingRecords.value.filter((l) => l.resolution === 'withheld').reduce((s, l) => s + l.withheldAmount, 0),
)
const pendingSearching = computed(() =>
  pendingRecords.value.filter((l) => l.resolution === 'searching').reduce((s, l) => s + l.withheldAmount, 0),
)

function submitReturn() {
  if (!r.value || incompleteLost.value.length) return
  // 先为标记缺失的设备登记四要素与处置方式，returnDevices 会据此避免误按当场赔付结案
  for (const [code, v] of Object.entries(checks.value)) {
    if (v.result !== 'lost') continue
    if (r.value.lostDevices.some((l) => l.code === code)) continue
    const f = lostForms.value[code]
    store.reportLostDevice(selectedId.value, {
      code,
      borrower: f.borrower.trim(),
      leader: f.leader.trim(),
      lastHallId: f.lastHallId,
      note: f.note.trim() || v.note,
      resolution: f.resolution,
    }, session.staffName)
  }
  const results = Object.entries(checks.value).map(([code, v]) => ({ code, result: v.result, note: v.note }))
  store.returnDevices(selectedId.value, results, session.staffName)
}

function changeResolution(key: string, resolution: LostResolution) {
  store.changeLostResolution(selectedId.value, key, resolution, session.staffName)
}

// 保洁找回处置表单
const foundForms = ref<Record<string, { repairFee: number; note: string; foundBy: string }>>({})
function foundForm(key: string, withheld: number) {
  if (!foundForms.value[key]) {
    foundForms.value[key] = { repairFee: Math.min(REPAIR_FEE_DEFAULT, withheld), note: '', foundBy: '保洁组' }
  }
  return foundForms.value[key]
}

function resolveFound(key: string, outcome: FoundOutcome, withheld: number) {
  const f = foundForm(key, withheld)
  const fee = Math.min(Math.max(0, f.repairFee), withheld)
  store.resolveLostFound(selectedId.value, key, {
    outcome,
    repairFee: outcome === 'repair' ? fee : undefined,
    note: f.note.trim() || undefined,
    foundBy: f.foundBy.trim() || '保洁组',
  }, session.staffName)
}
function notFound(key: string) {
  if (!confirm('确认保洁已查找且无法找回？该台押金将不予退还。')) return
  store.confirmLostNotFound(selectedId.value, key, session.staffName)
}

function settle() {
  store.settleDeposit(selectedId.value, session.staffName)
}
const settled = computed(() => {
  const evs = r.value?.timeline.filter((e) => e.kind === 'deposit_settle') ?? []
  return evs.some((e) => e.title.includes('押金结算：'))
})
function finish() {
  store.complete(selectedId.value, satisfaction.value, session.staffName)
  if (store.byId(selectedId.value)?.status === 'completed') router.push('/trace/' + selectedId.value)
}

const hallName = (id: string) => museum.hallById(id)?.name ?? id
const outcomeText: Record<string, string> = {
  pending: '待保洁查找',
  refund: '已找回 · 押金全退',
  repair: '已找回 · 扣维修费',
  forfeit: '押金不予退还',
}
</script>

<template>
  <div v-if="!r" class="card empty">没有参观中、等待离馆核销的团队。</div>

  <div v-else class="grid" style="grid-template-columns: 280px 1fr; align-items:start">
    <div class="card" style="padding:6px">
      <div class="card-title" style="margin:6px 8px">待离馆团队</div>
      <div v-for="q in queue" :key="q.id" style="padding:10px 12px; cursor:pointer; border-radius:8px"
           :style="q.id === selectedId ? 'background:var(--paper-2)' : ''" @click="selectedId = q.id">
        <strong style="font-size:13px">{{ q.orgName }}</strong>
        <div class="small muted">{{ q.verifiedSize ?? q.groupSize }} 人 · 借出 {{ q.devices.length }} 台</div>
        <div v-if="q.lostDevices.some((l) => l.outcome === 'pending')" class="tag tag-maint" style="margin-top:4px">
          ⚠ {{ q.lostDevices.filter((l) => l.outcome === 'pending').length }} 台耳麦遗失未结案
        </div>
        <div style="margin-top:4px"><StatusBadge :status="q.status" /></div>
      </div>
    </div>

    <div style="display:flex; flex-direction:column; gap:14px">
      <div class="card">
        <div class="card-title">
          {{ r.orgName }} · {{ r.id }}
          <span class="aside">计划讲解 {{ r.durationMin }} 分钟 · 入馆 {{ r.actualArrive?.slice(11, 16) }} → 当前 {{ museum.nowHM }}</span>
        </div>

        <div class="grid grid-4">
          <div><div class="stat-label">应还耳麦</div><div class="stat-num">{{ r.devices.length }}</div></div>
          <div><div class="stat-label">完好</div><div class="stat-num" style="color:var(--green)">{{ stats.ok }}</div></div>
          <div><div class="stat-label">损坏 / 缺失</div><div class="stat-num" style="color:var(--red)">{{ stats.damaged }} / {{ stats.lost }}</div></div>
          <div>
            <div class="stat-label">本团押金费率</div>
            <div class="stat-num money" style="font-size:20px">¥{{ r.depositPerUnit }}<span style="font-size:13px">/台</span></div>
            <div v-if="r.depositPerUnit >= SURCHARGE_DEPOSIT" class="small" style="color:var(--red)">该旅行社有历史遗失记录，已加收</div>
          </div>
        </div>
      </div>

      <!-- 缺失耳麦登记与处置 -->
      <div v-if="stats.lost || lostRecords.length" class="card" :style="pendingRecords.length ? 'border-color:var(--amber)' : ''">
        <div class="card-title">
          🎧 耳麦遗失登记与押金处置
          <span class="aside">现场寻找 · 押金暂扣 · 当场赔付；保洁找回后按设备状态退押金或扣维修费</span>
        </div>
        <table class="data">
          <thead>
            <tr><th>设备编号</th><th>借出人</th><th>团队负责人</th><th>最后使用展厅</th><th>处置 / 结论</th></tr>
          </thead>
          <tbody>
            <tr v-for="l in lostRecords" :key="l.key">
              <td class="mono"><strong>{{ l.code }}</strong>
                <div class="small muted">{{ l.reportedAt?.slice(11, 16) }} 登记</div>
              </td>
              <td class="small">{{ l.borrower }}</td>
              <td class="small">{{ l.leader }}</td>
              <td class="small">{{ hallName(l.lastHallId) }}</td>
              <td>
                <span class="tag" :class="l.outcome === 'refund' ? 'tag-ok' : l.outcome === 'forfeit' ? 'tag-maint' : 'tag-warn'">
                  {{ outcomeText[l.outcome] }}
                </span>
                <div class="small muted" style="margin-top:3px">
                  {{ { searching: '团队现场寻找中', withheld: `暂扣押金 ¥${l.withheldAmount}`, paid: '已当场赔付' }[l.resolution] }}
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- 未结案操作区 -->
        <div v-if="pendingRecords.length" style="margin-top:14px">
          <div v-for="l in pendingRecords" :key="l.key" class="callout warn" style="margin-bottom:10px">
            <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:center">
            <strong>{{ l.code }}（{{ hallName(l.lastHallId) }}）</strong>
            <span class="small">暂扣/占用押金 <strong class="money">¥{{ l.withheldAmount }}</strong></span>
            </div>

            <!-- 处置方式切换 -->
            <div class="pill-row" style="margin:8px 0">
              <button class="btn-sm" :style="l.resolution === 'searching' ? 'background:var(--blue);color:#fff;border-color:var(--blue)' : ''"
                      @click="changeResolution(l.key, 'searching')">团队现场寻找</button>
              <button class="btn-sm" :style="l.resolution === 'withheld' ? 'background:var(--amber);color:#fff;border-color:var(--amber)' : ''"
                      @click="changeResolution(l.key, 'withheld')">押金暂扣，等保洁</button>
              <button class="btn-sm btn-danger"
                      @click="changeResolution(l.key, 'paid')">当场赔付结案</button>
            </div>

            <!-- 保洁/现场找回结论 -->
            <div v-if="l.resolution !== 'paid'" class="grid grid-3" style="gap:8px; margin-top:8px">
              <div class="field" style="margin:0"><label>找回/核验人</label>
                <input v-model="foundForm(l.key, l.withheldAmount).foundBy" placeholder="保洁组 / 前台" /></div>
              <div class="field" style="margin:0"><label>维修费（损坏时，≤ 暂扣 ¥{{ l.withheldAmount }}）</label>
                <input v-model.number="foundForm(l.key, l.withheldAmount).repairFee" type="number" min="0" :max="l.withheldAmount" /></div>
              <div class="field" style="margin:0"><label>备注</label>
                <input v-model="foundForm(l.key, l.withheldAmount).note" placeholder="如：掉在座位下 / 耳罩断裂" /></div>
            </div>
            <div v-if="l.resolution !== 'paid'" class="pill-row" style="margin-top:8px">
              <button class="btn-sm" style="border-color:var(--green); color:var(--green)"
                      @click="resolveFound(l.key, 'intact', l.withheldAmount)">✓ 找回且完好，退全部押金</button>
              <button class="btn-sm btn-danger"
                      @click="resolveFound(l.key, 'repair', l.withheldAmount)">找回但损坏，扣维修费</button>
              <button class="btn-sm" style="border-color:#7a6740;color:var(--amber)"
                      @click="notFound(l.key)">保洁确认无法找回，不退押金</button>
            </div>
          </div>
          <div class="hint">未结案前不能做押金结算与离馆；损坏/遗失设备已同步库存，不会再分配给下一场团队。</div>
        </div>
      </div>

      <!-- 逐台清点 -->
      <div class="card">
        <div class="card-title">
          逐台核对耳麦归还
          <span class="aside">损坏 ¥{{ DAMAGE_FEE }}/台 · 遗失按该台押金 ¥{{ r.depositPerUnit }}/台 暂扣或赔付</span>
        </div>
        <div v-if="!r.devices.length" class="empty">该团未借用耳麦。</div>
        <table v-else class="data">
          <thead><tr><th>设备编号</th><th>借出时间</th><th>归还状态</th><th>备注 / 遗失信息</th></tr></thead>
          <tbody>
            <tr v-for="d in r.devices" :key="d.code">
              <td class="mono"><strong>{{ d.code }}</strong></td>
              <td class="small mono">{{ d.lentAt?.slice(11, 16) }}</td>
              <td>
                <div class="pill-row">
                  <button class="btn-sm" :disabled="returned" :style="checks[d.code]?.result === 'ok' ? 'background:var(--green);color:#fff;border-color:var(--green)' : ''"
                          @click="checks[d.code].result = 'ok'">✓ 完好</button>
                  <button class="btn-sm btn-danger" :disabled="returned" :style="checks[d.code]?.result === 'damaged' ? 'background:var(--red);color:#fff' : ''"
                          @click="checks[d.code].result = 'damaged'">损坏</button>
                  <button class="btn-sm" style="border-color:#7a6740;color:var(--amber)"
                          :disabled="returned"
                          :style="checks[d.code]?.result === 'lost' ? 'background:var(--amber);color:#fff;border-color:var(--amber)' : ''"
                          @click="markLost(d.code)">缺失</button>
                </div>
              </td>
              <td style="min-width:280px">
                <!-- 已建档的遗失记录：展示只读信息，去上方处置面板操作 -->
                <template v-if="lostRecords.some((l) => l.code === d.code)">
                  <div class="small">
                    借出人 <strong>{{ lostRecords.find((l) => l.code === d.code)?.borrower }}</strong> ·
                    负责人 {{ lostRecords.find((l) => l.code === d.code)?.leader }} ·
                    最后 {{ hallName(lostRecords.find((l) => l.code === d.code)!.lastHallId) }}
                  </div>
                  <div class="small muted">{{ lostRecords.find((l) => l.code === d.code)?.note }}</div>
                </template>
                <!-- 新标记的缺失：录入四要素 -->
                <template v-else-if="checks[d.code]?.result === 'lost'">
                  <div class="grid" style="grid-template-columns:1fr 1fr; gap:6px">
                    <input v-model="lostForms[d.code].borrower" placeholder="* 借出人（团员姓名）" />
                    <input v-model="lostForms[d.code].leader" placeholder="* 团队负责人" />
                    <select v-model="lostForms[d.code].lastHallId">
                      <option value="" disabled>* 最后使用展厅</option>
                      <option v-for="h in hallOptions" :key="h.id" :value="h.id">{{ h.name }}</option>
                    </select>
                    <select v-model="lostForms[d.code].resolution">
                      <option value="searching">现场寻找</option>
                      <option value="withheld">押金暂扣</option>
                      <option value="paid">当场赔付</option>
                    </select>
                  </div>
                  <input v-model="lostForms[d.code].note" style="margin-top:6px" placeholder="遗失情况说明（可选）" />
                </template>
                <input v-else v-model="checks[d.code].note" :disabled="checks[d.code]?.result === 'ok'"
                       :placeholder="checks[d.code]?.result === 'damaged' ? '损坏部位描述' : ''" />
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="incompleteLost.length" class="callout danger" style="margin-top:12px; margin-bottom:0">
          请补全缺失耳麦的借出人、团队负责人与最后使用展厅：{{ incompleteLost.map((x) => x.code).join('、') }}
        </div>
        <div style="margin-top:12px">
          <button class="btn-primary" :disabled="returned || !!incompleteLost.length" @click="submitReturn">
            {{ returned ? '✓ 归还已登记' : '确认归还清点结果' }}
          </button>
          <span v-if="!returned && stats.lost" class="hint" style="margin-left:10px">缺失设备将同步登记到遗失档案</span>
        </div>
      </div>

      <!-- 押金结算 + 离馆 -->
      <div class="grid grid-2" style="align-items:start">
        <div class="card">
          <div class="card-title">押金结算</div>
          <dl class="kv">
            <dt>已收押金（{{ r.devices.length }} 台 × ¥{{ r.depositPerUnit }}）</dt>
            <dd class="money">¥{{ r.depositTotal.toLocaleString() }}</dd>
            <dt>损坏赔偿</dt>
            <dd>{{ r.devices.filter((d) => d.status === 'damaged').length }} 台 × ¥{{ DAMAGE_FEE }}
              = ¥{{ r.devices.filter((d) => d.status === 'damaged').length * DAMAGE_FEE }}</dd>
            <dt>已结案遗失/维修费</dt>
            <dd class="money">¥{{ r.depositDeduction - r.devices.filter((d) => d.status === 'damaged').length * DAMAGE_FEE }}</dd>
            <dt v-if="pendingWithhold">暂扣待保洁结果</dt>
            <dd v-if="pendingWithhold" style="color:var(--amber)">¥{{ pendingWithhold }}（暂不退还）</dd>
            <dt v-if="pendingSearching">现场寻找中占用</dt>
            <dd v-if="pendingSearching" style="color:var(--blue)">¥{{ pendingSearching }}（设备未还）</dd>
            <dt>当前应退金额</dt>
            <dd class="money" style="font-size:17px">
              ¥{{ Math.max(0, r.depositTotal - r.depositDeduction - pendingWithhold - pendingSearching).toLocaleString() }}
            </dd>
          </dl>
          <div v-if="pendingRecords.length" class="callout warn" style="margin:10px 0 0">
            ⚠ {{ pendingRecords.length }} 台缺失耳麦尚未结案，押金结算与离馆暂不可用。
          </div>
          <button class="btn-gold" style="width:100%; justify-content:center; margin-top:10px"
                  :disabled="!returned || !!pendingRecords.length" @click="settle">
            {{ settled ? '✓ 已记录结算流水' : '完成押金结算并记录流水' }}
          </button>
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
            遗失耳麦结案后设备状态自动同步库存：完好回库可再借出，损坏转维修、遗失退出设备池，均不会分配给下一场团队。
          </div>
          <button class="btn-primary" style="width:100%; justify-content:center"
                  :disabled="!returned || !!pendingRecords.length" @click="finish">
            团队离馆，结束本次预约
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
