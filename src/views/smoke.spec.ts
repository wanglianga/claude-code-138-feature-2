// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest'
import { nextTick } from 'vue'
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

function mountView(component: unknown, initialPath?: string) {
  const router = makeRouter()
  if (initialPath) router.push(initialPath)
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

  it('离馆核销页标记遗失后出现借出人/负责人/最后展厅登记与三种处置方式', async () => {
    const w = mountView(CheckoutView)
    const lostBtn = w.findAll('button').find((b) => b.text().trim() === '遗 失')
    expect(lostBtn).toBeTruthy()
    await lostBtn!.trigger('click')
    const text = w.text()
    expect(text).toContain('现场寻找')
    expect(text).toContain('押金暂扣')
    expect(text).toContain('当场赔付')
  })

  it('离馆核销页为已离馆暂扣团渲染保洁找回与押金处理面板', async () => {
    const w = mountView(CheckoutView)
    const r6Item = w.findAll('.queue-item').find((d) => d.text().includes('鸿雁假期'))
    expect(r6Item).toBeTruthy()
    await r6Item!.trigger('click')
    await nextTick()
    const text = w.text()
    expect(text).toContain('耳麦遗失后续处理')
    expect(text).toContain('HS-041')
    expect(text).toContain('团员陈晨')
    expect(text).toContain('周领队')
    expect(text).toContain('中庭')
    expect(text).toContain('退还押金')
    expect(text).toContain('维修费')
  })

  it('运营看板渲染遗失押金暂扣跟进面板', () => {
    const w = mountView(OpsView)
    expect(w.text()).toContain('耳麦遗失')
    expect(w.text()).toContain('HS-041')
  })

  it('追溯页渲染晨光职校投诉档案证据链', () => {
    const w = mountView(TraceView)
    expect(w.text()).toContain('晨光职业学校')
    expect(w.text()).toContain('讲解缩水')
    expect(w.text()).toContain('完整操作时间线')
  })
})
