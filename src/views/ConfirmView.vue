<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'
import {
  availableGuides,
  occupancyGrid,
  routePeakLoads,
  securityPlan,
  splitBatches,
} from '@/lib/schedule'
import { addHM, hmOfISO } from '@/lib/time'
import HallTags from '@/components/HallTags.vue'
import CapacityBar from '@/components/CapacityBar.vue'
import StatusBadge from '@/components/StatusBadge.vue'
import { useSessionStore } from '@/stores/session'

const store = useReservationsStore()
const museum = useMuseumStore()
const session = useSessionStore()
const route = useRoute()
const router = useRouter()

const pending = computed(() => store.byStatus('submitted'))
const selectedId = ref<string>(
  (route.params.id as string) || pending.value[0]?.id || '',
)
watch(pending, (p) => {
  if (!p.some((r) => r.id === selectedId.value) && p[0]) selectedId.value = p[0].id
}, { immediate: true })

const r = computed(() => store.byId(selectedId.value))

const grid = computed(() => occupancyGrid(store.list, { maintenance: museum.maintenance, extraLoad: museum.extraLoad }))

const enterHM = computed(() => (r.value ? addHM(hmOfISO(r.value.arriveTime), 10) : '10:00'))
const endHM = computed(() => (r.value ? r.value.route[r.value.route.length - 1]?.plannedLeave ?? addHM(enterHM.value, 90) : '11:00'))

const peaks = computed(() =>
  r.value ? routePeakLoads(r.value.route, museum.halls, grid.value) : [],
)
// 叠加本团后的预测满载率
const projected = computed(() =>
  peaks.value.map((p) => ({
    ...p,
    projectedLoad: p.load + (r.value?.verifiedSize ?? r.value?.groupSize ?? 0),
    projectedRatio: (p.load + (r.value?.groupSize ?? 0)) / p.capacity,
  })),
)

const guideCandidates = computed(() =>
  r.value
    ? availableGuides(museum.guides, store.list, {
        language: r.value.language,
        themeId: r.value.themeId,
        startHM: enterHM.value,
        endHM: endHM.value,
      })
    : [],
)
const pickedGuides = ref<string[]>([])
watch(selectedId, () => {
  pickedGuides.value = []
  rejectReason.value = ''
  confirmNote.value = ''
})

const lanes = computed(() =>
  r.value
    ? securityPlan(museum.lanes, store.list, hmOfISO(r.value.arriveTime), r.value.groupSize, r.value.accessible, r.value.id)
    : [],
)
const pickedLane = ref('')
const batchNo = ref('')
const batches = computed(() => (r.value ? splitBatches(Math.min(r.value.groupSize, 60), 25) : []))
const confirmNote = ref('')
const rejectReason = ref('')

watch(selectedId, (id) => {
  const found = store.byId(id)
  if (found) {
    const best = guideCandidates.value.find((g) => g.ok)
    pickedGuides.value = best ? [best.id] : []
    const lane = lanes.value[0]
    pickedLane.value = lane?.lane.id ?? ''
    batchNo.value = 'B' + hmOfISO(found.arriveTime).replace(':', '')
  }
}, { immediate: true })

function doConfirm() {
  if (!r.value) return
  store.confirm(
    selectedId.value,
    {
      guideIds: pickedGuides.value,
      laneId: pickedLane.value,
      batchNo: batchNo.value,
      note: confirmNote.value || '按系统建议方案确认。',
    },
    session.staffName || '工作人员',
  )
  router.push('/front/' + selectedId.value)
}
function doReject() {
  if (!r.value || !rejectReason.value) return
  store.reject(selectedId.value, rejectReason.value, session.staffName || '工作人员')
}

const hallState = (hallId: string) => museum.hallById(hallId)!
const conflicts = computed(() => projected.value.filter((p) => p.projectedLoad > p.capacity))
const guideNeeded = computed(() => (r.value ? Math.ceil(r.value.groupSize / 25) : 1))
</script>

<template>
  <div v-if="!r" class="card empty">
    暂无待确认预约。<RouterLink to="/book">去提交一个新的团体预约</RouterLink>
  </div>

  <div v-else class="grid" style="grid-template-columns: 250px 1fr; align-items:start">
    <div class="card" style="padding: 6px">
      <div class="card-title" style="margin:6px 8px">待确认队列</div>
      <div
        v-for="p in pending" :key="p.id"
        class="item tight"
        style="padding:10px 12px; cursor:pointer; border-radius:8px"
        :style="p.id === selectedId ? 'background:var(--paper-2)' : ''"
        @click="selectedId = p.id"
      >
        <strong style="font-size:13px">{{ p.orgName }}</strong>
        <div class="small muted">{{ p.groupSize }} 人 · {{ hmOfISO(p.arriveTime) }} 到馆</div>
        <div style="margin-top:4px"><StatusBadge :status="p.status" /></div>
      </div>
      <div v-if="!pending.length" class="empty small">队列为空</div>
    </div>

    <div style="display:flex; flex-direction:column; gap:14px">
      <!-- 基本信息 -->
      <div class="card">
        <div class="card-title">
          {{ r.orgName }} · 预约 {{ r.id }}
          <span class="aside">{{ { school: '学校', enterprise: '企业', travel: '旅行社' }[r.orgType] }} · 联系人 {{ r.contactName }} {{ r.contactPhone }}</span>
        </div>
        <div class="grid grid-4">
          <div><div class="stat-label">团体人数</div><div class="stat-num">{{ r.groupSize }}</div></div>
          <div><div class="stat-label">年龄层 / 语言</div><div style="padding-top:5px">{{ { children: '儿童为主', youth: '青少年', adult: '成人', senior: '银发', mixed: '混合' }[r.ageBand] }} · {{ { zh: '中文', en: '英语', ja: '日语' }[r.language] }}</div></div>
          <div><div class="stat-label">到馆 / 车辆</div><div style="padding-top:5px">{{ hmOfISO(r.arriveTime) }}<div class="small muted">{{ r.busInfo }}</div></div></div>
          <div><div class="stat-label">无障碍 / 耳麦</div><div style="padding-top:5px">{{ r.accessible ? '♿ 需要' : '不需要' }} · {{ r.needHeadsets ? `${r.headsetCount} 台` : '不借用' }}</div></div>
        </div>
        <div v-if="r.note" class="section-tip" style="margin-top:12px; margin-bottom:0">联系人备注：{{ r.note }}</div>
        <div v-if="r.depositRate > 1" class="callout warn" style="margin-top:12px; margin-bottom:0">
          ⚠ 该旅行社有未结案或已扣款的耳麦遗失记录，本次耳麦押金按 <strong>{{ r.depositRate }} 倍（¥{{ Math.round(museum.depositPerUnit * r.depositRate) }}/台）</strong>收取，
          预计 {{ r.headsetCount }} 台共 ¥{{ (Math.round(museum.depositPerUnit * r.depositRate) * r.headsetCount).toLocaleString() }}，确认须知中请向领队明示。
        </div>
      </div>

      <!-- 容量与闭展 -->
      <div class="card">
        <div class="card-title">展厅容量与临时闭展校验 <span class="aside">15 分钟栅格 · 含散客实时占用</span></div>
        <div v-if="conflicts.length" class="callout danger">
          ⚠ {{ conflicts.length }} 个展厅在该团参观时段预测超容量，建议错峰到馆、拆小批次或在下方调整路线后再确认。
        </div>
        <table class="data">
          <thead><tr><th>路线展厅</th><th>时段</th><th>标签</th><th>当前栅格峰值</th><th>叠加本团后</th><th>结论</th></tr></thead>
          <tbody>
            <tr v-for="(s, i) in r.route" :key="i">
              <td><strong>{{ hallState(s.hallId).name }}</strong><div v-if="s.note" class="small" style="color:var(--red)">{{ s.note }}</div></td>
              <td class="mono small">{{ s.plannedEnter }}~{{ s.plannedLeave }}</td>
              <td><HallTags :hall="hallState(s.hallId)" :ratio="projected[i]?.projectedRatio" /></td>
              <td style="min-width:150px">
                <CapacityBar :load="peaks[i]?.load ?? 0" :capacity="hallState(s.hallId).capacity" compact />
                <span class="small muted">含散客 {{ museum.extraLoad[s.hallId] ?? 0 }} 人</span>
              </td>
              <td>
                <CapacityBar :load="projected[i]?.projectedLoad ?? 0" :capacity="hallState(s.hallId).capacity" />
              </td>
              <td>
                <span v-if="s.state === 'skipped'" class="tag tag-maint">已自动跳过</span>
                <span v-else-if="s.state === 'maintenance'" class="tag tag-maint">闭展无法参观</span>
                <span v-else-if="(projected[i]?.projectedRatio ?? 0) >= 1" class="tag tag-maint">超容量</span>
                <span v-else-if="(projected[i]?.projectedRatio ?? 0) >= 0.85" class="tag tag-warn">接近限流</span>
                <span v-else class="tag tag-ok">可排入</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="r.groupSize >= 35" class="callout warn" style="margin-top:12px">
          大团拆分建议：{{ r.groupSize }} 人分 {{ batches.length }} 批入场（{{ batches.join(' + ') }}），每批间隔约 5 分钟，避免同一展厅瞬时满载。
        </div>
      </div>

      <!-- 讲解员 & 安检 -->
      <div class="grid grid-2" style="align-items:start">
        <div class="card">
          <div class="card-title">讲解员排班匹配 <span class="aside">建议 {{ guideNeeded }} 名（1:25）</span></div>
          <div v-for="g in guideCandidates" :key="g.id" class="item" style="padding:9px 0">
            <label class="checkbox">
              <input
                type="checkbox" :value="g.id" v-model="pickedGuides"
                :disabled="!g.ok && !pickedGuides.includes(g.id)"
              />
              <strong>{{ g.name }}</strong>
              <span class="small muted"> · {{ g.langs.map((l) => ({ zh: '中', en: '英', ja: '日' }[l])).join('/') }} · 好评 {{ g.rating }} · {{ g.phone }}</span>
            </label>
            <div v-if="g.shifts.length" class="small muted" style="margin-left:23px">
              当班 {{ g.shifts.map((s) => `${s.start}-${s.end}`).join('，') }}
            </div>
            <div v-if="g.conflicts.length" class="small" style="margin-left:23px; color:var(--red)">
              ✕ {{ g.conflicts.join('；') }}
            </div>
            <div v-else class="small" style="margin-left:23px; color:var(--green)">✓ 语言、主题、排班与带团时间均满足</div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">安检通道与入馆批次</div>
          <label v-for="l in lanes" :key="l.lane.id" class="item" style="display:flex; gap:10px; align-items:flex-start; padding:9px 0; cursor:pointer">
            <input type="radio" :value="l.lane.id" v-model="pickedLane" style="margin-top:3px" />
            <div>
              <strong>{{ l.lane.name }}</strong>
              <div class="small muted">{{ l.slot }} 槽已排 {{ l.loadBefore }} 人，本团后 {{ l.loadAfter }} / {{ l.lane.perSlot }} 人/槽</div>
              <CapacityBar :load="l.loadAfter" :capacity="l.lane.perSlot" compact />
              <div v-if="l.waitSlots" class="small" style="color:var(--amber)">预计等待 {{ l.waitSlots * 15 }} 分钟</div>
            </div>
          </label>
          <div class="divider" />
          <div class="field" style="margin-bottom:8px">
            <label>批次编号</label>
            <input v-model="batchNo" />
          </div>
          <div class="field">
            <label>确认说明（同步给联系人）</label>
            <textarea v-model="confirmNote" placeholder="如：拆 2 批入场，七厅维护结束后补看……" />
          </div>
        </div>
      </div>

      <div class="card">
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
          <button class="btn-gold" :disabled="!pickedGuides.length || !pickedLane" @click="doConfirm">
            ✅ 确认预约并发送入馆须知
          </button>
          <input v-model="rejectReason" placeholder="驳回原因（如：当日名额已满 / 主题需提前 3 天预约）" style="width:340px" />
          <button class="btn-danger" :disabled="!rejectReason" @click="doReject">驳回</button>
          <span class="hint">确认后该团进入「已确认」，到馆日在前台办理核验与设备发放。</span>
        </div>
      </div>
    </div>
  </div>
</template>
