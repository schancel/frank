/**
 * Directory probing utility for discovering an account's configured home relay during account restore.
 *
 * Queries GET /${subject}/head (or /address/${address}) on a bootstrap / default relay, cryptographically
 * verifies that the returned attestation is signed by the expected address / public key, and returns
 * the home relay URL (head.relay.endpoint).
 */
import { toHex, verifyPreviewDirectoryEvidence } from "@frank/codec";
import { directoryAddress } from "@frank/cashweb/relay/open-directory";
import {
  getDefaultRelayBaseUrl,
  loadMonadChainConfigFromEnv,
} from "./monad-chain";

const CBOR_MEDIA = "application/vnd.frank.cbor";
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

export interface ProbeDirectoryOptions {
  relayBaseUrl?: string;
  network?: string;
  timeoutMs?: number;
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

    const relayBaseUrl = options?.relayBaseUrl ?? getDefaultRelayBaseUrl();
    const cleanOrigin = relayBaseUrl.trim().replace(/\/+$/, "");

    let network = options?.network;
    if (!network) {
      try {
        const config = loadMonadChainConfigFromEnv();
        network =
          config.networkTag === "MON1"
            ? "monad-mainnet"
            : config.networkTag === "MONT"
            ? "monad-testnet"
            : config.networkTag ?? "monad-testnet";
      } catch {
        network = "monad-testnet";
      }
    }

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
      if (timer) clearTimeout(timer);
      return undefined;
    }

    let response: any;
    try {
      response = await fetchFn(url, {
        method: "GET",
        headers: {
          Accept: CBOR_MEDIA,
          "ngrok-skip-browser-warning": "1",
        },
        signal: controller?.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response || response.status !== 200) {
      return undefined;
    }

    let bytes: Uint8Array | undefined;
    if (typeof response.arrayBuffer === "function") {
      const buf = await response.arrayBuffer();
      bytes = new Uint8Array(buf);
    } else if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          length += value.length;
        }
      }
      bytes = new Uint8Array(length);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
    } else if (response.data instanceof Uint8Array) {
      bytes = response.data;
    } else if (
      typeof Buffer !== "undefined" &&
      Buffer.isBuffer(response.data)
    ) {
      bytes = new Uint8Array(response.data);
    }

    if (!bytes || bytes.length === 0) {
      return undefined;
    }

    // Verify attestation cryptographically
    const verified = verifyPreviewDirectoryEvidence(bytes, network);
    const statement = verified.statement;

    // Verify signer matches target subject and/or address
    const signerSubjectHex = toHex(statement.subject.keyBytes).toLowerCase();

    if (subject && signerSubjectHex !== subject) {
      return undefined;
    }

    if (address) {
      const signerAddress = directoryAddress(signerSubjectHex);
      if (!signerAddress || signerAddress.toLowerCase() !== address) {
        return undefined;
      }
    }

    // Extract home relay endpoint
    if (!statement.relays || statement.relays.length === 0) {
      return undefined;
    }

    const endpoint = statement.relays[0].endpoint;
    if (!endpoint || typeof endpoint !== "string") {
      return undefined;
    }

    // Validate that endpoint is a valid HTTP/HTTPS URL
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }

    return endpoint.trim().replace(/\/+$/, "");
  } catch {
    // Offline, invalid signature, network failure, etc. -> graceful fallback
    return undefined;
  }
}

export const probeDirectoryEntry = probeDirectoryRelay;
