import {
  inspectRetainedCanonicalRecovery,
  type CanonicalRecoveryCustody,
} from './storage/stamp-attempt-journal'
import { canonicalStampDestination } from '@frank/cashweb/relay/canonical-dm-stamp'
import {
  bytesToBigint,
  privateKeyFromSecretBytes,
  signEcdsa,
} from '@frank/nakamoto'
import type {
  PublicRevisionZeroInput,
  PublicRevisionZeroExport,
  PublicRevisionZeroProcess,
} from './monad-wallet-handle'
import {
  Wallet,
  sha256,
  hexlify,
  toUtf8Bytes,
  computeAddress,
  SigningKey,
  getBytes,
  concat,
} from 'ethers'
import { DERIVATION_REGISTRY_ID } from '../domain-roots/src'
import type { DomainRoot, DomainPurpose } from '../domain-roots/src'
import type { HDSeed } from './chain/active-chain'
import { MonadIdentity, MONAD_IDENTITY_DERIVATION_PATH } from './monad-identity'
import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadChangeKeyring } from './monad-change-keyring'
import { monadMasterFromDomainRoot } from './monad-domain-root'
import { deriveRoleLeaves, matchLocalRolePoints } from '../role-keys/src'
import type { RolePoint } from '../role-keys/src'
import type { Current } from '../directory-admission/src'
import {
  decodeCanonical,
  verifyPreviewDirectoryEvidence,
  cborMap,
  encodeFrame,
  directorySignatureDigest,
} from '@frank/codec'
import { seal, open, SUITE_AUTH_XCHACHA } from '@frank/crypto-box'
import type { SuiteResult } from '@frank/crypto-box'

/** Owned, scoped operations: no secret arrays or general-purpose borrow escape. */
export interface MonadCanonicalRoles {
  readonly auth: RolePoint<'auth'>
  readonly message: RolePoint<'message'>
  readonly stamp: RolePoint<'stamp'>
  readonly previousStamp?: RolePoint<'stamp'>
  sealMessage(input: {
    recipientPublicKey: Uint8Array
    plaintext: Uint8Array
    context: Uint8Array
  }): SuiteResult<Uint8Array>
  openMessage(input: {
    envelope: Uint8Array
    senderPublicKey: Uint8Array
    context: Uint8Array
  }): SuiteResult<Uint8Array>
  dispose(): void
}

/** Caller must obtain Current from fresh admission; this owner never grants that authority. */
export interface MonadCanonicalRoleOwner {
  create(network: string, current: Current): MonadCanonicalRoles
  verifyRetainedRecoveryCustody(proof: CanonicalRecoveryCustody): void
  prepareRevisionZero(input: PublicRevisionZeroInput): PublicRevisionZeroExport
  publicGenerationZeroPoints(): {
    auth: Uint8Array
    message: Uint8Array
    stamp: Uint8Array
  }
  dispose(): void
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

function roleOwner(
  evm: DomainRoot<'evm-wallet'>,
  authentication: DomainRoot<'identity-authentication'>,
  messaging: DomainRoot<'messaging-encryption'>,
  identityPoint: Uint8Array,
): MonadCanonicalRoleOwner {
  const authRoot = snapshot(authentication, 'identity-authentication')
  const messageRoot = snapshot(messaging, 'messaging-encryption')
  const stampRoot = snapshot(evm, 'evm-wallet')
  const ownedIdentity = new Uint8Array(identityPoint)
  const sessions = new Set<MonadCanonicalRoles>()
  let disposed = false
  return Object.freeze({
    verifyRetainedRecoveryCustody(proof: CanonicalRecoveryCustody): void {
      if (disposed) throw new Error('canonical-roles:disposed')
      const recovery = inspectRetainedCanonicalRecovery(proof)
      const leaves = deriveRoleLeaves({
        authRoot,
        messageRoot,
        stampRoot,
        messageGeneration: 0n,
        stampGeneration: BigInt(recovery.stampGeneration),
      })
      try {
        if (
          !sameBytes(leaves.auth.public.compressedPoint, ownedIdentity) ||
          !sameBytes(
            leaves.stamp.public.compressedPoint,
            getBytes('0x' + recovery.stampKeyHex),
          )
        )
          throw new Error('canonical-roles:retained-custody-mismatch')
        for (const account of recovery.accounts) {
          const domain = 'frank/stamp-child/v1',
            network = recovery.request.identity.network
          const prefix = Uint8Array.from([
            0,
            domain.length,
            ...Array.from(domain, c => c.charCodeAt(0)),
            0,
            network.length,
            ...Array.from(network, c => c.charCodeAt(0)),
          ])
          const index = account.childIndex,
            sharedPoint = getBytes('0x' + recovery.sharedPointHex)
          const tweak = bytesToBigint(
            getBytes(
              sha256(
                concat([
                  prefix,
                  sharedPoint,
                  Uint8Array.of(index >>> 24, index >>> 16, index >>> 8, index),
                ]),
              ),
            ),
          )
          const order =
            0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
          if (tweak <= 0n || tweak >= order)
            throw new Error('canonical-roles:retained-tweak')
          const expected = canonicalStampDestination({
            network,
            stampKey: {
              keyType: 1,
              keyBytes: leaves.stamp.public.compressedPoint,
            },
            sharedPoint,
            childIndex: index,
          })
          leaves.stamp.useSecret(secret => {
            const child = getBytes(
              '0x' +
                ((bytesToBigint(secret) * tweak) % order)
                  .toString(16)
                  .padStart(64, '0'),
            )
            try {
              if (
                computeAddress(hexlify(child)).toLowerCase() !==
                  account.address ||
                !sameBytes(
                  getBytes(SigningKey.computePublicKey(hexlify(child), true)),
                  expected.publicKey,
                )
              )
                throw new Error('canonical-roles:retained-child-mismatch')
            } finally {
              child.fill(0)
            }
          })
        }
      } finally {
        leaves.dispose()
      }
    },
    prepareRevisionZero(
      input: PublicRevisionZeroInput,
    ): PublicRevisionZeroExport {
      if (disposed) throw new Error('canonical-roles:disposed')
      const owned = copyRevisionZeroInput(input)
      const leaves = deriveRoleLeaves({
        authRoot,
        messageRoot,
        stampRoot,
        messageGeneration: 0n,
        stampGeneration: 0n,
      })
      try {
        const auth = leaves.auth.public,
          message = leaves.message.public,
          stamp = leaves.stamp.public
        if (!sameBytes(auth.compressedPoint, ownedIdentity))
          throw new Error('canonical-roles:identity-mismatch')
        const account = (key: Uint8Array) =>
          cborMap([
            [0, 1],
            [1, key],
          ])
        const time = (t: { seconds: bigint; nanoseconds: number }) =>
          cborMap([
            [0, t.seconds],
            [1, t.nanoseconds],
          ])
        const tuple = (
          owned.subjectBinding === 'A' ? owned.relayA : owned.relayB
        ).tuple
        const statement = encodeFrame(
          { typeId: 4, schemaVersion: 4, minReaderVersion: 4 },
          cborMap([
            [0, owned.network],
            [1, account(auth.compressedPoint)],
            [2, 0],
            [3, time(owned.issuedAt)],
            [
              4,
              [
                cborMap([
                  [0, tuple.relayId],
                  [1, tuple.endpoint],
                  [2, account(tuple.identity.keyBytes)],
                  [3, time(tuple.expiry)],
                ]),
              ],
            ],
            [6, time(owned.expiresAt)],
            [8, account(stamp.compressedPoint)],
            [10, account(message.compressedPoint)],
            [11, 0],
            [12, 0],
            [13, null],
          ]),
        )
        const digest = directorySignatureDigest(owned.network, statement)
        const signature = leaves.auth.useSecret(secret => {
          const key = privateKeyFromSecretBytes(secret, true)
          if (!key.ok) throw new Error('canonical-rev0:auth-key')
          try {
            const signed = signEcdsa(key.value, digest)
            if (!signed.ok) throw new Error('canonical-rev0:signature')
            return new Uint8Array(signed.value)
          } finally {
            key.value.bytes.fill(0)
          }
        })
        const attestation = encodeFrame(
          { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
          cborMap([
            [0, statement],
            [
              1,
              [
                cborMap([
                  [0, 1],
                  [1, account(auth.compressedPoint)],
                  [2, signature],
                ]),
              ],
            ],
          ]),
        )
        const evidence = verifyPreviewDirectoryEvidence(
          attestation,
          owned.network,
        )
        if (
          !sameBytes(evidence.statementFrame.frame, statement) ||
          evidence.statement.revision !== 0n ||
          !sameBytes(
            evidence.statement.subject.keyBytes,
            auth.compressedPoint,
          ) ||
          !sameBytes(
            evidence.statement.stampKey.keyBytes,
            stamp.compressedPoint,
          ) ||
          !sameBytes(
            evidence.statement.preview.messageDhKey.keyBytes,
            message.compressedPoint,
          )
        )
          throw new Error('canonical-rev0:evidence-mismatch')
        return Object.freeze({
          kind: 'public-revision-zero-preparation' as const,
          registry: DERIVATION_REGISTRY_ID,
          networkTag: owned.networkTag,
          network: owned.network,
          chainId: owned.chainId,
          authAddress: computeAddress(
            hexlify(auth.compressedPoint),
          ).toLowerCase(),
          auth,
          message,
          stamp,
          get statement() {
            return new Uint8Array(statement)
          },
          get attestation() {
            return new Uint8Array(attestation)
          },
          get t1() {
            return new Uint8Array(evidence.statementHash)
          },
          get configuration() {
            return copyRevisionZeroInput(owned)
          },
        })
      } finally {
        leaves.dispose()
      }
    },
    publicGenerationZeroPoints() {
      if (disposed) throw new Error('canonical-roles:disposed')
      const leaves = deriveRoleLeaves({
        authRoot,
        messageRoot,
        stampRoot,
        messageGeneration: 0n,
        stampGeneration: 0n,
      })
      try {
        return {
          auth: leaves.auth.public.compressedPoint,
          message: leaves.message.public.compressedPoint,
          stamp: leaves.stamp.public.compressedPoint,
        }
      } finally {
        leaves.auth.dispose()
        leaves.message.dispose()
        leaves.stamp.dispose()
      }
    },
    create(network: string, current: Current): MonadCanonicalRoles {
      if (disposed) throw new Error('canonical-roles:disposed')
      if (current.kind !== 'current')
        throw new Error('canonical-roles:current-required')
      const evidence = verifyPreviewDirectoryEvidence(
        current.evidence.attestation,
        network,
      )
      const statement = evidence.statement
      const roles = statement.preview
      if (
        current.status.forked ||
        !sameBytes(evidence.statementFrame.frame, current.evidence.statement) ||
        !sameBytes(evidence.statementHash, current.evidence.hash) ||
        !sameBytes(statement.subject.keyBytes, ownedIdentity) ||
        statement.subject.keyType !== 1 ||
        current.messageKey.keyType !== 1 ||
        current.stampKey.keyType !== 1 ||
        !sameBytes(roles.messageDhKey.keyBytes, current.messageKey.keyBytes) ||
        !sameBytes(statement.stampKey.keyBytes, current.stampKey.keyBytes) ||
        roles.mailboxKeyGeneration !== current.generations[0] ||
        roles.stampKeyGeneration !== current.generations[1] ||
        statement.revision !== current.revision ||
        (current.previousStamp !== null && current.previousStamp.keyType !== 1)
      )
        throw new Error('canonical-roles:directory-mismatch')
      const derivation = {
        authRoot,
        messageRoot,
        stampRoot,
        messageGeneration: current.generations[0],
        stampGeneration: current.generations[1],
        ...(current.previousStamp === null
          ? {}
          : {
              previousStampGeneration: current.generations[1] - 1n,
            }),
      }
      if (
        !matchLocalRolePoints(derivation, {
          auth: ownedIdentity,
          message: current.messageKey.keyBytes,
          stamp: current.stampKey.keyBytes,
          ...(current.previousStamp === null
            ? {}
            : {
                previousStamp: current.previousStamp.keyBytes,
              }),
        }).matches
      )
        throw new Error('canonical-roles:local-mismatch')
      const leaves = deriveRoleLeaves(derivation)
      let closed = false
      const session: MonadCanonicalRoles = Object.freeze({
        auth: leaves.auth.public,
        message: leaves.message.public,
        stamp: leaves.stamp.public,
        ...(leaves.previousStamp
          ? { previousStamp: leaves.previousStamp.public }
          : {}),
        sealMessage(input: Parameters<MonadCanonicalRoles['sealMessage']>[0]) {
          if (closed) throw new Error('canonical-roles:disposed')
          const recipientPublicKey = new Uint8Array(input.recipientPublicKey)
          const plaintext = new Uint8Array(input.plaintext)
          const context = new Uint8Array(input.context)
          return leaves.message.useSecret(secret =>
            seal({
              suiteId: SUITE_AUTH_XCHACHA,
              senderPublicKey: leaves.message.public.compressedPoint,
              senderPrivateKey: secret,
              recipientPublicKey,
              plaintext,
              context,
            }),
          )
        },
        openMessage(input: Parameters<MonadCanonicalRoles['openMessage']>[0]) {
          if (closed) throw new Error('canonical-roles:disposed')
          const ownedEnvelope = new Uint8Array(input.envelope)
          const senderPublicKey = new Uint8Array(input.senderPublicKey)
          const context = new Uint8Array(input.context)
          // This capability is suite1-only even though crypto-box has private legacy readers.
          try {
            const envelope = decodeCanonical(ownedEnvelope)
            if (
              !(envelope instanceof Map) ||
              envelope.get(0n) !== 2n ||
              envelope.get(1n) !== 1n
            )
              return {
                ok: false as const,
                error: { code: 'envelope' as const },
              }
          } catch {
            return { ok: false as const, error: { code: 'envelope' as const } }
          }
          return leaves.message.useSecret(secret =>
            open({
              envelope: ownedEnvelope,
              recipientPrivateKey: secret,
              senderPublicKey,
              context,
            }),
          )
        },
        dispose() {
          closed = true
          leaves.dispose()
          sessions.delete(session)
        },
      })
      sessions.add(session)
      return session
    },
    dispose() {
      disposed = true
      for (const session of sessions) session.dispose()
      for (const root of [authRoot, messageRoot, stampRoot]) root.bytes.fill(0)
    },
  })
}

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
  /** Typed roots only. Legacy mnemonic material cannot authorize canonical messaging. */
  readonly canonicalRoles?: MonadCanonicalRoleOwner
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
  let canonicalRoles: MonadCanonicalRoleOwner | undefined
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
    const identity = MonadIdentity.fromDomainRoot(authentication)
    canonicalRoles = roleOwner(
      evm,
      authentication,
      messaging,
      identity.compressedPubKey,
    )
    const material: MonadWalletMaterial = {
      identity,
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
      canonicalRoles,
      dispose() {
        messaging.bytes.fill(0)
        canonicalRoles?.dispose()
      },
    }
    owned.pop() // material owns messaging until close; EVM/auth roots are no longer needed.
    return material
  } catch (error) {
    canonicalRoles?.dispose()
    throw error
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

/** Ordinary public storage identity, never custody or admitted directory authority. */
export function canonicalWalletPublicBinding(
  material: MonadWalletMaterial,
  network: string,
  chainId: bigint,
): { tuple: string; id: string } {
  if (
    !material.canonicalRoles ||
    !(
      (network === 'monad-testnet' && chainId === 10143n) ||
      (network === 'monad-mainnet' && chainId === 143n)
    )
  )
    throw new Error('canonical-wallet:typed-network-required')
  const points = material.canonicalRoles.publicGenerationZeroPoints()
  const branch = (b: {
    path: string
    publicKey: Uint8Array
    chainCode: Uint8Array
  }) => ({
    path: b.path,
    publicKey: hexlify(b.publicKey),
    chainCode: hexlify(b.chainCode),
  })
  const tuple = JSON.stringify({
    version: 1,
    domain: 'frank-canonical-wallet-binding-v1',
    network,
    chainId: chainId.toString(),
    auth: hexlify(points.auth),
    message: hexlify(points.message),
    stamp: hexlify(points.stamp),
    main: material.mainAccount.address.toLowerCase(),
    registry: DERIVATION_REGISTRY_ID,
    accounts: branch(material.keyring.publicBranchDescriptor()),
    change: branch(material.changeKeyring.publicBranchDescriptor()),
  })
  return Object.freeze({ tuple, id: sha256(toUtf8Bytes(tuple)).slice(2) })
}

function revisionZeroObject(value: unknown, keys: readonly string[]): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some(k => !keys.includes(k))
  )
    throw new Error('canonical-rev0:shape')
}
function revisionZeroTime(input: { seconds: bigint; nanoseconds: number }): {
  seconds: bigint
  nanoseconds: number
} {
  revisionZeroObject(input, ['seconds', 'nanoseconds'])
  if (
    typeof input.seconds !== 'bigint' ||
    input.seconds < 0n ||
    input.seconds > (1n << 64n) - 1n ||
    !Number.isInteger(input.nanoseconds) ||
    input.nanoseconds < 0 ||
    input.nanoseconds >= 1000000000
  )
    throw new Error('canonical-rev0:timestamp')
  return Object.freeze({
    seconds: input.seconds,
    nanoseconds: input.nanoseconds,
  })
}
function revisionZeroNanos(input: {
  seconds: bigint
  nanoseconds: number
}): bigint {
  return input.seconds * 1000000000n + BigInt(input.nanoseconds)
}
function copyRevisionZeroInput(
  input: PublicRevisionZeroInput,
): PublicRevisionZeroInput {
  revisionZeroObject(input, [
    'networkTag',
    'network',
    'chainId',
    'issuedAt',
    'expiresAt',
    'now',
    'relayA',
    'relayB',
    'subjectBinding',
  ])
  if (
    !(
      (input.networkTag === 'MONT' &&
        input.network === 'monad-testnet' &&
        input.chainId === 10143n) ||
      (input.networkTag === 'MON1' &&
        input.network === 'monad-mainnet' &&
        input.chainId === 143n)
    ) ||
    (input.subjectBinding !== 'A' && input.subjectBinding !== 'B')
  )
    throw new Error('canonical-rev0:network')
  const issuedAt = revisionZeroTime(input.issuedAt),
    expiresAt = revisionZeroTime(input.expiresAt),
    now = revisionZeroTime(input.now)
  const start = revisionZeroNanos(issuedAt),
    end = revisionZeroNanos(expiresAt),
    current = revisionZeroNanos(now)
  if (
    end <= start ||
    end - start > 3600000000000n ||
    current < start ||
    current >= end
  )
    throw new Error('canonical-rev0:validity')
  const process = (p: PublicRevisionZeroProcess): PublicRevisionZeroProcess => {
    revisionZeroObject(p, ['processId', 'origin', 'tuple'])
    if (
      typeof p.processId !== 'string' ||
      !/^[a-zA-Z0-9._-]{1,128}$/.test(p.processId) ||
      typeof p.origin !== 'string' ||
      p.origin.length > 2048
    )
      throw new Error('canonical-rev0:process')
    const origin = new URL(p.origin)
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== p.origin ||
      origin.username ||
      origin.password
    )
      throw new Error('canonical-rev0:origin')
    revisionZeroObject(p.tuple, [
      'relayId',
      'endpoint',
      'identity',
      'expiry',
      'unknownFields',
    ])
    revisionZeroObject(p.tuple.identity, ['keyType', 'keyBytes'])
    const tuple = p.tuple
    if (
      !(tuple.relayId instanceof Uint8Array) ||
      tuple.relayId.length < 16 ||
      tuple.relayId.length > 64 ||
      typeof tuple.endpoint !== 'string' ||
      tuple.endpoint.length < 1 ||
      tuple.endpoint.length > 2048 ||
      tuple.identity.keyType !== 1 ||
      !(tuple.identity.keyBytes instanceof Uint8Array) ||
      tuple.identity.keyBytes.length !== 33 ||
      !(tuple.unknownFields instanceof Map) ||
      tuple.unknownFields.size !== 0
    )
      throw new Error('canonical-rev0:tuple')
    const endpoint = new URL(tuple.endpoint)
    if (
      endpoint.origin !== p.origin ||
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash
    )
      throw new Error('canonical-rev0:endpoint')
    if (
      hexlify(tuple.identity.keyBytes) !==
      SigningKey.computePublicKey(tuple.identity.keyBytes, true)
    )
      throw new Error('canonical-rev0:tuple-point')
    const expiry = revisionZeroTime(tuple.expiry)
    if (revisionZeroNanos(expiry) < end)
      throw new Error('canonical-rev0:tuple-expiry')
    return Object.freeze({
      processId: p.processId,
      origin: p.origin,
      tuple: {
        relayId: new Uint8Array(tuple.relayId),
        endpoint: tuple.endpoint,
        identity: {
          keyType: 1,
          keyBytes: new Uint8Array(tuple.identity.keyBytes),
        },
        expiry,
        unknownFields: new Map(),
      },
    })
  }
  return Object.freeze({
    networkTag: input.networkTag,
    network: input.network,
    chainId: input.chainId,
    issuedAt,
    expiresAt,
    now,
    relayA: process(input.relayA),
    relayB: process(input.relayB),
    subjectBinding: input.subjectBinding,
  })
}
