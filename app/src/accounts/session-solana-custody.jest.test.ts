// Load the pinned SDK's real embedded WASM in Jest/CommonJS. Only the unused async
// URL loader needs import.meta removal; initSync and every cryptographic export stay real.
jest.mock('ecash-lib/dist/ffi/ecash_lib_wasm_browser.js', () => {
  const fs = jest.requireActual('node:fs')
  const ts = jest.requireActual('typescript')
  const source = fs
    .readFileSync(
      require.resolve('ecash-lib/dist/ffi/ecash_lib_wasm_browser.js'),
      'utf8',
    )
    .replace('import.meta.url', "'file:///unused-jest-wasm-loader'")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports = {}
  new Function('exports', compiled)(exports)
  return exports
})
jest.mock('ecash-lib/dist/ffi/ecash_lib_wasm_bg_browser.js', () => {
  const fs = jest.requireActual('node:fs')
  const source = fs.readFileSync(
    require.resolve('ecash-lib/dist/ffi/ecash_lib_wasm_bg_browser.js'),
    'utf8',
  )
  return { ECASH_LIB_WASM_BASE64: source.match(/`([\s\S]*?)`/)[1] }
})
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as ts from 'typescript'
import { BIP39_RECOVERY_FORMAT } from '@frank/account-vault'
import { DOMAIN_PURPOSES, DERIVATION_REGISTRY_ID } from '@frank/domain-roots'
import type {
  ExperimentalCustody,
  openExperimentalRecipientCustody,
} from '@frank/wallet/solana-crypto-backend/runtime.mjs'
import { createAccountSession, type RuntimeWallet } from './session'
import type { AccountCustody, PublicAccount, CustodySnapshot } from './custody'

type Opener = typeof openExperimentalRecipientCustody
// Execute the checked-in generator output and WASM, changing only the unused ESM URL
// syntax for Jest. No cryptographic implementation or runtime method is replaced.
function packagedOpener(): Opener {
  const directory = resolve(
    __dirname,
    '../../../packages/wallet/solana-crypto-backend',
  )
  const compile = (source: string) =>
    ts.transpileModule(
      source.replace(/import\.meta\.url/g, "'file:///unused-jest-loader'"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
        },
      },
    ).outputText
  const glue = {} as { initSync(input: { module: Uint8Array }): unknown }
  new Function(
    'exports',
    compile(readFileSync(resolve(directory, 'generated/backend.js'), 'utf8')),
  )(glue)
  glue.initSync({
    module: readFileSync(resolve(directory, 'generated/backend_bg.wasm')),
  })
  const runtime = {} as { openExperimentalRecipientCustody: Opener }
  new Function(
    'exports',
    'require',
    compile(readFileSync(resolve(directory, 'runtime.mjs'), 'utf8')),
  )(runtime, (specifier: string) => {
    if (specifier !== './generated/backend.js')
      throw new Error('Unexpected runtime dependency')
    return glue
  })
  return runtime.openExperimentalRecipientCustody
}
const realOpen = packagedOpener()
const input = {
  chainIdentifier: 'solana-devnet',
  wasm: 'file:///packaged/backend_bg.wasm',
}
function fixture(open: Opener = realOpen, historical = false) {
  const account = {
    displayName: 'Public fixture',
    descriptor: 'public',
    receipt: {
      operationId: 'fixture',
      context: {
        accountId: 'actual-account-id',
        ...(historical ? { recoveryFormat: BIP39_RECOVERY_FORMAT } : {}),
      },
    },
  } as PublicAccount
  const snapshot: CustodySnapshot = {
    schema: 1,
    revision: 1,
    active: account,
    pending: null,
  }
  const borrowed: Uint8Array[] = []
  const capability = {
    account,
    close: jest.fn(),
    takeRoots: () =>
      DOMAIN_PURPOSES.map((purpose, index) => {
        const bytes = new Uint8Array(32).fill(index + 1)
        borrowed.push(bytes)
        return { registry: DERIVATION_REGISTRY_ID, purpose, bytes }
      }),
    takeBip39Seed: () => {
      const seed = Uint8Array.from({ length: 64 }, (_, index) => index + 1)
      borrowed.push(seed)
      return seed
    },
  }
  const custody = {
    snapshot: async () => snapshot,
    reconcile: async () => 'ready',
    openActive: async () => capability,
    close: jest.fn(),
  } as unknown as AccountCustody
  const wallets: RuntimeWallet[] = []
  const createWallet = jest.fn(async () => {
    const wallet = {
      chainIdentifier: 'monad-testnet',
      identity: { compressedPubKey: new Uint8Array(33).fill(2) },
      close: jest.fn(async () => undefined),
    } as unknown as RuntimeWallet
    wallets.push(wallet)
    return wallet
  })
  let invalidate!: () => void
  const opener = jest.fn(open)
  const session = createAccountSession({
    open: async () => custody,
    createWallet,
    openSolanaPaymentCustody: opener,
    listen: callback => {
      invalidate = callback
      return () => undefined
    },
  })
  return {
    session,
    opener,
    borrowed,
    createWallet,
    wallets,
    invalidate: () => invalidate(),
  }
}
const wiped = (buffers: Uint8Array[]) =>
  expect(buffers.every(bytes => bytes.every(byte => byte === 0))).toBe(true)

test.each([false, true])(
  'actual packaged WASM preserves published Solana identity (historical HD=%s), consumes seed and closes with session',
  async historical => {
    let handoff = new Uint8Array()
    let label: Uint8Array | undefined
    const f = fixture(options => {
      handoff = options.seed
      label = new Uint8Array(options.accountId)
      return realOpen(options)
    }, historical)
    await f.session.initialize()
    const primary = await f.session.getWallet()
    const published = await f.session.getCurvePublicKey('ed25519')
    expect(f.opener).not.toHaveBeenCalled()
    const child = await f.session.createSolanaPaymentCustody(input)
    expect(child.primaryPublicKey()).toEqual(published)
    expect(label).toEqual(published)
    expect(await f.session.getWallet()).toBe(primary)
    expect(f.createWallet).toHaveBeenCalledTimes(1)
    wiped([...f.borrowed, handoff])
    const result = child.primaryPublicKey()
    result.fill(0)
    expect(child.primaryPublicKey()).toEqual(published)
    await f.session.close()
    expect(() => child.primaryPublicKey()).toThrow()
    child.close()
  },
)

test('factory requires ready custody and exact supported canonical Solana network', async () => {
  const f = fixture()
  await expect(f.session.createSolanaPaymentCustody(input)).rejects.toThrow()
  expect(f.createWallet).not.toHaveBeenCalled()
  await f.session.initialize()
  for (const chainIdentifier of [
    'devnet',
    'solana',
    'monad-testnet',
    'unknown',
  ])
    await expect(
      f.session.createSolanaPaymentCustody({ ...input, chainIdentifier }),
    ).rejects.toThrow('Unsupported canonical')
  expect(f.opener).not.toHaveBeenCalled()
  await f.session.close()
})

test('aborted custody cannot publish or remain usable; direct close is idempotent', async () => {
  const f = fixture()
  await f.session.initialize()
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(
    f.session.createSolanaPaymentCustody({
      ...input,
      signal: cancelled.signal,
    }),
  ).rejects.toThrow()
  expect(f.opener).not.toHaveBeenCalled()
  const controller = new AbortController()
  const child = await f.session.createSolanaPaymentCustody({
    ...input,
    signal: controller.signal,
  })
  controller.abort()
  expect(() => child.primaryPublicKey()).toThrow()
  expect(() => child.deriveDestination({} as never)).toThrow()
  expect(() => child.validateReceivedDescriptor({} as never)).toThrow()
  expect(() =>
    child.signPrimaryTransfer({} as never, {} as never, {} as never),
  ).toThrow()
  expect(() =>
    child.signReceivedTransfer(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    ),
  ).toThrow()
  child.close()
  await f.session.close()
})

test('same-revision session invalidation revokes published scope and rejects a late owned handle', async () => {
  let resolveLate!: (value: ExperimentalCustody) => void
  let entered!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  let handoff!: Uint8Array
  let late!: ExperimentalCustody
  const f = fixture(options => {
    handoff = options.seed
    // The real opener consumes its copy synchronously, exactly as production does.
    const opening = realOpen(options)
    return opening.then(value => {
      late = value
      entered()
      return new Promise<ExperimentalCustody>(resolve => {
        resolveLate = resolve
      })
    })
  })
  await f.session.initialize()
  const firstPrimary = await f.session.getWallet()
  const pending = f.session.createSolanaPaymentCustody(input)
  const rejected = expect(pending).rejects.toThrow()
  await started
  wiped([...f.borrowed, handoff])
  f.invalidate()
  await f.session.initialize()
  expect(await f.session.getWallet()).not.toBe(firstPrimary)
  resolveLate(late)
  await rejected
  expect(() => late.primaryPublicKey()).toThrow()
  await f.session.close()
})

test('published scopes are revoked synchronously on same-revision owner replacement', async () => {
  const f = fixture()
  await f.session.initialize()
  const scope = await f.session.createSolanaPaymentCustody(input)
  f.invalidate()
  expect(() => scope.primaryPublicKey()).toThrow()
  await f.session.initialize()
  const replacement = await f.session.createSolanaPaymentCustody(input)
  expect(replacement.primaryPublicKey()).toHaveLength(32)
  await f.session.close()
  expect(() => replacement.primaryPublicKey()).toThrow()
})

test('mismatching backend identity is closed and seed copies are wiped', async () => {
  const close = jest.fn()
  let handoff!: Uint8Array
  const f = fixture(async options => {
    handoff = options.seed
    return {
      primaryPublicKey: () => new Uint8Array(32),
      close,
    } as ExperimentalCustody
  })
  await f.session.initialize()
  await expect(f.session.createSolanaPaymentCustody(input)).rejects.toThrow()
  expect(close).toHaveBeenCalledTimes(1)
  wiped([...f.borrowed, handoff])
  await f.session.close()
})

test('synchronous opener failure wipes the private handoff and borrowed material', async () => {
  let handoff!: Uint8Array
  const f = fixture(options => {
    handoff = options.seed
    throw new Error('WASM unavailable')
  })
  await f.session.initialize()
  await expect(f.session.createSolanaPaymentCustody(input)).rejects.toThrow(
    'WASM unavailable',
  )
  wiped([...f.borrowed, handoff])
  await f.session.close()
})

// A backend may finish initialization after cancellation; its result still belongs to
// the cancelled operation and must be freed instead of being published.
test('abort while WASM opening is pending closes the late handle and wipes immediately', async () => {
  let finish!: (value: ExperimentalCustody) => void
  let entered!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  let late!: ExperimentalCustody
  let handoff = new Uint8Array()
  const f = fixture(options => {
    handoff = options.seed
    return realOpen(options).then(candidate => {
      late = candidate
      entered()
      return new Promise<ExperimentalCustody>(resolve => {
        finish = resolve
      })
    })
  })
  await f.session.initialize()
  const controller = new AbortController()
  const pending = f.session.createSolanaPaymentCustody({
    ...input,
    signal: controller.signal,
  })
  const rejected = expect(pending).rejects.toThrow()
  await started
  wiped([...f.borrowed, handoff])
  controller.abort()
  finish(late)
  await rejected
  expect(() => late.primaryPublicKey()).toThrow()
  await f.session.close()
})

test.each([
  'success',
  'open failure',
  'abort after derivation',
  'derivation failure',
] as const)(
  'historical factory avoids SDK keypairs and wipes owned leaf/master nodes: %s',
  async mode => {
    const controller = new AbortController()
    const f = fixture(
      mode === 'open failure'
        ? () => {
            throw new Error('opening fault')
          }
        : realOpen,
      true,
    )
    await f.session.initialize()
    // Exclude the existing published-key lookup from this new private factory's ownership.
    const published = await f.session.getCurvePublicKey('ed25519')
    const { SolanaHdKeyring } = await import('@frank/wallet/ed25519-hd-keyring')
    const fromSeed = SolanaHdKeyring.fromSeed
    const deriveNode = SolanaHdKeyring.prototype.deriveNode
    const masters: import('@frank/wallet/ed25519-hd-keyring').Ed25519Node[] = []
    const leaves: import('@frank/wallet/ed25519-hd-keyring').Ed25519Node[] = []
    const masterSpy = jest
      .spyOn(SolanaHdKeyring, 'fromSeed')
      .mockImplementation(seed => {
        const keyring = fromSeed(seed)
        masters.push(keyring.masterNode)
        return keyring
      })
    const leafSpy = jest
      .spyOn(SolanaHdKeyring.prototype, 'deriveNode')
      .mockImplementation(function (path) {
        if (mode === 'derivation failure') throw new Error('derivation fault')
        const result = deriveNode.call(this, path)
        leaves.push(result.node)
        if (mode === 'abort after derivation') controller.abort()
        return result
      })
    const accountSpy = jest.spyOn(SolanaHdKeyring.prototype, 'deriveSubAccount')
    try {
      const opening = f.session.createSolanaPaymentCustody({
        ...input,
        signal: controller.signal,
      })
      if (mode === 'success') {
        const scope = await opening
        expect(scope.primaryPublicKey()).toEqual(published)
        scope.close()
      } else await expect(opening).rejects.toThrow()
      expect(accountSpy).not.toHaveBeenCalled()
      expect(masters).toHaveLength(1)
      expect(leaves).toHaveLength(mode === 'derivation failure' ? 0 : 1)
      wiped([...masters, ...leaves].flatMap(node => [node.key, node.chainCode]))
      wiped(f.borrowed)
    } finally {
      accountSpy.mockRestore()
      leafSpy.mockRestore()
      masterSpy.mockRestore()
      await f.session.close()
    }
  },
)
