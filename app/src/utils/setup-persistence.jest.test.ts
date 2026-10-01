import { finishSetupAndEnter } from './setup-persistence'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function harness() {
  const location = { hash: '#/setup', reload: jest.fn() }
  const notifyError = jest.fn()
  const initialize = jest.fn(() => Promise.resolve('started'))
  const navigate = jest.fn(() => Promise.resolve())
  return { location, notifyError, initialize, navigate }
}

describe('setup finish boundary (#171, #389)', () => {
  it('does not initialize until both wallet and profile writes are durable', async () => {
    const walletWrite = deferred()
    const profileWrite = deferred()
    const { location, notifyError, initialize, navigate } = harness()

    const completion = finishSetupAndEnter({
      wallet: { flushPersistence: () => walletWrite.promise },
      profile: { flushPersistence: () => profileWrite.promise },
      notifyError,
      finishReloads: false,
      location,
      initialize,
      navigate,
    })

    walletWrite.resolve()
    await Promise.resolve()
    expect(initialize).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    expect(location.reload).not.toHaveBeenCalled()

    profileWrite.resolve()
    await completion
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/forum')
    expect(location).toEqual({
      hash: '#/setup',
      reload: expect.any(Function),
    })
    expect(location.reload).not.toHaveBeenCalled()
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('does not initialize or navigate when persistence fails', async () => {
    const { location, notifyError, initialize, navigate } = harness()
    const failure = new Error('disk full')

    await expect(
      finishSetupAndEnter({
        wallet: { flushPersistence: () => Promise.resolve() },
        profile: { flushPersistence: () => Promise.reject(failure) },
        notifyError,
        finishReloads: false,
        location,
        initialize,
        navigate,
      }),
    ).rejects.toThrow('disk full')

    expect(location).toEqual({ hash: '#/setup', reload: expect.any(Function) })
    expect(location.reload).not.toHaveBeenCalled()
    expect(initialize).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalledWith(failure)
  })

  it('normalizes non-Error persistence failures for the user', async () => {
    const { location, notifyError, initialize, navigate } = harness()

    await expect(
      finishSetupAndEnter({
        wallet: {
          flushPersistence: () => Promise.reject('storage unavailable'),
        },
        profile: { flushPersistence: () => Promise.resolve() },
        notifyError,
        finishReloads: false,
        location,
        initialize,
        navigate,
      }),
    ).rejects.toThrow('storage unavailable')

    expect(notifyError).toHaveBeenCalledWith(expect.any(Error))
    expect(location.reload).not.toHaveBeenCalled()
    expect(initialize).not.toHaveBeenCalled()
  })

  it('reloads only when the explicit fallback flag is on, and does not initialize', async () => {
    const { location, notifyError, initialize, navigate } = harness()

    await finishSetupAndEnter({
      wallet: { flushPersistence: () => Promise.resolve() },
      profile: { flushPersistence: () => Promise.resolve() },
      notifyError,
      finishReloads: true,
      location,
      initialize,
      navigate,
    })

    expect(location.hash).toBe('#/')
    expect(location.reload).toHaveBeenCalledTimes(1)
    expect(initialize).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not navigate when identity initialization fails', async () => {
    const { location, notifyError, navigate } = harness()
    const failure = new Error('wallet derive failed')

    await expect(
      finishSetupAndEnter({
        wallet: { flushPersistence: () => Promise.resolve() },
        profile: { flushPersistence: () => Promise.resolve() },
        notifyError,
        finishReloads: false,
        location,
        initialize: () => Promise.reject(failure),
        navigate,
      }),
    ).rejects.toThrow('wallet derive failed')

    expect(navigate).not.toHaveBeenCalled()
    expect(location.reload).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalledWith(failure)
  })
})
