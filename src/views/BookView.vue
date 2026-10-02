<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMuseumStore } from '@/stores/museum'
import { useReservationsStore } from '@/stores/reservations'
import { buildRoute } from '@/lib/schedule'
import { depositPerUnit, orgLossSummary } from '@/lib/deposit'
import {
  AGE_LABEL,
  GROUP_TYPE_LABEL,
  LANG_LABEL,
  type AgeBand,
  type GroupType,
  type Language,
} from '@/types'
import HallTags from '@/components/HallTags.vue'

const museum = useMuseumStore()
const reservations = useReservationsStore()
const router = useRouter()

const form = reactive({
  orgType: 'school' as GroupType,
  orgName: '',
  groupSize: 30,
  ageBand: 'youth' as AgeBand,
  language: 'zh' as Language,
  accessible: false,
  themeId: 't_modern',
  arriveDate: '2026-10-01',
  arriveTime: '14:00',
  contactName: '',
  contactPhone: '',
  busInfo: '',
  needHeadsets: true,
  headsetCount: 30,
  note: '',
})

const errors = reactive<Record<string, string>>({})
const createdId = ref<string | null>(null)

const theme = computed(() => museum.themeById(form.themeId))

/** 按单位名称匹配历史耳麦遗失档案（旅行社信用影响押金倍率） */
const orgSummary = computed(() => orgLossSummary(reservations.list, form.orgName.trim()))
const previewRate = computed(() =>
  form.orgType === 'travel' && orgSummary.value.hasCountedLoss ? 1.5 : 1,
)
const unitDeposit = computed(() => depositPerUnit(previewRate.value))
const previewRoute = computed(() =>
  buildRoute(theme.value!, museum.halls, form.arriveTime, {
    accessible: form.accessible,
    live: museum.maintenance,
  }),
)

function validate(): boolean {
  Object.keys(errors).forEach((k) => delete errors[k])
  if (!form.orgName.trim()) errors.orgName = '请填写单位名称'
  if (form.groupSize < 5) errors.groupSize = '团体预约不少于 5 人'
  if (form.groupSize > 120) errors.groupSize = '单次预约不超过 120 人，大团请拆团'
  if (!form.contactName.trim()) errors.contactName = '请填写联系人'
  if (!/^[\d*\-]{6,}$/.test(form.contactPhone.trim())) errors.contactPhone = '请填写联系电话'
  if (form.needHeadsets && (form.headsetCount < 1 || form.headsetCount > form.groupSize))
    errors.headsetCount = '耳麦数量应在 1 到团体人数之间'
  return Object.keys(errors).length === 0
}

function submit() {
  if (!validate()) return
  const r = reservations.create({
    orgType: form.orgType,
    orgName: form.orgName.trim(),
    groupSize: form.groupSize,
    ageBand: form.ageBand,
    language: form.language,
    accessible: form.accessible,
    themeId: form.themeId,
    arriveTime: `${form.arriveDate}T${form.arriveTime}:00`,
    contactName: form.contactName.trim(),
    contactPhone: form.contactPhone.trim(),
    busInfo: form.busInfo.trim() || '未登记车辆',
    needHeadsets: form.needHeadsets,
    headsetCount: form.needHeadsets ? form.headsetCount : 0,
    note: form.note.trim(),
  })
  createdId.value = r.id
}

function goConfirm() {
  router.push(`/confirm/${createdId.value}`)
}
</script>

<template>
  <div v-if="createdId" class="card" style="max-width: 720px; margin: 30px auto">
    <h2 style="color: var(--green)">✅ 预约已提交，编号 {{ createdId }}</h2>
    <p class="muted">馆方工作人员将结合展厅容量、讲解员排班与临时闭展安排尽快确认。系统已按主题与当日维护自动生成建议动线：</p>
    <div class="divider" />
    <div class="route-chain">
      <template v-for="(s, i) in previewRoute" :key="i">
        <div class="route-stop" :class="`state-${s.state}`">
          <div class="rs-time">{{ s.plannedEnter }}~{{ s.plannedLeave }}</div>
          <div class="rs-name">{{ museum.hallById(s.hallId)?.name }}</div>
          <div v-if="s.note" class="rs-note">{{ s.note }}</div>
        </div>
        <div v-if="i < previewRoute.length - 1" class="route-arrow">→</div>
      </template>
    </div>
    <div class="divider" />
    <div style="display:flex; gap:10px">
      <button class="btn-gold" @click="goConfirm">前往确认台查看审核</button>
      <RouterLink class="btn" to="/reservations">查看我的预约</RouterLink>
    </div>
  </div>

  <div v-else class="grid grid-2" style="align-items:start">
    <div class="card">
      <div class="card-title">团体信息登记 <span class="aside">学校 / 企业 / 旅行社</span></div>
      <div class="form-row">
        <div class="field">
          <label><span class="req">*</span>团体类型</label>
          <select v-model="form.orgType">
            <option v-for="(label, key) in GROUP_TYPE_LABEL" :key="key" :value="key">{{ label }}</option>
          </select>
        </div>
        <div class="field">
          <label><span class="req">*</span>单位名称</label>
          <input v-model="form.orgName" placeholder="如：云川中学" />
          <span v-if="errors.orgName" class="field-error">{{ errors.orgName }}</span>
        </div>
      </div>

      <div class="form-row-3">
        <div class="field">
          <label><span class="req">*</span>团体人数</label>
          <input v-model.number="form.groupSize" type="number" min="5" max="120" />
          <span v-if="errors.groupSize" class="field-error">{{ errors.groupSize }}</span>
          <span v-else-if="form.groupSize >= 35" class="hint">≥35 人为大团，馆方将拆分批次入场</span>
        </div>
        <div class="field">
          <label>主要年龄层</label>
          <select v-model="form.ageBand">
            <option v-for="(label, key) in AGE_LABEL" :key="key" :value="key">{{ label }}</option>
          </select>
        </div>
        <div class="field">
          <label>讲解语言</label>
          <select v-model="form.language">
            <option v-for="(label, key) in LANG_LABEL" :key="key" :value="key">{{ label }}</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label class="checkbox">
          <input v-model="form.accessible" type="checkbox" />
          ♿ 需要无障碍路线（轮椅 / 婴儿车 / 行动不便成员）
        </label>
        <span class="hint">勾选后路线将自动排除无无障碍通道的展厅（如四号厅 · 当代水墨）</span>
      </div>

      <div class="field">
        <label><span class="req">*</span>讲解主题</label>
        <select v-model="form.themeId">
          <option v-for="t in museum.themes" :key="t.id" :value="t.id">
            {{ t.name }}（约 {{ t.durationMin }} 分钟）
          </option>
        </select>
        <span class="hint">{{ theme?.desc }}</span>
      </div>

      <div class="form-row">
        <div class="field">
          <label><span class="req">*</span>到馆日期</label>
          <input v-model="form.arriveDate" type="date" />
        </div>
        <div class="field">
          <label><span class="req">*</span>预计到馆时间</label>
          <input v-model="form.arriveTime" type="time" />
        </div>
      </div>

      <div class="form-row">
        <div class="field">
          <label><span class="req">*</span>联系人</label>
          <input v-model="form.contactName" placeholder="带队老师 / 领队姓名" />
          <span v-if="errors.contactName" class="field-error">{{ errors.contactName }}</span>
        </div>
        <div class="field">
          <label><span class="req">*</span>联系电话</label>
          <input v-model="form.contactPhone" placeholder="手机或内线" />
          <span v-if="errors.contactPhone" class="field-error">{{ errors.contactPhone }}</span>
        </div>
      </div>

      <div class="field">
        <label>车辆停靠</label>
        <input v-model="form.busInfo" placeholder="如：大巴 2 辆，停靠团队落客区；1 辆需无障碍落客" />
      </div>

      <div class="field">
        <label class="checkbox">
          <input v-model="form.needHeadsets" type="checkbox" />
          🎧 借用团队讲解耳麦（押金 ¥{{ unitDeposit }}/台，离馆无损退还）
        </label>
        <div v-if="form.orgType === 'travel' && orgSummary.total" class="callout warn" style="margin-top:8px">
          本旅行社在馆历史记录：耳麦遗失 <strong>{{ orgSummary.total }}</strong> 起
          （未结 {{ orgSummary.outstanding }} · 已赔 {{ orgSummary.paid }} · 找回损坏 {{ orgSummary.repaired }}）。
          <template v-if="orgSummary.hasCountedLoss">
            <strong>本次预约押金按 1.5 倍收取（¥{{ museum.depositPerUnit }} → ¥{{ unitDeposit }}/台）</strong>，确认时将由前台向领队明示。
          </template>
          <template v-else>遗失设备均已完好找回，押金维持 ¥{{ museum.depositPerUnit }}/台。</template>
        </div>
      </div>
      <div v-if="form.needHeadsets" class="field" style="max-width: 220px">
        <label>借用数量</label>
        <input v-model.number="form.headsetCount" type="number" min="1" :max="form.groupSize" />
        <span class="hint">预计押金 <strong class="money">¥{{ (form.headsetCount * unitDeposit).toLocaleString() }}</strong><template v-if="previewRate > 1">（1.5 倍）</template></span>
        <span v-if="errors.headsetCount" class="field-error">{{ errors.headsetCount }}</span>
      </div>

      <div class="field">
        <label>备注</label>
        <textarea v-model="form.note" placeholder="特殊需求，如儿童陪护、重点想看的展品、餐饮时间等" />
      </div>

      <button class="btn-primary" style="width:100%; justify-content:center" @click="submit">提交预约申请</button>
    </div>

    <div style="display:flex; flex-direction:column; gap:14px">
      <div class="card">
        <div class="card-title">建议动线预览 <span class="aside">到馆安检集结约 10 分钟后进展厅</span></div>
        <div class="route-chain" style="flex-direction:column; gap:8px">
          <div v-for="(s, i) in previewRoute" :key="i" class="route-stop state-planned" style="width:100%">
            <div class="rs-time">{{ s.plannedEnter }}~{{ s.plannedLeave }} · {{ s.durationMin }} 分钟</div>
            <div class="rs-name">{{ museum.hallById(s.hallId)?.name }}</div>
            <div style="margin-top:5px"><HallTags :hall="museum.hallById(s.hallId)!" /></div>
            <div v-if="s.note" class="callout warn" style="margin-top:8px; margin-bottom:0">{{ s.note }}</div>
          </div>
        </div>
      </div>
      <div class="callout info">
        馆内观展礼仪：三号雕塑厅与中庭可正常交流，书画厅（一/二/四号厅）为安静展厅请使用耳麦；标注 📷 的展品禁止拍照，请提前告知团员。
      </div>
    </div>
  </div>
</template>
