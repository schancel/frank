import { submitPost } from './submit-post'

describe('submitPost', () => {
  it('on success: notifies and navigates away exactly once', async () => {
    const submit = jest.fn().mockResolvedValue(undefined)
    const errorNotify = jest.fn()
    const infoNotify = jest.fn()
    const navigateBack = jest.fn()

    await submitPost({ submit, errorNotify, infoNotify, navigateBack })

    expect(infoNotify).toHaveBeenCalledTimes(1)
    expect(infoNotify).toHaveBeenCalledWith('Post created!')
    expect(navigateBack).toHaveBeenCalledTimes(1)
    expect(errorNotify).not.toHaveBeenCalled()
  })

  it('on failure: shows the error, never navigates away, never shows success', async () => {
    const error = new Error('deterministic relay failure')
    const submit = jest.fn().mockRejectedValue(error)
    const errorNotify = jest.fn()
    const infoNotify = jest.fn()
    const navigateBack = jest.fn()

    await submitPost({ submit, errorNotify, infoNotify, navigateBack })

    expect(errorNotify).toHaveBeenCalledTimes(1)
    expect(errorNotify).toHaveBeenCalledWith(error)
    // The actual bug (ticket #159): navigateBack used to run unconditionally in a `finally`,
    // discarding the draft (the component unmounts on navigation) even though submission failed.
    expect(navigateBack).not.toHaveBeenCalled()
    expect(infoNotify).not.toHaveBeenCalled()
  })

  it('a failure inside submit() itself (e.g. fetching the wallet, not just the post call) is treated the same as a postMessage rejection', async () => {
    const error = new Error('wallet unavailable')
    const submit = jest.fn(async () => {
      throw error
    })
    const errorNotify = jest.fn()
    const infoNotify = jest.fn()
    const navigateBack = jest.fn()

    await submitPost({ submit, errorNotify, infoNotify, navigateBack })

    expect(errorNotify).toHaveBeenCalledWith(error)
    expect(navigateBack).not.toHaveBeenCalled()
  })
})
