import { constants, closeSync, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { getAddress } from 'ethers';
import type { EvmChainConfig } from '@frank/wallet/chain/evm-chain-config';
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain/monad-chain';
import { canonicalNetworkDescriptor } from '@frank/cashweb/relay/canonical-dm-transport';

export interface GatewayIdentityConfig {
  readonly chain: EvmChainConfig;
  readonly rootFile: string;
  readonly expectedIdentityAddress: string;
  readonly journalFile: string;
  readonly blobDirectory: string;
  readonly gatewayDomain: string;
  readonly relayBaseUrl: string;
}

export interface GatewayProvisionConfig extends GatewayIdentityConfig {
  readonly backupRootFile: string;
}

export interface GatewayHostConfig extends GatewayIdentityConfig {
  readonly directoryStorage: string;
  readonly journalMode: 'existing' | 'provision';
  readonly resendApiKey: string;
  readonly resendWebhookSecret: string;
  readonly resendRawOrigins: readonly string[];
  readonly inboundStampValue: bigint;
  readonly webhookHost: string;
  readonly webhookPort: number;
  readonly pollIntervalMs: number;
  readonly operatorAccountAddress?: string;
  readonly operatorForwardEmail?: string;
  readonly nativeSmtp?: {
    readonly host: string;
    readonly port: number;
    readonly hostname: string;
    readonly tlsKey: Buffer;
    readonly tlsCert: Buffer;
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Required mail host setting ${name} is missing`);
  return value;
}

function absolute(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value)) throw new Error(`Mail host setting ${name} must be an absolute path`);
  return value;
}

/** Secret Manager/Kubernetes volume input. Never accept raw credentials in process env. */
function ownerSecret(path: string): string {
  const bytes = ownerFile(path);
  try {
    const secret = bytes.toString('utf8').trim();
    if (!secret || secret.includes('\n')) throw new Error('Mail host secret file is empty or multiline');
    return secret;
  } finally {
    bytes.fill(0);
  }
}

function ownerFile(path: string): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || (process.platform !== 'win32' &&
      ((info.mode & 0o077) !== 0 || (info.mode & 0o400) === 0))) {
      throw new Error('Mail host secret file must be owner-readable only');
    }
    const contents = readFileSync(fd);
    if (contents.length === 0) throw new Error('Mail host secret file is empty');
    return contents;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function positiveInteger(value: string, name: string, maximum: number): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be an integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new Error(`${name} is outside its allowed range`);
  return result;
}

function loadGatewayIdentityConfig(env: NodeJS.ProcessEnv): GatewayIdentityConfig {
  const walletStorageLocation = absolute(env, 'FRANK_MAIL_WALLET_STATE_DIR');
  const rootFile = absolute(env, 'FRANK_MAIL_ROOTS_FILE');
  const journalFile = absolute(env, 'FRANK_MAIL_JOURNAL_FILE');
  const blobDirectory = absolute(env, 'FRANK_MAIL_BLOB_DIR');
  const gatewayDomain = required(env, 'FRANK_MAIL_GATEWAY_DOMAIN').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(gatewayDomain))
    throw new Error('Invalid gateway mail domain');
  const relayBaseUrl = required(env, 'FRANK_MAIL_RELAY_URL');
  if (new URL(relayBaseUrl).protocol !== 'https:') throw new Error('Mail relay URL must use HTTPS');
  const expectedIdentityAddress = getAddress(required(env, 'FRANK_MAIL_EXPECTED_IDENTITY'));
  const descriptor = canonicalNetworkDescriptor(env.FRANK_NETWORK_TAG ?? 'MONT');
  const chain = {
    ...loadMonadChainConfigFromEnv({ isTestnet: true }),
    chainIdentifier: descriptor.network,
    networkTag: descriptor.tag,
    networkId: descriptor.network,
    rpcChain: descriptor.network,
    chainId: descriptor.chainId,
    walletStorageLocation,
    requireBoundWalletState: true,
    walletStateExists: existsSync,
    relayBaseUrl,
  } satisfies EvmChainConfig;
  return { chain, rootFile, expectedIdentityAddress, journalFile, blobDirectory, gatewayDomain, relayBaseUrl };
}

/** The one-time local state initializer needs no Resend or listener credentials. */
export function loadGatewayProvisionConfig(env: NodeJS.ProcessEnv = process.env): GatewayProvisionConfig {
  return { ...loadGatewayIdentityConfig(env), backupRootFile: absolute(env, 'FRANK_MAIL_ROOTS_BACKUP_FILE') };
}

export function loadGatewayHostConfig(env: NodeJS.ProcessEnv = process.env): GatewayHostConfig {
  const identity = loadGatewayIdentityConfig(env);
  const directoryStorage = absolute(env, 'FRANK_MAIL_DIRECTORY_DIR');
  const resendApiKey = ownerSecret(absolute(env, 'FRANK_MAIL_RESEND_API_KEY_FILE'));
  const resendWebhookSecret = ownerSecret(absolute(env, 'FRANK_MAIL_RESEND_WEBHOOK_SECRET_FILE'));
  const resendRawOrigins = required(env, 'FRANK_MAIL_RESEND_RAW_ORIGINS').split(',').map(origin => origin.trim());
  if (resendRawOrigins.some(origin => !origin || new URL(origin).protocol !== 'https:' ||
    new URL(origin).origin !== origin)) throw new Error('Resend raw origins must be exact HTTPS origins');
  const stampRaw = required(env, 'FRANK_MAIL_STAMP_WEI');
  if (!/^[0-9]+$/.test(stampRaw)) throw new Error('Inbound stamp must be an unsigned base-unit integer');
  const inboundStampValue = BigInt(stampRaw);
  const journalMode = env.FRANK_MAIL_JOURNAL_MODE ?? 'existing';
  if (journalMode !== 'existing' && journalMode !== 'provision')
    throw new Error('FRANK_MAIL_JOURNAL_MODE must be existing or provision');
  const webhookHost = required(env, 'FRANK_MAIL_WEBHOOK_HOST');
  const webhookPort = positiveInteger(required(env, 'FRANK_MAIL_WEBHOOK_PORT'), 'Webhook port', 65535);
  const pollIntervalMs = positiveInteger(required(env, 'FRANK_MAIL_POLL_MS'), 'Poll interval', 3_600_000);
  const operatorAccountRaw = env.FRANK_MAIL_OPERATOR_ACCOUNT?.trim();
  const operatorForwardRaw = env.FRANK_MAIL_OPERATOR_EMAIL?.trim();
  const operatorForwardEmail = operatorForwardRaw
    ? (() => {
        const lower = operatorForwardRaw.toLowerCase();
        if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(lower)) {
          throw new Error('Invalid operator forwarding email address');
        }
        return lower;
      })()
    : undefined;
  const operatorAccountAddress = operatorAccountRaw
    ? getAddress(operatorAccountRaw).toLowerCase()
    : operatorForwardEmail
      ? identity.expectedIdentityAddress.toLowerCase()
      : undefined;
  const smtpNames = [
    'FRANK_MAIL_SMTP_HOST', 'FRANK_MAIL_SMTP_PORT', 'FRANK_MAIL_SMTP_HOSTNAME',
    'FRANK_MAIL_SMTP_TLS_KEY_FILE', 'FRANK_MAIL_SMTP_TLS_CERT_FILE',
  ] as const;
  const nativeSmtpPresent = smtpNames.some(name => env[name] !== undefined);
  const nativeSmtp = nativeSmtpPresent ? (() => {
    const host = required(env, 'FRANK_MAIL_SMTP_HOST');
    const port = positiveInteger(required(env, 'FRANK_MAIL_SMTP_PORT'), 'SMTP port', 65535);
    const hostname = required(env, 'FRANK_MAIL_SMTP_HOSTNAME').toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname))
      throw new Error('Invalid SMTP hostname');
    const tlsKey = ownerFile(absolute(env, 'FRANK_MAIL_SMTP_TLS_KEY_FILE'));
    try {
      const tlsCert = ownerFile(absolute(env, 'FRANK_MAIL_SMTP_TLS_CERT_FILE'));
      return { host, port, hostname, tlsKey, tlsCert };
    } catch (error) {
      tlsKey.fill(0);
      throw error;
    }
  })() : undefined;
  return {
    ...identity, directoryStorage,
    journalMode, resendApiKey, resendWebhookSecret,
    resendRawOrigins, inboundStampValue, webhookHost, webhookPort, pollIntervalMs,
    ...(operatorAccountAddress ? { operatorAccountAddress } : {}),
    ...(operatorForwardEmail ? { operatorForwardEmail } : {}),
    nativeSmtp,
  };
}
