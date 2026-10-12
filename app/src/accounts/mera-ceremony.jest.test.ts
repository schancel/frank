import { fetchMonadProfile } from '@frank/wallet/monad-identity'
import { probeDirectoryRelay } from '@frank/cashweb/relay'
import {
  getActiveChain,
  setActiveChain,
  getCustomRelayBaseUrl,
  setCustomRelayBaseUrl,
} from '@frank/wallet/chain'
import { createAccountCeremony } from './ceremony'
import { MeraAccountError } from './mera-passkey'
import {
  closeDevices,
  activate,
  describeAccount,
  freshDevice,
  openSession,
  prepareDevices,
  restore,
} from './testing/device'

jest.setTimeout(15000)
jest.mock('@frank/wallet/monad-identity', () => ({
  ...jest.requireActual('@frank/wallet/monad-identity'),
  fetchMonadProfile: jest.fn(async () => undefined),
}))
jest.mock('./session', () => ({
  ...jest.requireActual('./session'),
  get accountSession() {
    return jest.requireActual('./testing/device').currentSession()
  },
}))
jest.mock('@frank/cashweb/relay', () => ({
  probeDirectoryRelay: jest.fn(async () => undefined),
}))
beforeAll(prepareDevices)
afterEach(closeDevices)
const syntheticRoot = () =>
  Uint8Array.from({ length: 32 }, (_, index) => index + 1)

test.each([
  [2, 3],
  [3, 5],
] as const)(
  'passkey create/login and ordinary %i-of-%i root backup recover the same account and family addresses',
  async (threshold, count) => {
    const original = freshDevice()
    await original.initialize()
    const root = syntheticRoot()
    await createAccountCeremony().beginPasskey('create', async () => root)
    expect(root.every(byte => byte === 0)).toBe(true)
    expect(original.state.status).toBe('pending')
    expect(original.state.account).toBeNull()
    await activate(original)
    const expected = await describeAccount(original)
    const shares = await original.backupCodex32(threshold, count)
    await original.close()
    const reopened = openSession()
    await reopened.initialize()
    expect(await describeAccount(reopened)).toEqual(expected)
    await reopened.close()
    const login = freshDevice()
    await login.initialize()
    await createAccountCeremony().beginPasskey('login', async () =>
      syntheticRoot(),
    )
    await activate(login)
    expect(await describeAccount(login)).toEqual(expected)
    await login.close()
    const recovered = freshDevice()
    await recovered.initialize()
    await restore(recovered, shares.slice(0, threshold))
    expect(await describeAccount(recovered)).toEqual(expected)
  },
)

test.each(['unsupported', 'cancelled', 'prf'] as const)(
  '%s credential failure leaves fresh custody unchanged',
  async code => {
    const session = freshDevice()
    await session.initialize()
    const before = await session.snapshot()
    await expect(
      createAccountCeremony().beginPasskey('login', async () => {
        throw new MeraAccountError(code)
      }),
    ).rejects.toMatchObject({ code })
    expect(await session.snapshot()).toEqual(before)
  },
)

test.each([
  'cancel',
  'chain',
  'chain-roundtrip',
  'replacement',
  'close',
] as const)(
  'late credential output after %s cannot stage a new account',
  async race => {
    const session = freshDevice()
    await session.initialize()
    const ceremony = createAccountCeremony()
    let answer!: (root: Uint8Array) => void
    let entered!: () => void
    const promptEntered = new Promise<void>(resolve => {
      entered = resolve
    })
    const pending = ceremony.beginPasskey('login', () => {
      entered()
      return new Promise(resolve => {
        answer = resolve
      })
    })
    await promptEntered
    const previousChain = getActiveChain()
    try {
      if (race === 'cancel') ceremony.cancel()
      if (race === 'chain' || race === 'chain-roundtrip')
        setActiveChain({
          ...previousChain,
          chainIdentifier: 'ethereum-sepolia',
        })
      if (race === 'chain-roundtrip') setActiveChain(previousChain)
      if (race === 'close') await session.close()
      if (race === 'replacement') {
        await createAccountCeremony().beginPasskey('create', async () =>
          new Uint8Array(32).fill(9),
        )
        await activate(session)
      }
      const root = syntheticRoot()
      answer(root)
      await expect(pending).rejects.toThrow()
      expect(root.every(byte => byte === 0)).toBe(true)
      if (race !== 'close')
        expect((await session.snapshot()).pending).toBeNull()
    } finally {
      setActiveChain(previousChain)
    }
  },
)

test.each(['replacement', 'close'] as const)(
  'a deferred directory lookup after %s never changes relay routing or activates the stale login',
  async race => {
    const session = freshDevice()
    await session.initialize()
    const home = 'https://current-account-relay.example'
    setCustomRelayBaseUrl(home)
    let answer!: (relay: string) => void
    let entered!: () => void
    const probing = new Promise<void>(resolve => {
      entered = resolve
    })
    jest.mocked(probeDirectoryRelay).mockImplementationOnce(() => {
      entered()
      return new Promise(resolve => {
        answer = resolve
      })
    })
    const login = createAccountCeremony().beginPasskey('login', async () =>
      syntheticRoot(),
    )
    await probing
    let replacement: Awaited<ReturnType<typeof describeAccount>> | undefined
    if (race === 'replacement') {
      await createAccountCeremony().beginPasskey('create', async () =>
        new Uint8Array(32).fill(9),
      )
      await activate(session)
      replacement = await describeAccount(session)
    } else await session.close()
    answer('https://stale-account-relay.example')
    await expect(login).rejects.toThrow()
    expect(getCustomRelayBaseUrl()).toBe(home)
    if (race === 'replacement') {
      expect((await session.snapshot()).pending).toBeNull()
      expect(await describeAccount(session)).toEqual(replacement)
    }
    setCustomRelayBaseUrl(undefined)
  },
)

test.each(['existing', 'unverified', 'unreachable'] as const)(
  'login preserves read-only profile verification outcome %s',
  async verification => {
    const session = freshDevice()
    await session.initialize()
    const fetchProfile = jest.mocked(fetchMonadProfile)
    if (verification === 'existing')
      fetchProfile.mockResolvedValueOnce({
        name: 'Synthetic profile',
      } as Awaited<ReturnType<typeof fetchMonadProfile>>)
    else if (verification === 'unreachable')
      fetchProfile.mockRejectedValueOnce(new Error('Offline'))
    else fetchProfile.mockResolvedValueOnce(undefined)
    const ceremony = createAccountCeremony()
    try {
      const result = await ceremony.beginPasskey('login', async () =>
        syntheticRoot(),
      )
      expect(result.loginVerification).toBe(verification)
      expect(result.attemptId).toBeTruthy()
    } finally {
      ceremony.cancel()
    }
  },
)

test.each(['replacement', 'close', 'cancel', 'chain'] as const)(
  'a deferred positive profile after %s cannot stage the login',
  async race => {
    const session = freshDevice()
    await session.initialize()
    const previousChain = getActiveChain()
    let answer!: (value: Awaited<ReturnType<typeof fetchMonadProfile>>) => void
    let entered!: () => void
    const probing = new Promise<void>(resolve => {
      entered = resolve
    })
    jest.mocked(fetchMonadProfile).mockImplementationOnce(() => {
      entered()
      return new Promise(resolve => {
        answer = resolve
      })
    })
    const ceremony = createAccountCeremony()
    const login = ceremony.beginPasskey('login', async () => syntheticRoot())
    await probing
    try {
      if (race === 'replacement') {
        await createAccountCeremony().beginPasskey('create', async () =>
          new Uint8Array(32).fill(9),
        )
        await activate(session)
      } else if (race === 'close') await session.close()
      else if (race === 'cancel') ceremony.cancel()
      else {
        setActiveChain({
          ...previousChain,
          chainIdentifier: 'ethereum-sepolia',
        })
        setActiveChain(previousChain)
      }
      answer({ name: 'Synthetic profile' } as Awaited<
        ReturnType<typeof fetchMonadProfile>
      >)
      await expect(login).rejects.toThrow()
      if (race !== 'close')
        expect((await session.snapshot()).pending).toBeNull()
    } finally {
      setActiveChain(previousChain)
      ceremony.cancel()
    }
  },
)
