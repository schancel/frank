import { createCooperativeBatchYielder, isUserActivelyTyping, setEventLoopYieldForTesting } from './event-loop-yield'

afterEach(() => { setEventLoopYieldForTesting(null); jest.restoreAllMocks() })

it('avoids timers for cheap foreground work while retaining the background batch policy', async () => {
  jest.spyOn(performance, 'now').mockReturnValue(0)
  const host = jest.fn(async () => undefined)
  setEventLoopYieldForTesting(host)
  const foreground = createCooperativeBatchYielder(64, 8, { foreground: true })
  for (let i = 0; i < 32; i++) await foreground.maybeYield()
  expect(host).not.toHaveBeenCalled()
  const background = createCooperativeBatchYielder()
  for (let i = 0; i < 4; i++) await background.maybeYield()
  expect(host).toHaveBeenCalledTimes(1)
})

it('foreground typing yields a real host turn without the background typing delay', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalTimer = globalThis.setTimeout
  const delays: Array<number | undefined> = []
  const events = new EventTarget()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
  try {
    isUserActivelyTyping()
    events.dispatchEvent(new Event('keydown'))
    expect(isUserActivelyTyping()).toBe(true)
    // A jest spy is deliberately treated as a fake timer by the production helper.
    // This plain forwarding wrapper records delays while retaining real host turns.
    globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      delays.push(delay)
      return originalTimer(handler, delay, ...args)
    }) as typeof setTimeout
    let hostRan = false
    const host = new Promise<void>(resolve => setTimeout(() => { hostRan = true; resolve() }, 0))
    const foreground = createCooperativeBatchYielder(64, 8, { foreground: true })
    await foreground.maybeYield(true)
    expect(hostRan).toBe(true)
    expect(delays.at(-1)).toBe(0)
    await createCooperativeBatchYielder().maybeYield(true)
    expect(delays.at(-1)).toBe(60)
    await host
  } finally {
    globalThis.setTimeout = originalTimer
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
