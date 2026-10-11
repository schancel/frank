/**
 * Account backup round trip with nothing under test mocked. See ./testing/device for what is real
 * (session, custody, vault, ceremony, recovery) and the three stand-ins outside backup/restore.
 */
import {
  createLongBchChecksum,
  GF32_ALPHABET,
  splitCodex32,
} from '@frank/codex32'
import { DOMAIN_PURPOSES, BIP39_DERIVATION } from '@frank/domain-roots'
import {
  exportRecoveryShares,
  recoverAccountBackupShares,
  destroyRecoveredBackup,
  parseAccountBackupShareInput,
} from '@frank/account-recovery'
import { historicalBip39WalletMaterial } from '@frank/wallet/monad-wallet-material'
import { mnemonicToSeedSync } from 'bip39'
import { createAccountCeremony, recoveryErrorMessage } from './ceremony'
import { AccountBackupUnavailableError, stageBip39Recovery } from './session'
import { MonadIdentity } from '@frank/wallet/monad-identity'
import { CustodyError } from './custody'
import {
  closeDevices,
  activate,
  describeAccount,
  failure,
  forgetAccountRoot,
  freshDevice,
  openSession,
  prepareDevices,
  restore,
  signUp,
} from './testing/device'

// This suite does real account derivation, Codex32 and KDF work. The app-wide 1 s budget
// (test/jest/jest.setup.ts) is too tight for a shared CI runner, so these suites get more.
jest.setTimeout(15000)

jest.mock('./session', () => ({
  ...jest.requireActual('./session'),
  // The ceremony stages into whichever device the test is currently using.
  get accountSession() {
    return jest.requireActual('./testing/device').currentSession()
  },
}))
jest.mock('@frank/cashweb/relay', () => ({
  probeDirectoryRelay: jest.fn(async () => undefined),
}))

beforeAll(prepareDevices)
afterEach(closeDevices)

test('a historical BIP39 phrase uses shared staging, activation and reopen without a name or reset', async () => {
  const phrase = 'test test test test test test test test test test test junk'
  const expected = MonadIdentity.fromSeed({ mnemonic: phrase })
  const session = freshDevice()
  await session.initialize()
  await stageBip39Recovery(session, phrase)
  expect(session.state.status).toBe('pending')
  expect(session.state.account).toBeNull()
  expect(session.state.pendingIdentityAddress).toBe(expected.displayAddress)
  expect(session.state.pending?.account.displayName).toBe('')
  await activate(session)
  expect((await session.getWallet()).identity.compressedPubKey).toEqual(
    expected.compressedPubKey,
  )
  await session.close()
  const reopened = openSession()
  await reopened.initialize()
  expect(reopened.state.status).toBe('ready')
  expect((await reopened.getWallet()).identity.compressedPubKey).toEqual(
    expected.compressedPubKey,
  )
  await expect(
    reopened.getActiveDomainRoot('evm-wallet'),
  ).rejects.toMatchObject({ code: 'account-purpose-unavailable' })
  expect((await reopened.backupCodex32(2, 3)).length).toBe(3)
})

function historicalPublicKeys(seed: Uint8Array) {
  const material = historicalBip39WalletMaterial({
    derivation: BIP39_DERIVATION,
    seed,
  })
  try {
    return {
      identity: Buffer.from(material.identity.compressedPubKey).toString('hex'),
      spend: material.keyring.deriveSubAccount(0).publicKey,
      change: material.changeKeyring.deriveChangeAccount(0).publicKey,
    }
  } finally {
    material.dispose()
  }
}

test.each([
  [1, 1],
  [2, 3],
  [3, 5],
] as const)(
  'historical %i-of-%i backup restores the original identity and spend keys through activation and reopen',
  async (threshold, count) => {
    const phrase = 'test test test test test test test test test test test junk'
    const originalSeed = mnemonicToSeedSync(phrase)
    const expected = historicalPublicKeys(originalSeed)
    const original = freshDevice()
    await original.initialize()
    await stageBip39Recovery(original, phrase)
    await activate(original)
    const shares = await original.backupCodex32(threshold, count)
    expect(shares.length).toBe(count)
    await original.close()
    const paper = shares.slice(-threshold).join('\n')
    const observed: ReturnType<typeof historicalPublicKeys>[] = []
    const options = {
      observeHistoricalSeed: (seed: Uint8Array) => {
        expect(
          seed.length === originalSeed.length &&
            seed.every((byte, i) => byte === originalSeed[i]),
        ).toBe(true)
        observed.push(historicalPublicKeys(seed))
      },
    }
    const restored = freshDevice(options)
    await restore(restored, parseAccountBackupShareInput(paper))
    expect(observed).toEqual([expected])
    expect(
      Buffer.from(
        (await restored.getWallet()).identity.compressedPubKey,
      ).toString('hex'),
    ).toBe(expected.identity)
    await restored.close()
    const reopened = openSession(options)
    await reopened.initialize()
    expect(observed).toEqual([expected, expected])
    expect(
      Buffer.from(
        (await reopened.getWallet()).identity.compressedPubKey,
      ).toString('hex'),
    ).toBe(expected.identity)
    const secondBackup = await reopened.backupCodex32(threshold, count)
    expect(secondBackup.length).toBe(count)
    originalSeed.fill(0)
  },
)

test('mixed historical backup sets fail before staging and leave the active account unchanged', async () => {
  const session = freshDevice()
  await session.initialize()
  await stageBip39Recovery(
    session,
    'test test test test test test test test test test test junk',
  )
  await activate(session)
  const before = await session.snapshot()
  const first = await session.backupCodex32(2, 3)
  const second = await session.backupCodex32(2, 3)
  const wrong = [first[0]!, second[1]!]
  const ceremony = createAccountCeremony()
  await ceremony.beginRestore()
  await expect(ceremony.confirm(wrong, '')).rejects.toThrow()
  expect(await session.snapshot()).toEqual(before)
  expect(session.state.status).toBe('ready')
})

test('historical recovery derives every existing family address locally from its original seed', async () => {
  const phrase = 'test test test test test test test test test test test junk'
  const session = freshDevice()
  await session.initialize()
  await stageBip39Recovery(session, phrase)
  await activate(session)
  // The user-visible address call failed before this correction, before any indexer access.
  const ecashAddress = await session.getChainAddress('ecash')
  const material = await session.getActiveFamilyMaterial('ecash-bch-wallet')
  expect('seed' in material).toBe(true)
  if (!('seed' in material))
    throw new Error('Expected historical seed material')
  try {
    const { HDNodeWallet, getBytes } = await import('ethers')
    const { encodeCashAddress } = await import('ecashaddrjs')
    const { ripemd160 } = await import('@noble/hashes/ripemd160.js')
    const { sha256 } = await import('@noble/hashes/sha256.js')
    const node = HDNodeWallet.fromSeed(material.seed).derivePath(
      "m/44'/1899'/0'/0/0",
    )
    expect(await session.getChainAddress('ecash')).toBe(
      encodeCashAddress(
        'ectest',
        'p2pkh',
        ripemd160(sha256(getBytes(node.publicKey))),
      ),
    )
    expect(await session.getChainAddress('bitcoin')).toMatch(/^tb1q/)
    expect(await session.getChainAddress('bitcoincash')).toMatch(/^bchtest:/)
    const { SolanaHdKeyring } = await import('@frank/wallet/ed25519-hd-keyring')
    const original = await SolanaHdKeyring.fromMnemonic(phrase)
    const leaf = await original.deriveSubAccount(0)
    try {
      expect(await session.getChainAddress('solana')).toBe(leaf.address)
      expect((await session.getSolanaSigner()).publicKey.toBase58()).toBe(
        leaf.address,
      )
      expect(await session.getCurvePublicKey('ed25519')).toEqual(
        new Uint8Array(leaf.publicKey.toBytes()),
      )
    } finally {
      leaf.privateKeyBytes.fill(0)
    }
  } finally {
    material.seed.fill(0)
  }
})

test('recovered custody stays durable while required profile restoration gates activation and retry', async () => {
  const originalDevice = freshDevice()
  const shares = await signUp(originalDevice)
  const original = await describeAccount(originalDevice)
  await originalDevice.close()
  let resolveProfile!: () => void
  let beginProfile!: () => void
  let profileStarted = new Promise<void>(resolve => {
    beginProfile = resolve
  })
  let online = false
  const restoring = freshDevice({
    restoreApplicationState: async ({ account }) => {
      expect(account.displayName).toBe('')
      await new Promise<void>(resolve => {
        resolveProfile = resolve
        beginProfile()
      })
      if (!online) throw new CustodyError('profile-unreachable')
    },
  })
  await restoring.initialize()
  const ceremony = createAccountCeremony()
  await ceremony.beginRestore()
  await ceremony.confirm(shares.slice(0, 2), '')
  const pending = restoring.state.pending!
  const activating = restoring.activatePending(
    pending.account.receipt.operationId,
    pending.expectedActive,
  )
  // Real IndexedDB and WebCrypto must finish before the application restoration starts.
  await Promise.race([
    profileStarted,
    activating.then(() => {
      throw new Error(
        'Account activation finished before required profile restoration',
      )
    }),
  ])
  expect(restoring.state.status).toBe('loading')
  expect(restoring.state.account?.fingerprint).toBe(original.fingerprint)
  resolveProfile()
  await activating
  expect(restoring.state.status).toBe('unavailable')
  expect(restoring.state.error).toBe('profile-unreachable')
  expect(restoring.state.pending).toBeNull()
  expect(restoring.state.account?.fingerprint).toBe(original.fingerprint)
  online = true
  profileStarted = new Promise<void>(resolve => {
    beginProfile = resolve
  })
  const retrying = restoring.retry()
  await profileStarted
  expect(restoring.state.status).toBe('loading')
  resolveProfile()
  await retrying
  expect(restoring.state.status).toBe('ready')
  expect(await describeAccount(restoring)).toEqual(original)
})

test('restore activates and reopens the same custody account without a display name', async () => {
  const originalDevice = freshDevice()
  const shares = await signUp(originalDevice)
  const original = await describeAccount(originalDevice)
  await originalDevice.close()

  const recoveredDevice = freshDevice()
  await recoveredDevice.initialize()
  const ceremony = createAccountCeremony()
  await ceremony.beginRestore()
  await ceremony.confirm(shares.slice(0, 2), '')
  expect(recoveredDevice.state.pending?.account.displayName).toBe('')
  expect(recoveredDevice.state.pendingIdentityAddress).toBe(
    original.identityAddress,
  )
  await activate(recoveredDevice)
  expect(await describeAccount(recoveredDevice)).toEqual(original)
  await recoveredDevice.close()

  const reopened = openSession()
  await reopened.initialize()
  expect(reopened.state.account?.displayName).toBe('')
  expect(await describeAccount(reopened)).toEqual(original)
})

test('a backup made from Settings restores the same account on a fresh device', async () => {
  const first = freshDevice()
  await signUp(first)
  const original = await describeAccount(first)
  expect(Object.keys(original.roots)).toHaveLength(5)
  expect(new Set(Object.values(original.roots)).size).toBe(5)
  await first.close()

  // Later, on the same device: Settings > Backup account, from stored custody alone.
  const later = openSession()
  await later.initialize()
  const backup = await later.backupCodex32(2, 3)
  expect(backup).toHaveLength(3)
  await later.close()

  for (const subset of [backup.slice(0, 2), backup.slice(1, 3)]) {
    const device = freshDevice()
    const outcome = await restore(device, subset)
    expect(outcome.address).toBe(original.identityAddress)
    expect(outcome.shownBeforeActivate).toBe(original.identityAddress)
    expect(await describeAccount(device)).toEqual(original)
    await device.close()
  }
})

test('the shares shown at signup still restore the same account', async () => {
  const first = freshDevice()
  const signupShares = await signUp(first, 3, 5)
  const original = await describeAccount(first)
  await first.close()

  const device = freshDevice()
  await restore(device, signupShares.slice(2, 5))
  expect(await describeAccount(device)).toEqual(original)
})

test('two backups of one account each restore it; their shares do not mix, nor with the signup shares', async () => {
  const first = freshDevice()
  const signupShares = await signUp(first)
  const original = await describeAccount(first)
  const backupA = await first.backupCodex32(2, 3)
  const backupB = await first.backupCodex32(3, 5)
  await first.close()

  for (const shares of [backupA.slice(1, 3), backupB.slice(2, 5)]) {
    const device = freshDevice()
    await restore(device, shares)
    expect(await describeAccount(device)).toEqual(original)
    await device.close()
  }

  const sameSize = await (async () => {
    const device = freshDevice()
    await restore(device, backupA.slice(0, 2))
    const again = await device.backupCodex32(2, 3)
    await device.close()
    return again
  })()
  for (const mixed of [
    [backupA[0], sameSize[1]],
    [signupShares[0], backupA[1]],
    [backupA[0], backupB[1]],
  ]) {
    const device = freshDevice()
    await device.initialize()
    const ceremony = createAccountCeremony()
    await ceremony.beginRestore()
    const error = await failure(() => ceremony.confirm(mixed, 'Mixed'))
    expect((error as { code?: string }).code).toBe('inconsistent-share')
    expect(recoveryErrorMessage(error)).toMatch(/different backup sets/)
    expect(recoveryErrorMessage(error)).toMatch(
      /1 distinct shares available; 2 required/,
    )
    // A refused restore leaves the device without an account, staged or active.
    expect(device.state.pending).toBeNull()
    expect(device.state.account).toBeNull()
    expect(device.state.status).toBe('fresh')
    await device.close()
  }
})

test('a restored account can itself issue a backup that restores the original', async () => {
  const first = freshDevice()
  const signupShares = await signUp(first)
  const original = await describeAccount(first)
  await first.close()

  const second = freshDevice()
  await restore(second, signupShares.slice(0, 2))
  const backup = await second.backupCodex32(2, 3)
  await second.close()

  const third = freshDevice()
  await restore(third, backup.slice(0, 2))
  expect(await describeAccount(third)).toEqual(original)
})

test('an account stored before account roots were kept is told the truth and given no shares', async () => {
  const first = freshDevice()
  await signUp(first)
  const original = await describeAccount(first)
  const receipt = first.state.account!.receipt
  await first.close()

  await forgetAccountRoot(receipt, original.roots)

  const later = openSession()
  await later.initialize()
  // The account itself is untouched and usable.
  expect(await describeAccount(later)).toEqual(original)
  const error = await failure(() => later.backupCodex32(2, 3))
  expect(error).toBeInstanceOf(AccountBackupUnavailableError)
  expect(await describeAccount(later)).toEqual(original)
})

test('an unsupported backup policy is refused, not adjusted', async () => {
  const first = freshDevice()
  await signUp(first)
  for (const [threshold, count] of [
    [1, 3],
    [3, 2],
    [2, 32],
    [10, 12],
  ]) {
    const error = await failure(() => first.backupCodex32(threshold, count))
    expect((error as { code?: string }).code).toBe('invalid-threshold')
  }
})

/** A well-formed share with the same header and index but wrong contents. */
function poisoned(share: string): string {
  const data = Array.from(share.slice(3, -15), char =>
    GF32_ALPHABET.indexOf(char),
  )
  try {
    for (let i = 10; i < data.length; i++)
      data[i] = crypto.getRandomValues(new Uint8Array(1))[0]! & 31
    return `fr1${[...data, ...createLongBchChecksum('fr', data)]
      .map(value => GF32_ALPHABET[value])
      .join('')}`
  } finally {
    data.fill(0)
  }
}

test('a 4-of-10 backup restores from six shares when two of them are bad, and names the two', async () => {
  const first = freshDevice()
  await signUp(first)
  const original = await describeAccount(first)
  const shares = (await first.backupCodex32(4, 10)).slice(2, 8)
  await first.close()
  shares[0] = poisoned(shares[0])
  shares[3] = poisoned(shares[3])

  const device = freshDevice()
  const outcome = await restore(device, shares)
  expect(outcome.shownBeforeActivate).toBe(original.identityAddress)
  expect(await describeAccount(device)).toEqual(original)
  expect(
    'report' in outcome && outcome.report?.map(share => share.status),
  ).toEqual([
    'inconsistent',
    'supports',
    'supports',
    'inconsistent',
    'supports',
    'supports',
  ])
})

test('shares holding complete backups of two accounts restore only the one the user picks', async () => {
  const accounts = []
  for (let i = 0; i < 2; i++) {
    const device = freshDevice()
    const shares = await signUp(device)
    accounts.push({ shares, described: await describeAccount(device) })
    await device.close()
  }
  const pile = [
    accounts[0].shares[0],
    accounts[1].shares[0],
    accounts[0].shares[1],
    accounts[1].shares[1],
  ]
  for (const pick of [0, 1]) {
    const device = freshDevice()
    await device.initialize()
    const ceremony = createAccountCeremony()
    await ceremony.beginRestore()
    const outcome = await ceremony.confirm(pile, 'Restored')
    if (!('candidates' in outcome)) throw new Error('expected a choice')
    // Nothing is staged, so nothing can be activated, until the user picks.
    expect(device.state.pending).toBeNull()
    expect(outcome.candidates.map(candidate => candidate.address)).toEqual(
      accounts.map(account => account.described.identityAddress),
    )
    await ceremony.choose(pick, 'Restored')
    expect(device.state.pendingIdentityAddress).toBe(
      accounts[pick].described.identityAddress,
    )
    await device.activatePending(
      device.state.pending!.account.receipt.operationId,
      device.state.pending!.expectedActive,
    )
    expect(await describeAccount(device)).toEqual(accounts[pick].described)
    await device.close()
  }
})

// Both upstream secret producers call the same public writer and bounded recovery API.
test.each([
  [1, 1],
  [2, 3],
  [3, 5],
] as const)(
  'common public recovery path preserves mnemonic seed and random root at %i-of-%i',
  (threshold, shareCount) => {
    const historical = mnemonicToSeedSync(
      'test test test test test test test test test test test junk',
    )
    const root = crypto.getRandomValues(new Uint8Array(32))
    try {
      for (const [format, secret] of [
        ['historical', historical],
        ['root', root],
      ] as const) {
        const shares = exportRecoveryShares({
          format,
          secret,
          threshold,
          shareCount,
          randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
        })
        const recovered = recoverAccountBackupShares(shares.slice(-threshold))
        try {
          expect(recovered.candidates.length).toBe(1)
          const account = recovered.candidates[0]!.account
          const actual = 'seed' in account ? account.seed : account.accountRoot
          expect(
            actual.length === secret.length &&
              actual.every((byte, i) => byte === secret[i]),
          ).toBe(true)
        } finally {
          recovered.candidates.forEach(value =>
            destroyRecoveredBackup(value.account),
          )
        }
      }
    } finally {
      historical.fill(0)
      root.fill(0)
    }
  },
)
