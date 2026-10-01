import { finishSetupAndEnter } from './setup-persistence'

function harness() {
  const initialize = jest.fn(() => Promise.resolve('started'))
  const navigate = jest.fn(() => Promise.resolve())
  return { initialize, navigate }
}

describe('setup finish boundary (#171, #389)', () => {
  it('navigates only after identity initialization succeeds', async () => {
    const { initialize, navigate } = harness()

    await finishSetupAndEnter({ initialize, navigate })

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/forum')
  })

  it('does not navigate when identity initialization fails', async () => {
    const { navigate } = harness()
    const failure = new Error('wallet derive failed')

    await expect(
      finishSetupAndEnter({
        initialize: () => Promise.reject(failure),
        navigate,
      }),
    ).rejects.toThrow('wallet derive failed')

    expect(navigate).not.toHaveBeenCalled()
  })

  it('surfaces navigation failures to the caller', async () => {
    const { initialize } = harness()
    const failure = new Error('navigation failed')

    await expect(
      finishSetupAndEnter({
        initialize,
        navigate: () => Promise.reject(failure),
      }),
    ).rejects.toThrow('navigation failed')

    expect(initialize).toHaveBeenCalledTimes(1)
  })
})
