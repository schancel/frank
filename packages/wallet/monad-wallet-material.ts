import { Wallet, sha256 } from 'ethers'
import { DERIVATION_REGISTRY_ID } from '../domain-roots/src'
import type { DomainRoot, DomainPurpose } from '../domain-roots/src'
import type { HDSeed } from './chain/active-chain'
import { MonadIdentity, MONAD_IDENTITY_DERIVATION_PATH } from './monad-identity'
import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadChangeKeyring } from './monad-change-keyring'
import { monadMasterFromDomainRoot } from './monad-domain-root'

/** Frozen registry outputs. Messaging child derivation is reserved for #696. */
export interface MonadRootBundle {
  readonly evm: DomainRoot<'evm-wallet'>
  readonly authentication: DomainRoot<'identity-authentication'>
  readonly messaging: DomainRoot<'messaging-encryption'>
}

export interface MonadWalletMaterial {
  readonly identity: MonadIdentity
  readonly mainAccount: Wallet
  readonly keyring: MonadHdKeyring
  readonly changeKeyring: MonadChangeKeyring
  readonly fingerprint: string
  /** Owned copy only; never used for legacy identity-based encryption. */
  readonly messagingRoot?: Uint8Array
  dispose(): void
}

function snapshot<P extends DomainPurpose>(
  root: DomainRoot<P>,
  purpose: P,
): DomainRoot<P> {
  if (
    !root ||
    root.registry !== DERIVATION_REGISTRY_ID ||
    root.purpose !== purpose ||
    !(root.bytes instanceof Uint8Array) ||
    root.bytes.length !== 32
  ) {
    throw new Error(
      `Expected a frank-domain-roots-v1 ${purpose} root of exactly 32 bytes`,
    )
  }
  return {
    registry: DERIVATION_REGISTRY_ID,
    purpose,
    bytes: Uint8Array.from(root.bytes),
  }
}

/** Synchronous validation and snapshotting must finish before any storage or RPC effect. */
export function createMonadWalletMaterial(
  input: HDSeed | MonadRootBundle,
): MonadWalletMaterial {
  if (!input || typeof input !== 'object')
    throw new Error('Expected Monad wallet roots')
  if ('mnemonic' in input) {
    if (
      'evm' in input ||
      'authentication' in input ||
      'messaging' in input ||
      'registry' in input ||
      'bytes' in input ||
      'purpose' in input
    ) {
      throw new Error('Cannot mix Monad domain roots and legacy mnemonic input')
    }
    return legacyMnemonicWalletMaterial(input)
  }
  if ('passphrase' in input)
    throw new Error('Cannot mix Monad domain roots and legacy mnemonic input')
  const owned: Uint8Array[] = []
  try {
    const evm = snapshot(input.evm, 'evm-wallet')
    owned.push(evm.bytes)
    const authentication = snapshot(
      input.authentication,
      'identity-authentication',
    )
    owned.push(authentication.bytes)
    const messaging = snapshot(input.messaging, 'messaging-encryption')
    owned.push(messaging.bytes)
    if (
      owned.some((bytes, index) =>
        owned
          .slice(index + 1)
          .some(other => bytes.every((byte, offset) => byte === other[offset])),
      )
    ) {
      throw new Error('Monad domain roots must be distinct for each purpose')
    }
    const combined = new Uint8Array(96)
    combined.set(evm.bytes)
    combined.set(authentication.bytes, 32)
    combined.set(messaging.bytes, 64)
    let fingerprint: string
    try {
      fingerprint = sha256(combined)
    } finally {
      combined.fill(0)
    }
    const material: MonadWalletMaterial = {
      identity: MonadIdentity.fromDomainRoot(authentication),
      // Existing native main-account path, now solely below the EVM spending root.
      mainAccount: new Wallet(
        monadMasterFromDomainRoot(evm, 'evm-wallet').derivePath(
          MONAD_IDENTITY_DERIVATION_PATH,
        ).privateKey,
      ),
      keyring: MonadHdKeyring.fromDomainRoot(evm),
      changeKeyring: MonadChangeKeyring.fromDomainRoot(evm),
      fingerprint,
      messagingRoot: messaging.bytes,
      dispose() {
        messaging.bytes.fill(0)
      },
    }
    owned.pop() // material owns messaging until close; EVM/auth roots are no longer needed.
    return material
  } finally {
    for (const bytes of owned) bytes.fill(0)
  }
}

/** @deprecated Compatibility adapter only. #699 switches callers and removes this leaf. */
function legacyMnemonicWalletMaterial(seed: HDSeed): MonadWalletMaterial {
  const identity = MonadIdentity.fromSeed(seed)
  return {
    identity,
    mainAccount: new Wallet(identity.toPrivateKeyHex()),
    keyring: MonadHdKeyring.fromMnemonic(seed.mnemonic, seed.passphrase),
    changeKeyring: MonadChangeKeyring.fromMnemonic(
      seed.mnemonic,
      seed.passphrase,
    ),
    fingerprint: 'legacy',
    dispose() {},
  }
}
