/**
 * Cryptographic External Naming Proofs (`.eth` ENS, `.sol` SNS, and DNS)
 * for Frank Directory Identities (Issue #973).
 *
 * Bi-directionally binds an external name (`alice.eth`, `toly.sol`, `alice@example.com`)
 * to the user's canonical Frank identity address (`0x...`) using:
 * 1. Reverse attestation: a cryptographic `ExternalNameClaim` (`proofSignature` over
 *    `frank-name-bind-v1` + namespace + name + ownerAddress + chainId + timestamp).
 * 2. Forward resolution: verifying via `resolveExternalName(name)` that the external
 *    naming registry currently resolves `name` to `ownerAddress`.
 */

import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export type ExternalNameNamespace = 'ens' | 'sns' | 'dns';

export interface ExternalNameClaim {
  readonly namespace: ExternalNameNamespace;
  readonly name: string;
  readonly ownerAddress: string;
  readonly chainId?: string;
  readonly proofSignature: string;
  readonly timestamp: number;
}

export interface CreateExternalNameClaimInput {
  readonly namespace?: ExternalNameNamespace;
  readonly name: string;
  readonly ownerAddress: string;
  readonly chainId?: string;
  readonly timestamp?: number;
  readonly proofSignature?: string;
  readonly secretKey?: Uint8Array | string;
  readonly sign?: (message: string, messageBytes: Uint8Array) => string | Uint8Array;
}

export type ExternalNameResolution =
  | string
  | {
      readonly ownerAddress: string;
      readonly chainId?: string;
      readonly namespace?: ExternalNameNamespace;
    }
  | null
  | undefined;

export type ExternalNameResolver = (
  name: string,
  namespace: ExternalNameNamespace,
) => Promise<ExternalNameResolution> | ExternalNameResolution;

export interface VerifyExternalNameClaimOptions {
  readonly resolveExternalName?: ExternalNameResolver;
  readonly secretKey?: Uint8Array | string;
  readonly verifySignature?: (
    claim: ExternalNameClaim,
    message: string,
    messageBytes: Uint8Array,
  ) => boolean | Promise<boolean>;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

const BINDING_DOMAIN_TAG = 'frank-name-bind-v1';

/**
 * Infers the naming namespace (`'ens' | 'sns' | 'dns'`) from a handle string.
 */
export function inferExternalNameNamespace(name: string): ExternalNameNamespace | undefined {
  if (typeof name !== 'string') return undefined;
  const cleaned = name.trim().toLowerCase().replace(/\.+$/, '');
  if (!cleaned) return undefined;
  if (cleaned.endsWith('.eth')) return 'ens';
  if (cleaned.endsWith('.sol')) return 'sns';
  if (cleaned.includes('.')) return 'dns';
  return undefined;
}

/**
 * Normalizes and validates an external name and its namespace.
 */
export function normalizeExternalName(
  name: string,
  explicitNamespace?: ExternalNameNamespace,
): { readonly namespace: ExternalNameNamespace; readonly name: string } {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('External name must be a non-empty string');
  }
  const normalized = name.trim().replace(/^@/, '').toLowerCase().replace(/\.+$/, '');
  const inferred = inferExternalNameNamespace(normalized);
  const namespace = explicitNamespace ?? inferred;
  if (!namespace || !['ens', 'sns', 'dns'].includes(namespace)) {
    throw new Error(`Unable to determine valid external naming namespace for "${name}"`);
  }

  if (namespace === 'ens') {
    if (
      !normalized.endsWith('.eth') ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.eth$/.test(
        normalized,
      )
    ) {
      throw new Error(`Invalid ENS (.eth) name: "${name}"`);
    }
  } else if (namespace === 'sns') {
    if (
      !normalized.endsWith('.sol') ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.sol$/.test(
        normalized,
      )
    ) {
      throw new Error(`Invalid SNS (.sol) name: "${name}"`);
    }
  } else {
    const parts = normalized.split('@');
    const domainPart = parts.length === 2 ? parts[1] : parts[0];
    if (
      parts.length > 2 ||
      (parts.length === 2 && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(parts[0])) ||
      !domainPart.includes('.') ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
        domainPart,
      )
    ) {
      throw new Error(`Invalid DNS external name: "${name}"`);
    }
  }

  return { namespace, name: normalized };
}

/**
 * Validates and normalizes a canonical Frank identity address (`0x` + 40 hex chars).
 */
export function normalizeCanonicalOwnerAddress(ownerAddress: string): string {
  if (typeof ownerAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(ownerAddress.trim())) {
    throw new Error(`Invalid canonical Frank ownerAddress: "${ownerAddress}"`);
  }
  return ownerAddress.trim().toLowerCase();
}

/**
 * Formats the canonical message string signed by an `ExternalNameClaim`.
 */
export function formatExternalNameBindingMessage(params: {
  readonly namespace: ExternalNameNamespace;
  readonly name: string;
  readonly ownerAddress: string;
  readonly chainId?: string;
  readonly timestamp: number;
}): string {
  return [
    BINDING_DOMAIN_TAG,
    params.namespace,
    params.name.toLowerCase(),
    params.ownerAddress.toLowerCase(),
    params.chainId ?? '',
    String(params.timestamp),
  ].join(':');
}

function toKeyBytes(secretKey: Uint8Array | string): Uint8Array {
  if (secretKey instanceof Uint8Array) return secretKey;
  const trimmed = secretKey.trim().replace(/^0x/i, '');
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    const out = new Uint8Array(trimmed.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return utf8ToBytes(secretKey);
}

function computeDefaultProofSignature(
  messageBytes: Uint8Array,
  secretKey?: Uint8Array | string,
): string {
  const keyBytes = secretKey
    ? toKeyBytes(secretKey)
    : sha256(utf8ToBytes(`${BINDING_DOMAIN_TAG}:commitment-key`));
  const r = hmac(sha256, keyBytes, messageBytes);
  const s = hmac(sha256, r, messageBytes);
  return `0x${bytesToHex(r)}${bytesToHex(s)}`;
}

/**
 * Creates a cryptographically bound `ExternalNameClaim` for `.eth` (ENS), `.sol` (SNS), or DNS names.
 */
export function createExternalNameClaim(input: CreateExternalNameClaimInput): ExternalNameClaim;
export function createExternalNameClaim(
  name: string,
  ownerAddress: string,
  options?: Omit<CreateExternalNameClaimInput, 'name' | 'ownerAddress'>,
): ExternalNameClaim;
export function createExternalNameClaim(
  inputOrName: CreateExternalNameClaimInput | string,
  ownerAddressArg?: string,
  optionsArg?: Omit<CreateExternalNameClaimInput, 'name' | 'ownerAddress'>,
): ExternalNameClaim {
  const input: CreateExternalNameClaimInput =
    typeof inputOrName === 'string'
      ? {
          ...optionsArg,
          name: inputOrName,
          ownerAddress: ownerAddressArg ?? '',
        }
      : inputOrName;

  const { namespace, name } = normalizeExternalName(input.name, input.namespace);
  const ownerAddress = normalizeCanonicalOwnerAddress(input.ownerAddress);
  const timestamp = input.timestamp ?? Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error('ExternalNameClaim timestamp must be a positive safe integer');
  }

  const chainId =
    input.chainId !== undefined
      ? input.chainId.trim() || undefined
      : namespace === 'ens'
        ? 'eip155:1'
        : namespace === 'sns'
          ? 'solana:mainnet'
          : undefined;

  const message = formatExternalNameBindingMessage({
    namespace,
    name,
    ownerAddress,
    chainId,
    timestamp,
  });
  const messageBytes = utf8ToBytes(message);

  let proofSignature: string;
  if (typeof input.proofSignature === 'string' && input.proofSignature.trim()) {
    proofSignature = input.proofSignature.trim();
  } else if (typeof input.sign === 'function') {
    const signed = input.sign(message, messageBytes);
    proofSignature =
      signed instanceof Uint8Array ? `0x${bytesToHex(signed)}` : String(signed).trim();
  } else {
    proofSignature = computeDefaultProofSignature(messageBytes, input.secretKey);
  }

  if (!proofSignature) {
    throw new Error('ExternalNameClaim proofSignature must be non-empty');
  }

  return {
    namespace,
    name,
    ownerAddress,
    ...(chainId ? { chainId } : {}),
    proofSignature,
    timestamp,
  };
}

/**
 * Verifies an `ExternalNameClaim` both structurally/cryptographically (reverse attestation)
 * and against the forward-resolution hook (`resolveExternalName(name)`) when provided.
 */
export async function verifyExternalNameClaim(
  claim: ExternalNameClaim,
  optionsOrResolver?: VerifyExternalNameClaimOptions | ExternalNameResolver,
): Promise<boolean> {
  if (!claim || typeof claim !== 'object') return false;

  const options: VerifyExternalNameClaimOptions =
    typeof optionsOrResolver === 'function'
      ? { resolveExternalName: optionsOrResolver }
      : optionsOrResolver ?? {};

  let normalizedName: { namespace: ExternalNameNamespace; name: string };
  let normalizedOwner: string;
  try {
    normalizedName = normalizeExternalName(claim.name, claim.namespace);
    if (normalizedName.namespace !== claim.namespace || normalizedName.name !== claim.name) {
      return false;
    }
    normalizedOwner = normalizeCanonicalOwnerAddress(claim.ownerAddress);
  } catch {
    return false;
  }

  if (!Number.isSafeInteger(claim.timestamp) || claim.timestamp <= 0) {
    return false;
  }

  if (typeof claim.proofSignature !== 'string' || !/^0x[0-9a-fA-F]{64,260}$/.test(claim.proofSignature.trim())) {
    return false;
  }

  if (options.maxAgeMs !== undefined) {
    const now = (options.now ?? Date.now)();
    if (claim.timestamp > now + 60_000 || now - claim.timestamp > options.maxAgeMs) {
      return false;
    }
  }

  const message = formatExternalNameBindingMessage({
    namespace: claim.namespace,
    name: claim.name,
    ownerAddress: normalizedOwner,
    chainId: claim.chainId,
    timestamp: claim.timestamp,
  });
  const messageBytes = utf8ToBytes(message);

  if (options.verifySignature) {
    const sigValid = await options.verifySignature(claim, message, messageBytes);
    if (!sigValid) return false;
  } else {
    const expectedSig = computeDefaultProofSignature(messageBytes, options.secretKey);
    if (claim.proofSignature.trim().toLowerCase() !== expectedSig.toLowerCase()) {
      return false;
    }
  }

  if (options.resolveExternalName) {
    let resolved: ExternalNameResolution;
    try {
      resolved = await options.resolveExternalName(claim.name, claim.namespace);
    } catch {
      return false;
    }
    if (!resolved) return false;

    const resolvedOwner =
      typeof resolved === 'string' ? resolved : resolved.ownerAddress;
    if (typeof resolvedOwner !== 'string') return false;
    if (resolvedOwner.trim().toLowerCase() !== normalizedOwner) {
      return false;
    }

    if (typeof resolved === 'object') {
      if (resolved.namespace && resolved.namespace !== claim.namespace) {
        return false;
      }
      if (resolved.chainId && claim.chainId && resolved.chainId !== claim.chainId) {
        return false;
      }
    }
  }

  return true;
}
