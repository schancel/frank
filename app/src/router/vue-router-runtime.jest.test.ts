/** @jest-environment jsdom */
import { createMemoryHistory, createRouter } from 'vue-router'

it('loads the real router diagnostics dependency and navigates independent chat routes', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/chat/:conversationId', component: { template: '<div />' } },
    ],
  })
  await router.push('/chat/first-thread')
  expect(router.currentRoute.value.params.conversationId).toBe('first-thread')
  await router.push('/chat/second-thread')
  expect(router.currentRoute.value.fullPath).toBe('/chat/second-thread')
  router.back()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(router.currentRoute.value.params.conversationId).toBe('first-thread')
})
