/**
 * Directory probing utility for discovering an account's configured home relay during account restore.
 *
 * Part of @frank/cashweb/relay. Queries GET /directory/v1/:network/:subject/head (or /address/:address)
 * on a bootstrap or default relay, cryptographically verifies that the returned attestation is signed
 * by the expected address / public key, and returns the home relay endpoint URL (head.relay.endpoint).
 */
import { toHex, verifyPreviewDirectoryEvidence } from "@frank/codec";
import { directoryAddress } from "./open-directory";

const CBOR_MEDIA = "application/vnd.frank.cbor";
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

export interface ProbeDirectoryOptions {
  /** Relay URL to probe. Defaults to build/environment relay URL or window.location.origin. */
  relayBaseUrl?: string;
  /** Frank protocol directory network (e.g. 'monad-testnet' or 'monad-mainnet'). Defaults to 'monad-testnet'. */
  network?: string;
  /** Request timeout in milliseconds. Defaults to 5000ms. */
  timeoutMs?: number;
  /** Custom fetch implementation (useful for tests or Node environments). */
  fetch?: (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: Uint8Array;
      signal?: AbortSignal;
    }
  ) => Promise<any>;
}

export type ProbeTarget =
  | string
  | Uint8Array
  | {
      subject?: string;
      address?: string;
      compressedPublicKey?: Uint8Array | string;
    };

/**
 * Normalizes the probe target into subject (66-char hex) and/or address (0x-prefixed 40-hex lowercase).
 */
export function normalizeProbeTarget(target: ProbeTarget): {
  subject?: string;
  address?: string;
} {
  if (target instanceof Uint8Array) {
    const subject = toHex(target).toLowerCase();
    return { subject, address: directoryAddress(subject) };
  }

  if (typeof target === "string") {
    const trimmed = target.trim();
    if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
      return { address: trimmed.toLowerCase() };
    }
    if (/^(02|03)[0-9a-fA-F]{64}$/.test(trimmed)) {
      const subject = trimmed.toLowerCase();
      return { subject, address: directoryAddress(subject) };
    }
    if (/^[0-9a-fA-F]{40}$/.test(trimmed)) {
      return { address: `0x${trimmed.toLowerCase()}` };
    }
    const subject = trimmed.toLowerCase();
    return { subject, address: directoryAddress(subject) };
  }

  let subject: string | undefined;
  let address: string | undefined;

  if (target.compressedPublicKey) {
    const pubKey = target.compressedPublicKey;
    subject = (
      typeof pubKey === "string" ? pubKey : toHex(pubKey)
    ).toLowerCase();
    address = directoryAddress(subject);
  }
  if (target.subject) {
    subject = target.subject.toLowerCase();
    if (!address) address = directoryAddress(subject);
  }
  if (target.address) {
    address = target.address.toLowerCase();
  }

  return { subject, address };
}

/**
 * Fallback resolution of default relay URL if none is provided in options.
 */
function resolveDefaultProbeRelayUrl(): string {
  try {
    if (typeof process !== "undefined" && process.env) {
      if (process.env.FRANK_RELAY_URL) {
        return process.env.FRANK_RELAY_URL.replace(/\/+$/, "");
      }
      if (process.env.FRANK_DEMO_RELAY_PORT) {
        return `http://127.0.0.1:${process.env.FRANK_DEMO_RELAY_PORT}`;
      }
    }
    if (typeof window !== "undefined" && window.location?.origin) {
      return window.location.origin.replace(/\/+$/, "");
    }
  } catch {
    // fallback
  }
  return "http://127.0.0.1:8098";
}

/**
 * Probes the directory entry for a Monad address or compressed public key on the bootstrap relay.
 * If a valid signed entry is found, returns the discovered home relay endpoint URL (`head.relay.endpoint`).
 * If not found, offline, or invalid, returns `undefined`.
 */
export async function probeDirectoryRelay(
  target: ProbeTarget,
  options?: ProbeDirectoryOptions
): Promise<string | undefined> {
  try {
    const { subject, address } = normalizeProbeTarget(target);
    if (!subject && !address) {
      return undefined;
    }

    const relayBaseUrl = options?.relayBaseUrl ?? resolveDefaultProbeRelayUrl();
    const cleanOrigin = relayBaseUrl.trim().replace(/\/+$/, "");

    const network = options?.network ?? "monad-testnet";

    const url = subject
      ? `${cleanOrigin}/directory/v1/${network}/${subject}/head`
      : `${cleanOrigin}/directory/v1/${network}/address/${address}`;

    const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const controller =
      typeof AbortController !== "undefined"
        ? new AbortController()
        : undefined;
    let timer: any;
    if (controller && timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }

    const fetchFn =
      options?.fetch ?? (typeof fetch !== "undefined" ? fetch : undefined);
    if (!fetchFn) {
      return undefined;
    }

    let response: any;
    try {
      response = await fetchFn(url, {
        method: "GET",
        headers: {
          accept: CBOR_MEDIA,
          "ngrok-skip-browser-warning": "1",
        },
        signal: controller?.signal,
      });
    } catch {
      // Network error, connection refused, or timeout
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response || response.status !== 200) {
      // 404 means no entry published for this address
      return undefined;
    }

    // Read attestation bytes
    let bodyBytes: Uint8Array;
    if (typeof response.arrayBuffer === "function") {
      const buffer = await response.arrayBuffer();
      bodyBytes = new Uint8Array(buffer);
    } else if (response.body) {
      bodyBytes =
        response.body instanceof Uint8Array
          ? response.body
          : new Uint8Array(response.body);
    } else {
      return undefined;
    }

    if (!bodyBytes || bodyBytes.length === 0) {
      return undefined;
    }

    // Cryptographically verify directory evidence
    let evidence: any;
    try {
      evidence = verifyPreviewDirectoryEvidence(bodyBytes, network);
    } catch {
      // Invalid attestation format or signature
      return undefined;
    }

    if (!evidence || !evidence.statement) {
      return undefined;
    }

    const statement = evidence.statement;

    // Verify subject / address match
    let entrySubject: string | undefined;
    if (statement.subject) {
      if (typeof statement.subject === "string") {
        entrySubject = statement.subject.toLowerCase();
      } else if (statement.subject instanceof Uint8Array) {
        entrySubject = toHex(statement.subject).toLowerCase();
      } else if (statement.subject.keyBytes) {
        entrySubject = toHex(statement.subject.keyBytes).toLowerCase();
      }
    }

    if (subject && (!entrySubject || entrySubject !== subject)) {
      return undefined;
    }

    if (address) {
      const entryAddress = entrySubject
        ? directoryAddress(entrySubject)
        : undefined;
      if (!entryAddress || entryAddress.toLowerCase() !== address) {
        return undefined;
      }
    }

    // Extract home relay endpoint
    const relayBinding = statement.relays?.[0] ?? (statement as any).relay;
    if (!relayBinding?.endpoint) {
      return undefined;
    }

    const endpoint = String(relayBinding.endpoint).trim().replace(/\/+$/, "");
    if (!endpoint.startsWith("http://") && !endpoint.startsWith("https://")) {
      return undefined;
    }

    return endpoint;
  } catch {
    return undefined;
  }
}

/**
 * Alias for probeDirectoryRelay.
 */
export const probeDirectoryEntry = probeDirectoryRelay;
