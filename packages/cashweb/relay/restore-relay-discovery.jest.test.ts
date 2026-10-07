import {
  probeDirectoryRelay,
  probeDirectoryEntry,
  normalizeProbeTarget,
} from "./restore-relay-discovery";
import { testAccount } from "@frank/cashweb/relay/open-directory-fake-relay.testutil";
import { fromHex, toHex } from "@frank/codec";

const NETWORK = "monad-testnet";
const SECOND = 1_000_000_000n;
const NOW_NS = 1_800_000_000n * SECOND;

function createSignedAttestation(
  account: ReturnType<typeof testAccount>,
  endpoint = "https://custom-home-relay.example.com"
) {
  return account.sign({
    network: NETWORK,
    revision: 0n,
    predecessor: null,
    issuedAt: { seconds: 100n, nanoseconds: 0 },
    expiresAt: { seconds: 3700n, nanoseconds: 0 },
    relay: {
      relayId: new Uint8Array(16).fill(1),
      endpoint,
      identity: { keyType: 1, keyBytes: fromHex(account.subject) },
      expiry: { seconds: 3700n, nanoseconds: 0 },
      unknownFields: new Map(),
    },
  });
}

describe("restore-relay-discovery", () => {
  test("normalizes various target formats", () => {
    const acc = testAccount(1);
    // 66-hex subject
    const bySubject = normalizeProbeTarget(acc.subject);
    expect(bySubject.subject).toBe(acc.subject.toLowerCase());
    expect(bySubject.address).toBe(acc.address.toLowerCase());

    // 0x-prefixed address
    const byAddress = normalizeProbeTarget(acc.address);
    expect(byAddress.address).toBe(acc.address.toLowerCase());
    expect(byAddress.subject).toBeUndefined();

    // Uint8Array pubkey
    const byUint8Array = normalizeProbeTarget(fromHex(acc.subject));
    expect(byUint8Array.subject).toBe(acc.subject.toLowerCase());
    expect(byUint8Array.address).toBe(acc.address.toLowerCase());

    // Object with compressedPublicKey
    const byObjPubkey = normalizeProbeTarget({
      compressedPublicKey: acc.subject,
    });
    expect(byObjPubkey.subject).toBe(acc.subject.toLowerCase());
    expect(byObjPubkey.address).toBe(acc.address.toLowerCase());

    // Object with address
    const byObjAddress = normalizeProbeTarget({ address: acc.address });
    expect(byObjAddress.address).toBe(acc.address.toLowerCase());
  });

  test("discovers and verifies home relay endpoint when directory entry exists on relay", async () => {
    const acc = testAccount(1);
    const expectedRelay = "https://my-home-relay.example.org";
    const attestation = createSignedAttestation(acc, expectedRelay);

    const mockFetch = jest.fn(async (url: string) => {
      expect(url).toContain(`/directory/v1/${NETWORK}/${acc.subject}/head`);
      return {
        status: 200,
        arrayBuffer: async () =>
          attestation.buffer.slice(
            attestation.byteOffset,
            attestation.byteOffset + attestation.byteLength
          ),
      };
    });

    const discovered = await probeDirectoryRelay(acc.subject, {
      relayBaseUrl: "http://bootstrap-relay.example.com:8098",
      network: NETWORK,
      fetch: mockFetch,
    });

    expect(discovered).toBe(expectedRelay);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("probeDirectoryEntry alias returns the same home relay endpoint", async () => {
    const acc = testAccount(2);
    const expectedRelay = "https://another-home.example.com";
    const attestation = createSignedAttestation(acc, expectedRelay);

    const mockFetch = jest.fn(async () => ({
      status: 200,
      arrayBuffer: async () =>
        attestation.buffer.slice(
          attestation.byteOffset,
          attestation.byteOffset + attestation.byteLength
        ),
    }));

    const discovered = await probeDirectoryEntry(
      { subject: acc.subject, address: acc.address },
      {
        relayBaseUrl: "http://127.0.0.1:8098",
        network: NETWORK,
        fetch: mockFetch,
      }
    );

    expect(discovered).toBe(expectedRelay);
  });

  test("probes by address when only address is provided", async () => {
    const acc = testAccount(3);
    const expectedRelay = "https://address-probed-relay.example.com";
    const attestation = createSignedAttestation(acc, expectedRelay);

    const mockFetch = jest.fn(async (url: string) => {
      expect(url).toContain(`/directory/v1/${NETWORK}/address/${acc.address}`);
      return {
        status: 200,
        arrayBuffer: async () =>
          attestation.buffer.slice(
            attestation.byteOffset,
            attestation.byteOffset + attestation.byteLength
          ),
      };
    });

    const discovered = await probeDirectoryRelay(acc.address, {
      relayBaseUrl: "http://bootstrap.example.com",
      network: NETWORK,
      fetch: mockFetch,
    });

    expect(discovered).toBe(expectedRelay);
  });

  test("returns undefined when relay returns 404 (no entry found)", async () => {
    const acc = testAccount(4);
    const mockFetch = jest.fn(async () => ({
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));

    const discovered = await probeDirectoryRelay(acc.subject, {
      relayBaseUrl: "http://127.0.0.1:8098",
      network: NETWORK,
      fetch: mockFetch,
    });

    expect(discovered).toBeUndefined();
  });

  test("returns undefined when attestation is signed by a different subject", async () => {
    const alice = testAccount(5);
    const bob = testAccount(6);
    // Relay returns Bob's attestation when Alice was asked
    const bobsAttestation = createSignedAttestation(
      bob,
      "https://bob-relay.example.com"
    );

    const mockFetch = jest.fn(async () => ({
      status: 200,
      arrayBuffer: async () =>
        bobsAttestation.buffer.slice(
          bobsAttestation.byteOffset,
          bobsAttestation.byteOffset + bobsAttestation.byteLength
        ),
    }));

    const discovered = await probeDirectoryRelay(alice.subject, {
      relayBaseUrl: "http://127.0.0.1:8098",
      network: NETWORK,
      fetch: mockFetch,
    });

    expect(discovered).toBeUndefined();
  });

  test("gracefully returns undefined when fetch throws network error or times out", async () => {
    const acc = testAccount(7);
    const mockFetch = jest.fn(async () => {
      throw new Error("Connection refused");
    });

    const discovered = await probeDirectoryRelay(acc.subject, {
      relayBaseUrl: "http://127.0.0.1:8098",
      network: NETWORK,
      fetch: mockFetch,
    });

    expect(discovered).toBeUndefined();
  });

  test("gracefully returns undefined when body is corrupted or invalid CBOR", async () => {
    const acc = testAccount(8);
    const mockFetch = jest.fn(async () => ({
      status: 200,
      arrayBuffer: async () => new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer,
    }));

    const discovered = await probeDirectoryRelay(acc.subject, {
      relayBaseUrl: "http://127.0.0.1:8098",
      network: NETWORK,
      fetch: mockFetch,
    });

    expect(discovered).toBeUndefined();
  });
});
