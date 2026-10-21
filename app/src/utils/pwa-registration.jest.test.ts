import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

// Execute the shipped registration entry, including its visibility callback.
// Only Quasar's notice and the registration library are replaced at this boundary.
function registrationHarness(initialController: object | null = null) {
  const source = readFileSync(
    join(__dirname, '../../src-pwa/register-service-worker.js'),
    'utf8',
  )
    .replace(/^import .* from .*\n/gm, '')
    .replace(/export /g, '')
    .replace('import.meta.env.QUASAR_SERVICE_WORKER_FILE', "'/sw.js'")
  let callbacks: Record<string, (registration: unknown) => void> = {}
  const listeners = new Map<string, () => void>()
  const workerListeners = new Map<string, () => void>()
  const getRegistration = jest.fn()
  const getRegistrations = jest.fn().mockResolvedValue([])
  const warning = jest.fn()
  const reload = jest.fn()
  const notice = jest.fn(
    (_options: { actions: { handler: () => void }[]; onDismiss: () => void }) =>
      jest.fn(),
  )
  const window: Record<string, unknown> = { location: { reload } }
  const serviceWorker = {
    controller: initialController,
    getRegistration,
    getRegistrations,
    addEventListener: (type: string, callback: () => void) =>
      workerListeners.set(type, callback),
  }
  let now = 60_000
  const context = vm.createContext({
    window,
    navigator: {
      serviceWorker,
    },
    document: {
      visibilityState: 'visible',
      addEventListener: (type: string, callback: () => void) =>
        listeners.set(type, callback),
    },
    Date: { now: () => now },
    Notify: { create: notice },
    console: { warn: warning },
    register: (_url: string, hooks: typeof callbacks) => {
      callbacks = hooks
    },
  })
  vm.runInContext(source, context)
  return {
    registered: (registration: unknown) => callbacks.registered(registration),
    updated: (registration: unknown) => callbacks.updated(registration),
    controlledBy: (controller: object | null) => {
      serviceWorker.controller = controller
      workerListeners.get('controllerchange')?.()
    },
    check: () => (window.checkForAppUpdate as () => Promise<unknown>)(),
    refresh: () => (window.forceCacheRefresh as () => Promise<void>)(),
    visible: () => {
      now += 30_001
      listeners.get('visibilitychange')?.()
    },
    getRegistration,
    getRegistrations,
    warning,
    reload,
    notice,
  }
}

it('re-resolves a replacement registration rather than updating a removed registration on visibility', async () => {
  const harness = registrationHarness()
  const old = { update: jest.fn().mockResolvedValue(undefined) }
  const current = { update: jest.fn().mockResolvedValue(undefined) }
  harness.getRegistration.mockResolvedValue(old)
  harness.registered(old)
  await harness.check()
  old.update.mockRejectedValue(new Error('registration has been uninstalled'))
  harness.getRegistration.mockResolvedValue(current)
  harness.visible()
  await harness.check()
  expect(old.update).toHaveBeenCalledTimes(1)
  expect(current.update).toHaveBeenCalledTimes(1)
  expect(harness.warning).not.toHaveBeenCalled()
})

it('does not offer an update when the first worker takes control, including after a reload', () => {
  // An uncontrolled navigation may be claimed after registration on each visit. This does not
  // establish that the page is stale; offering an update here creates a reload/notice loop.
  for (let visit = 0; visit < 2; visit++) {
    const harness = registrationHarness()
    harness.controlledBy({ scriptURL: '/sw.js' })
    expect(harness.notice).not.toHaveBeenCalled()
    expect(harness.reload).not.toHaveBeenCalled()
  }
})

it('does not mistake a first installation briefly waiting before activation for an update', () => {
  const harness = registrationHarness()
  harness.updated({ active: null, waiting: { postMessage: jest.fn() } })
  expect(harness.notice).not.toHaveBeenCalled()
})

it('offers an update when a different worker replaces the controller of an open page', () => {
  const original = { scriptURL: '/sw.js' }
  const harness = registrationHarness(original)
  harness.controlledBy(original)
  expect(harness.notice).not.toHaveBeenCalled()
  harness.controlledBy({ scriptURL: '/sw.js' })
  expect(harness.notice).toHaveBeenCalledTimes(1)
})

it('reloads once after accepting a waiting update, without offering it again during activation', async () => {
  const harness = registrationHarness({ scriptURL: '/sw.js' })
  const waiting = { postMessage: jest.fn(), addEventListener: jest.fn() }
  const registration = { waiting: waiting as typeof waiting | null }
  harness.updated(registration)
  const options = harness.notice.mock.calls[0][0]
  options.actions[0].handler()
  options.onDismiss()
  expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  expect(harness.reload).not.toHaveBeenCalled()
  registration.waiting = null
  const activated = { scriptURL: '/sw.js' }
  harness.controlledBy(activated)
  harness.controlledBy(activated)
  harness.updated(registration)
  expect(harness.reload).toHaveBeenCalledTimes(1)
  expect(harness.notice).toHaveBeenCalledTimes(1)
})

it('reloads when the accepted worker activates even if controllerchange is not delivered', () => {
  const harness = registrationHarness({ scriptURL: '/sw.js' })
  let stateChanged: (() => void) | undefined
  const waiting = {
    state: 'installed',
    postMessage: jest.fn(),
    addEventListener: jest.fn((_type: string, callback: () => void) => {
      stateChanged = callback
    }),
    removeEventListener: jest.fn(),
  }
  harness.updated({ active: {}, waiting })
  harness.notice.mock.calls[0][0].actions[0].handler()
  waiting.state = 'activated'
  stateChanged?.()
  expect(harness.reload).toHaveBeenCalledTimes(1)
  harness.controlledBy(waiting)
  expect(harness.reload).toHaveBeenCalledTimes(1)
  expect(waiting.removeEventListener).toHaveBeenCalledWith(
    'statechange',
    stateChanged,
  )
})

it('coalesces concurrent update requests', async () => {
  const harness = registrationHarness()
  let finish!: () => void
  const update = jest.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      }),
  )
  harness.getRegistration.mockResolvedValue({ update })
  const first = harness.check()
  const second = harness.check()
  await Promise.resolve()
  expect(update).toHaveBeenCalledTimes(1)
  finish()
  await Promise.all([first, second])
  expect(harness.getRegistration).toHaveBeenCalledTimes(1)
})

it('suspends visibility checks and pending update notices before explicit unregister/reload', async () => {
  const harness = registrationHarness()
  let reject!: (error: Error) => void
  const update = jest.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail
      }),
  )
  const unregister = jest.fn().mockResolvedValue(true)
  const registration = { update, unregister }
  harness.getRegistration.mockResolvedValue(registration)
  harness.getRegistrations.mockResolvedValue([registration])
  harness.registered(registration)
  const pending = harness.check()
  await Promise.resolve()
  await harness.refresh()
  harness.visible()
  harness.updated({ waiting: { postMessage: jest.fn() } })
  reject(new Error('registration has been uninstalled'))
  await pending
  expect(await harness.check()).toBeNull()
  expect(update).toHaveBeenCalledTimes(1)
  expect(unregister).toHaveBeenCalledTimes(1)
  expect(harness.reload).toHaveBeenCalledTimes(1)
  expect(harness.warning).not.toHaveBeenCalled()
  expect(harness.notice).not.toHaveBeenCalled()
})

it('preserves Later for the same waiting worker on background checks but offers a replacement', async () => {
  const harness = registrationHarness()
  const waiting = { postMessage: jest.fn() }
  const registration = {
    active: {},
    waiting,
    update: jest.fn().mockResolvedValue(undefined),
  }
  harness.getRegistration.mockResolvedValue(registration)
  harness.registered(registration)
  await harness.check()
  const options = harness.notice.mock.calls[0][0]
  options.actions[1].handler()
  options.onDismiss()
  harness.visible()
  // Flush the background getRegistration/update/offer chain without issuing a
  // manual check, which intentionally resets the user's deferral.
  await new Promise(resolve => setImmediate(resolve))
  expect(harness.notice).toHaveBeenCalledTimes(1)
  registration.waiting = { postMessage: jest.fn() }
  harness.visible()
  await new Promise(resolve => setImmediate(resolve))
  expect(harness.notice).toHaveBeenCalledTimes(2)
})

it('offers an update when registration.update() starts an installing worker that finishes later', async () => {
  const harness = registrationHarness()
  let stateChangeHandler: (() => void) | undefined
  const installingWorker = {
    state: 'installing',
    postMessage: jest.fn(),
    addEventListener: jest.fn((event: string, cb: () => void) => {
      if (event === 'statechange') stateChangeHandler = cb
    }),
  }
  const registration: {
    active: object
    installing: typeof installingWorker | null
    waiting: typeof installingWorker | null
    update: jest.Mock
  } = {
    active: {},
    installing: null,
    waiting: null,
    update: jest.fn(async () => {
      registration.installing = installingWorker
    }),
  }
  harness.getRegistration.mockResolvedValue(registration)
  await harness.check()
  expect(harness.notice).not.toHaveBeenCalled()
  expect(installingWorker.addEventListener).toHaveBeenCalledTimes(1)

  installingWorker.state = 'installed'
  registration.waiting = installingWorker
  registration.installing = null
  stateChangeHandler?.()
  expect(harness.notice).toHaveBeenCalledTimes(1)
})
