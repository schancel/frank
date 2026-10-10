import source from "../../../docs/protocol/chains/v1.json";
import { projectProtocolChains } from "./protocol-chain-registry";
import type { ClientChainExtension } from "./chains-registry";

const extensions: Readonly<Record<string, ClientChainExtension>> = {
  "monad-testnet": {
    kind: "monad",
    curve: "secp256k1",
    keyType: 1,
    name: "EVM fixture",
    unit: "MON",
  },
  "solana-devnet": {
    kind: "solana",
    curve: "ed25519",
    keyType: 2,
    name: "Solana fixture",
    unit: "dSOL",
  },
  "btc-mainnet": {
    kind: "bitcoin",
    curve: "secp256k1",
    keyType: 1,
    name: "Bitcoin fixture",
    unit: "BTC",
  },
};
function fixture(): typeof source {
  return JSON.parse(JSON.stringify(source));
}
function row(document: typeof source, id = "monad-testnet") {
  const found = document.chains.find((row) => row.id === id);
  if (!found) throw new Error(`Missing synthetic fixture row ${id}`);
  return found;
}

describe("direct protocol registry projection", () => {
  it.each(Object.keys(extensions))(
    "takes authoritative fixture changes through the same projection for %s",
    (id) => {
      const document = fixture();
      const changed = row(document, id);
      changed.network = "regtest";
      changed.caip2 = "fixture:changed";
      changed.allowed_proxy_capabilities = ["json-rpc"];
      changed.identity_probes = [
        { kind: "operator-block-checkpoint", capability: "json-rpc" },
      ];
      const registry = projectProtocolChains(document, extensions);
      expect(registry[id]).toMatchObject({
        id,
        family: changed.family,
        network: "regtest",
        isTestnet: true,
        caip2: "fixture:changed",
        allowedProxyCapabilities: ["json-rpc"],
        identityProbes: changed.identity_probes,
      });
      expect(registry[id].name).toBe(extensions[id].name);
      expect(row(source, id).network).not.toBe("regtest");
    }
  );

  it.each([
    "id",
    "family",
    "network",
    "isTestnet",
    "caip2",
    "nativeChainId",
    "native_chain_id",
    "allowedProxyCapabilities",
    "allowed_proxy_capabilities",
    "identityProbes",
    "identity_probes",
    "unexpected",
  ])("rejects protocol override or unknown extension field %s", (key) => {
    expect(() =>
      projectProtocolChains(source, {
        "monad-testnet": { ...extensions["monad-testnet"], [key]: "override" },
      })
    ).toThrow("unknown client extension field");
  });

  it("rejects duplicate protocol rows and unknown supported references", () => {
    const duplicate = fixture();
    duplicate.chains.push(duplicate.chains[0]);
    expect(() => projectProtocolChains(duplicate, extensions)).toThrow(
      "duplicate canonical ID"
    );
    expect(() =>
      projectProtocolChains(source, {
        "client-only-network": extensions["monad-testnet"],
      })
    ).toThrow("unsupported client reference");
  });

  it.each([
    [
      "schema",
      (doc: typeof source) => {
        doc.schema_version = 2;
      },
    ],
    [
      "family",
      (doc: typeof source) => {
        row(doc).family = "unknown";
      },
    ],
    [
      "network",
      (doc: typeof source) => {
        row(doc).network = "unknown";
      },
    ],
    [
      "native ID",
      (doc: typeof source) => {
        row(doc).native_chain_id = "1.5";
      },
    ],
    [
      "CAIP-2",
      (doc: typeof source) => {
        row(doc).caip2 = "";
      },
    ],
    [
      "capabilities",
      (doc: typeof source) => {
        row(doc).allowed_proxy_capabilities = ["unknown"];
      },
    ],
    [
      "duplicate capabilities",
      (doc: typeof source) => {
        row(doc).allowed_proxy_capabilities = ["json-rpc", "json-rpc"];
      },
    ],
    [
      "missing probes",
      (doc: typeof source) => {
        row(doc).identity_probes = [];
      },
    ],
    [
      "probe capability",
      (doc: typeof source) => {
        row(doc).identity_probes[0].capability = "electrum";
      },
    ],
    [
      "checkpoint height",
      (doc: typeof source) => {
        row(doc).identity_probes[1].height = -1;
      },
    ],
    [
      "unknown probe",
      (doc: typeof source) => {
        row(doc).identity_probes[0].kind = "unknown";
      },
    ],
    [
      "uncovered capability",
      (doc: typeof source) => {
        row(doc).allowed_proxy_capabilities.push("electrum");
      },
    ],
  ])("rejects malformed consumed %s fields", (_name, mutate) => {
    const document = fixture();
    mutate(document);
    expect(() => projectProtocolChains(document, extensions)).toThrow(
      "Invalid protocol chain registry"
    );
  });

  it.each([
    ["143", 143],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ["9007199254740992", "9007199254740992"],
    ["9007199254740993", "9007199254740993"],
  ])("converts native ID %s without precision loss", (native, expected) => {
    const document = fixture();
    row(document).native_chain_id = native;
    const result = projectProtocolChains(document, extensions)["monad-testnet"]
      .nativeChainId;
    expect(result).toBe(expected);
    // The durable journal compares String(entry.nativeChainId), and builders consume BigInt.
    expect(String(result)).toBe(native);
    if (result === undefined) throw new Error("Missing projected native ID");
    expect(BigInt(result)).toBe(BigInt(native));
  });

  it("rejects a client wallet that reads through a capability the protocol does not permit", () => {
    const wallet = (indexer: string) => ({
      "monad-testnet": { ...extensions["monad-testnet"], wallet: { indexer, send: true } },
    });
    expect(
      projectProtocolChains(fixture(), wallet("json-rpc"))["monad-testnet"]
    ).toMatchObject({ wallet: { indexer: "json-rpc", send: true } });
    expect(() => projectProtocolChains(fixture(), wallet("electrum"))).toThrow(
      "wallet indexer not permitted for monad-testnet"
    );
  });

  it("returns isolated deeply immutable facts and client metadata without freezing inputs", () => {
    const document = fixture();
    const metadata = {
      "monad-testnet": {
        ...extensions["monad-testnet"],
        rpcUrls: ["https://public.invalid"],
        contracts: { htlc: "synthetic" },
      },
    };
    const result = projectProtocolChains(document, metadata);
    row(document).identity_probes[0].expected = "42";
    metadata["monad-testnet"].rpcUrls.push("https://changed.invalid");
    metadata["monad-testnet"].contracts.htlc = "changed";
    expect(result["monad-testnet"].identityProbes[0]).toMatchObject({
      expected: "10143",
    });
    expect(result["monad-testnet"].rpcUrls).toEqual(["https://public.invalid"]);
    expect(result["monad-testnet"].contracts.htlc).toBe("synthetic");
    expect(Object.isFrozen(document)).toBe(false);
    expect(() => {
      (result as Record<string, unknown>)["other"] = {};
    }).toThrow(TypeError);
    expect(() => {
      (result["monad-testnet"].identityProbes as unknown[]).push({});
    }).toThrow(TypeError);
    expect(() => {
      result["monad-testnet"].contracts.htlc = "other";
    }).toThrow(TypeError);
    expect(() => {
      result["monad-testnet"].rpcUrls.push("other");
    }).toThrow(TypeError);
  });
});
