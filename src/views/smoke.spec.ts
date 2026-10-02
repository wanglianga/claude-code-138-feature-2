// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { mount } from '@vue/test-utils'
import BookView from '@/views/BookView.vue'
import ReservationsView from '@/views/ReservationsView.vue'
import ConfirmView from '@/views/ConfirmView.vue'
import FrontDeskView from '@/views/FrontDeskView.vue'
import DispatchView from '@/views/DispatchView.vue'
import CheckoutView from '@/views/CheckoutView.vue'
import TraceView from '@/views/TraceView.vue'
import OpsView from '@/views/OpsView.vue'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/book', component: BookView },
      { path: '/confirm/:id?', component: ConfirmView },
      { path: '/front/:id?', component: FrontDeskView },
      { path: '/dispatch', component: DispatchView },
      { path: '/checkout/:id?', component: CheckoutView },
      { path: '/trace/:id?', component: TraceView },
    ],
  })
}

function mountView(component: unknown) {
  const router = makeRouter()
  return mount(component as never, {
    global: { plugins: [router] },
  })
}

describe('八大业务视图挂载冒烟', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('运营看板渲染展厅与讲解员表', () => {
    const w = mountView(OpsView)
    expect(w.text()).toContain('展厅实时负载')
    expect(w.text()).toContain('讲解员排班')
    expect(w.text()).toContain('耳麦库存与遗失押金处置')
    // 种子 R6 的暂扣待找耳麦出现在保洁查找任务中
    expect(w.text()).toContain('HS-049')
    // 星辉国旅因历史遗失被列为押金风险旅行社
    expect(w.text()).toContain('押金风险旅行社')
  })

  it('预约表单渲染全部必填字段', () => {
    const w = mountView(BookView)
    expect(w.text()).toContain('团体人数')
    expect(w.text()).toContain('讲解主题')
    expect(w.text()).toContain('无障碍路线')
    expect(w.text()).toContain('车辆停靠')
    expect(w.text()).toContain('借用')
  })

  it('预约列表渲染种子数据', () => {
    const w = mountView(ReservationsView)
    expect(w.text()).toContain('云川中学')
    expect(w.text()).toContain('星辉国际旅行社')
  })

  it('确认台展示容量、讲解员与安检校验', () => {
    const w = mountView(ConfirmView)
    expect(w.text()).toContain('展厅容量与临时闭展校验')
    expect(w.text()).toContain('讲解员排班匹配')
    expect(w.text()).toContain('安检通道')
  })

  it('到馆前台四步流程', () => {
    const w = mountView(FrontDeskView)
    expect(w.text()).toContain('到馆登记')
    expect(w.text()).toContain('核验人数')
    expect(w.text()).toContain('发放耳麦')
    expect(w.text()).toContain('批次安检入馆')
  })

  it('途中调度页展示七类事件入口与实时态势', () => {
    const w = mountView(DispatchView)
    expect(w.text()).toContain('展厅实时态势')
    expect(w.text()).toContain('展厅拥堵分流')
    expect(w.text()).toContain('儿童走散')
    expect(w.text()).toContain('耳麦损坏换机')
    expect(w.text()).toContain('讲解员临时替换')
    expect(w.text()).toContain('游客要求改路线')
    expect(w.text()).toContain('展厅临时维护')
  })

  it('离馆核销页渲染设备清点与押金结算', () => {
    const w = mountView(CheckoutView)
    expect(w.text()).toContain('逐台核对耳麦归还')
    expect(w.text()).toContain('押金结算')
    expect(w.text()).toContain('满意度')
  })

  it('离馆核销页渲染 R6 遗失登记与暂扣处置，未结案禁止离馆', async () => {
    const router = makeRouter()
    router.push('/checkout/R20261001-06')
    await router.isReady()
    const w = mount(CheckoutView as never, { global: { plugins: [router] } })
    expect(w.text()).toContain('鸿雁国际旅行社')
    expect(w.text()).toContain('耳麦遗失登记与押金处置')
    expect(w.text()).toContain('HS-049')
    expect(w.text()).toContain('押金暂扣')
    expect(w.text()).toContain('缺失耳麦尚未结案')
    // 找回操作入口存在
    expect(w.text()).toContain('找回且完好，退全部押金')
    expect(w.text()).toContain('找回但损坏，扣维修费')

    // 未结案时离馆按钮禁用
    const finishBtn = () => w.findAll('button').find((b) => b.text().includes('团队离馆'))!
    expect(finishBtn().attributes('disabled')).toBeDefined()

    // 点击「找回且完好」办结
    const foundBtn = w.findAll('button').find((b) => b.text().includes('找回且完好'))!
    await foundBtn.trigger('click')
    expect(w.text()).toContain('押金全退')
    expect(w.text()).not.toContain('缺失耳麦尚未结案')
    // 办结后离馆按钮解锁（库存回库联动在 store 集成测试中覆盖）
    expect(finishBtn().attributes('disabled')).toBeUndefined()
  })

  it('追溯页渲染晨光职校投诉档案证据链', () => {
    const w = mountView(TraceView)
    expect(w.text()).toContain('晨光职业学校')
    expect(w.text()).toContain('讲解缩水')
    expect(w.text()).toContain('完整操作时间线')
  })
})
