import { finishSetupAndEnter } from './setup-persistence'

function harness() {
  const location = { hash: '#/setup', reload: jest.fn() }
  const initialize = jest.fn(() => Promise.resolve('started'))
  const navigate = jest.fn(() => Promise.resolve())
  return { location, initialize, navigate }
}

describe('setup finish boundary (#171, #389)', () => {
  it('navigates only after identity initialization succeeds', async () => {
    const { location, initialize, navigate } = harness()

    await finishSetupAndEnter({
      finishReloads: false,
      location,
      initialize,
      navigate,
    })

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/forum')
  })

  it('does not navigate when identity initialization fails', async () => {
    const { location, navigate } = harness()
    const failure = new Error('wallet derive failed')

    await expect(
      finishSetupAndEnter({
        finishReloads: false,
        location,
        initialize: () => Promise.reject(failure),
        navigate,
      }),
    ).rejects.toThrow('wallet derive failed')

    expect(navigate).not.toHaveBeenCalled()
  })

  it('surfaces navigation failures to the caller', async () => {
    const { location, initialize } = harness()
    const failure = new Error('navigation failed')

    await expect(
      finishSetupAndEnter({
        finishReloads: false,
        location,
        initialize,
        navigate: () => Promise.reject(failure),
      }),
    ).rejects.toThrow('navigation failed')

    expect(initialize).toHaveBeenCalledTimes(1)
  })

  it('uses the configured reload fallback once without initializing or navigating', async () => {
    const { location, initialize, navigate } = harness()

    await finishSetupAndEnter({
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

  it('propagates a throwing reload once without initializing or navigating', async () => {
    const { location, initialize, navigate } = harness()
    location.reload.mockImplementation(() => {
      throw new Error('reload refused')
    })

    await expect(
      finishSetupAndEnter({
        finishReloads: true,
        location,
        initialize,
        navigate,
      }),
    ).rejects.toThrow('reload refused')

    expect(location.reload).toHaveBeenCalledTimes(1)
    expect(initialize).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})
