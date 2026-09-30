import {
  BurnRefreshError,
  notifyBurnFailure,
  refreshAfterBurn,
} from './burn-refresh-error'
import { errorNotify, infoNotify } from './notifications'

jest.mock('./notifications', () => ({
  errorNotify: jest.fn(),
  infoNotify: jest.fn(),
}))

const t = (key: string) => `T(${key})`

beforeEach(() => jest.clearAllMocks())

describe('refreshAfterBurn', () => {
  it('passes a successful refresh through', async () => {
    await expect(
      refreshAfterBurn('post', async () => 1),
    ).resolves.toBeUndefined()
  })

  it('turns any refresh failure into a BurnRefreshError of the right kind', async () => {
    const failure = await refreshAfterBurn('vote', async () => {
      throw new Error('relay down')
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(BurnRefreshError)
    expect((failure as BurnRefreshError).kind).toBe('vote')
    expect((failure as Error).message).toContain('relay down')
  })
})

describe('notifyBurnFailure', () => {
  it.each([
    ['post', 'stampPreparation.postedRefreshFailed'],
    ['vote', 'stampPreparation.votedRefreshFailed'],
  ] as const)(
    'a %s whose burn landed but whose read-back failed is an info notice, never an error',
    (kind, key) => {
      notifyBurnFailure(new BurnRefreshError(kind, new Error('x')), t)
      expect(infoNotify).toHaveBeenCalledWith(`T(${key})`)
      expect(errorNotify).not.toHaveBeenCalled()
    },
  )

  it('reports any other failure as an error', () => {
    const err = new Error('nothing was sent')
    notifyBurnFailure(err, t)
    expect(errorNotify).toHaveBeenCalledWith(err)
    expect(infoNotify).not.toHaveBeenCalled()
  })
})
