import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto'
import {
  decryptKeystoreJson,
  encryptKeystoreJson,
  getAddress,
  Wallet,
} from 'ethers'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

import { MonadIdentity } from '@frank/wallet/monad-identity'
import { openMonadWalletBundle } from '@frank/wallet/storage/monad-wallet-bundle'
import { LevelStampAttemptJournal } from '@frank/wallet/storage/stamp-attempt-journal'
import { LevelStampPaymentJournal } from '@frank/wallet/storage/stamp-payment-journal'

export interface SignetConfig {
  rpcUrl: string
  relayUrl: string
  networkTag: string
  chainId: number
  stampBurnAddress: string
  activeIdentity?: string
}

export interface EncryptedIdentityStore {
  version: 1
  address: string
  encryptionPublicKey: string
  keystore: Record<string, unknown>
  mnemonic: {
    cipher: 'plaintext' | 'aes-256-gcm'
    ciphertext: string
    iv?: string
    tag?: string
    salt?: string
  }
  createdAt: string
}

export function resolveDataDir(overrideDir?: string): string {
  if (overrideDir && overrideDir.trim().length > 0) {
    return resolve(overrideDir.trim())
  }
  if (process.env.SIGNET_HOME && process.env.SIGNET_HOME.trim().length > 0) {
    return resolve(process.env.SIGNET_HOME.trim())
  }
  if (
    process.env.SIGNET_DATA_DIR &&
    process.env.SIGNET_DATA_DIR.trim().length > 0
  ) {
    return resolve(process.env.SIGNET_DATA_DIR.trim())
  }
  if (
    process.env.MONAD_WALLET_STORAGE_LOCATION &&
    process.env.MONAD_WALLET_STORAGE_LOCATION.trim().length > 0
  ) {
    return resolve(process.env.MONAD_WALLET_STORAGE_LOCATION.trim())
  }
  return join(homedir(), '.signet')
}

export function ensureStorageLayout(dataDir: string): {
  dataDir: string
  configPath: string
  identitiesDir: string
  walletsDir: string
} {
  const identitiesDir = join(dataDir, 'identities')
  const walletsDir = join(dataDir, 'wallets')
  const configPath = join(dataDir, 'config.json')

  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  mkdirSync(identitiesDir, { recursive: true, mode: 0o700 })
  mkdirSync(walletsDir, { recursive: true, mode: 0o700 })

  return {
    dataDir,
    configPath,
    identitiesDir,
    walletsDir,
  }
}

export function getDefaultConfig(): SignetConfig {
  return {
    rpcUrl:
      process.env.MONAD_TESTNET_HTTP_RPC_URL ??
      process.env.MONAD_RPC_URL ??
      'https://testnet-rpc.monad.xyz',
    relayUrl:
      process.env.MONAD_RELAY_BASE_URL ??
      process.env.E2E_DEMO_RELAY_URL ??
      'http://localhost:8080',
    networkTag: process.env.FRANK_NETWORK_TAG ?? 'MONT',
    chainId: 10143,
    stampBurnAddress:
      process.env.MONAD_STAMP_BURN_ADDRESS ??
      '0x000000000000000000000000000000000000dEaD',
    activeIdentity: undefined,
  }
}

export function loadConfig(dataDir: string): SignetConfig {
  const { configPath } = ensureStorageLayout(dataDir)
  const defaults = getDefaultConfig()
  if (!existsSync(configPath)) {
    return defaults
  }
  try {
    const raw = JSON.parse(
      readFileSync(configPath, 'utf8'),
    ) as Partial<SignetConfig>
    return {
      rpcUrl: raw.rpcUrl ?? defaults.rpcUrl,
      relayUrl: raw.relayUrl ?? defaults.relayUrl,
      networkTag: raw.networkTag ?? defaults.networkTag,
      chainId: typeof raw.chainId === 'number' ? raw.chainId : defaults.chainId,
      stampBurnAddress: raw.stampBurnAddress ?? defaults.stampBurnAddress,
      activeIdentity: raw.activeIdentity ?? defaults.activeIdentity,
    }
  } catch {
    return defaults
  }
}

export function saveConfig(dataDir: string, config: SignetConfig): void {
  const { configPath } = ensureStorageLayout(dataDir)
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  })
}

function encryptMnemonic(
  mnemonic: string,
  password?: string,
): EncryptedIdentityStore['mnemonic'] {
  if (!password || password.length === 0) {
    return {
      cipher: 'plaintext',
      ciphertext: mnemonic,
    }
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(password, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(mnemonic, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  return {
    cipher: 'aes-256-gcm',
    ciphertext: ciphertext.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    salt: salt.toString('hex'),
  }
}

function decryptMnemonic(
  stored: EncryptedIdentityStore['mnemonic'],
  password?: string,
): string {
  if (stored.cipher === 'plaintext') {
    return stored.ciphertext
  }
  if (stored.cipher === 'aes-256-gcm') {
    if (!password) {
      throw new Error('Password required to decrypt stored mnemonic')
    }
    if (!stored.salt || !stored.iv || !stored.tag) {
      throw new Error('Corrupted encrypted mnemonic payload')
    }
    const salt = Buffer.from(stored.salt, 'hex')
    const iv = Buffer.from(stored.iv, 'hex')
    const tag = Buffer.from(stored.tag, 'hex')
    const ciphertext = Buffer.from(stored.ciphertext, 'hex')
    const key = scryptSync(password, salt, 32)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ])
    return decrypted.toString('utf8')
  }
  throw new Error(`Unsupported mnemonic cipher format: ${stored.cipher}`)
}

export async function saveIdentity(
  dataDir: string,
  params: {
    identity: MonadIdentity
    mnemonic: string
    password?: string
  },
): Promise<string> {
  const { identitiesDir, walletsDir } = ensureStorageLayout(dataDir)
  const address = getAddress(params.identity.displayAddress)
  const filePath = join(identitiesDir, `${address.toLowerCase()}.json`)

  const wallet = new Wallet(params.identity.toPrivateKeyHex())
  const password = params.password ?? ''
  const keystoreJson = await encryptKeystoreJson(wallet, password, {
    scrypt: { N: 1024 },
  })
  const keystore = JSON.parse(keystoreJson) as Record<string, unknown>

  const stored: EncryptedIdentityStore = {
    version: 1,
    address,
    encryptionPublicKey: params.identity.compressedPubKey.toString('hex'),
    keystore,
    mnemonic: encryptMnemonic(params.mnemonic, params.password),
    createdAt: new Date().toISOString(),
  }

  writeFileSync(filePath, JSON.stringify(stored, null, 2) + '\n', {
    mode: 0o600,
  })

  // Initialize wallet storage LevelDB bundle at ~/.signet/wallets/<address>/
  const walletLocation = join(walletsDir, address.toLowerCase())
  const bundle = await openMonadWalletBundle({
    location: walletLocation,
    seed: { mnemonic: params.mnemonic, passphrase: '' },
    mode: 'create',
  })
  await bundle.close()

  // Initialize durable journals in the wallet directory
  mkdirSync(join(walletLocation, 'stamp-attempt-journal'), { recursive: true })
  mkdirSync(join(walletLocation, 'sub-accounts'), { recursive: true })

  const attemptJournal = new LevelStampAttemptJournal(walletLocation)
  await attemptJournal.Open()
  await attemptJournal.Close()

  const paymentJournal = new LevelStampPaymentJournal(walletLocation)
  await paymentJournal.Open()
  await paymentJournal.Close()

  // Update activeIdentity in config if not set
  const config = loadConfig(dataDir)
  if (!config.activeIdentity) {
    config.activeIdentity = address
    saveConfig(dataDir, config)
  }

  return filePath
}

export function listIdentities(dataDir: string): string[] {
  const { identitiesDir } = ensureStorageLayout(dataDir)
  if (!existsSync(identitiesDir)) return []
  return readdirSync(identitiesDir)
    .filter(name => name.endsWith('.json'))
    .map(name => name.slice(0, -5))
}

export async function loadIdentity(
  dataDir: string,
  addressOrActive?: string,
  password?: string,
): Promise<{
  identity: MonadIdentity
  mnemonic: string
  address: string
  encryptionPublicKey: string
  walletDir: string
}> {
  const { identitiesDir, walletsDir } = ensureStorageLayout(dataDir)
  const config = loadConfig(dataDir)

  let target = addressOrActive ?? config.activeIdentity
  if (!target) {
    const list = listIdentities(dataDir)
    if (list.length === 0) {
      throw new Error(
        "No identity found in state storage. Create one with 'signet identity create'.",
      )
    }
    target = list[0]
  }

  const normalized = target.toLowerCase()
  const candidatePath = join(identitiesDir, `${normalized}.json`)
  if (!existsSync(candidatePath)) {
    throw new Error(`Identity file not found for address ${target}`)
  }

  const raw = JSON.parse(
    readFileSync(candidatePath, 'utf8'),
  ) as EncryptedIdentityStore

  const pwd = password ?? process.env.SIGNET_PASSWORD ?? ''
  let mnemonic: string
  let privateKeyHex: string

  try {
    mnemonic = decryptMnemonic(raw.mnemonic, pwd)
  } catch (err) {
    throw new Error(
      `Failed to decrypt mnemonic for ${target}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  try {
    const decryptedWallet = await decryptKeystoreJson(
      JSON.stringify(raw.keystore),
      pwd,
    )
    privateKeyHex = decryptedWallet.privateKey
  } catch (err) {
    // If keystore decryption failed with given password, try with mnemonic directly
    try {
      const derivedIdentity = MonadIdentity.fromSeed({ mnemonic })
      privateKeyHex = derivedIdentity.toPrivateKeyHex()
    } catch {
      throw new Error(
        `Failed to decrypt keystore for ${target}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  const identity = MonadIdentity.fromPrivateKeyHex(privateKeyHex)
  const walletDir = join(walletsDir, raw.address.toLowerCase())

  return {
    identity,
    mnemonic,
    address: raw.address,
    encryptionPublicKey: raw.encryptionPublicKey,
    walletDir,
  }
}
