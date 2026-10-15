import { InMemoryEcashOperationStore } from "./ecash-operation-store";
import {
  ECASH_MAINNET_CHECKPOINT_HASH,
  ECASH_TESTNET_CHECKPOINT_HEIGHT,
  ECASH_TESTNET_CHECKPOINT_HASH,
  EcashWallet,
  EcashWalletBackend,
} from "./ecash-wallet";
import { InMemoryNativeTransactionAttemptStore } from "./chain/chain-wallet";
import type { ChronikClient } from "chronik-client";
import { Address } from "ecash-lib/dist/address/address";
import type { DomainRoot } from "../domain-roots/src";

const ADDRESS = "ecash:qq86jv6h0y97q8l63ndynvk3fn9aq8fqru3exew8gl";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ROOT: DomainRoot<"ecash-bch-wallet"> = {
  registry: "frank-domain-roots-v1",
  purpose: "ecash-bch-wallet",
  bytes: new Uint8Array(32).fill(1),
};

function makeChronik(): ChronikClient {
  return {
    block: jest.fn().mockResolvedValue({
      blockInfo: { hash: ECASH_MAINNET_CHECKPOINT_HASH },
    }),
  } as unknown as ChronikClient;
}

function makeBackend(receiveAddress: string = ADDRESS): EcashWalletBackend & {
  sync: jest.Mock;
  syncAndDiscoverAddresses: jest.Mock;
} {
  return {
    balanceSats: 12_345n,
    receiveIndex: 3,
    sync: jest.fn().mockResolvedValue(undefined),
    syncAndDiscoverAddresses: jest.fn().mockResolvedValue(undefined),
    getReceiveAddress: jest.fn(() => receiveAddress),
  };
}

describe("EcashWallet", () => {
  let nativeAttemptStore: InMemoryNativeTransactionAttemptStore;

  beforeEach(() => {
    nativeAttemptStore = new InMemoryNativeTransactionAttemptStore();
  });

  it.each([
    null,
    { ...ROOT, purpose: "evm-wallet" },
    { ...ROOT, registry: "frank-domain-roots-v2" },
    { ...ROOT, bytes: new Uint8Array(31) },
    { ...ROOT, bytes: new Uint8Array(33) },
    { ...ROOT, bytes: Array(32).fill(1) },
    { mnemonic: MNEMONIC },
  ])(
    "rejects invalid typed roots before endpoint, backend or journal effects (%#)",
    async (root) => {
      const chronik = makeChronik();
      const factory = jest.fn(() => makeBackend());
      const journalRead = jest.spyOn(nativeAttemptStore, "get");
      await expect(
        EcashWallet.fromDomainRoot({
          operationStore: new InMemoryEcashOperationStore(),
          domainRoot: root as DomainRoot<"ecash-bch-wallet">,
          chronik,
          networkId: "ecash-mainnet",
          nativeAttemptStore,
          walletFactory: factory,
        })
      ).rejects.toThrow(
        "Expected a frank-domain-roots-v1 ecash-bch-wallet root of exactly 32 bytes"
      );
      expect(chronik.block).not.toHaveBeenCalled();
      expect(factory).not.toHaveBeenCalled();
      expect(journalRead).not.toHaveBeenCalled();
    }
  );

  it("snapshots root bytes before awaiting the checkpoint and clears only its owned copy", async () => {
    const root = { ...ROOT, bytes: Uint8Array.from(ROOT.bytes) };
    const expected = Uint8Array.from(root.bytes);
    const chronik = makeChronik();
    let release!: () => void;
    jest.spyOn(chronik, "block").mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { blockInfo: { hash: ECASH_MAINNET_CHECKPOINT_HASH } } as Awaited<
        ReturnType<ChronikClient["block"]>
      >;
    });
    let received: Uint8Array | undefined;
    const constructing = EcashWallet.fromDomainRoot({
      operationStore: new InMemoryEcashOperationStore(),
      domainRoot: root,
      chronik,
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: ({ domainRoot }) => {
        expect(domainRoot.bytes).toEqual(expected);
        expect(domainRoot.bytes).not.toBe(root.bytes);
        received = domainRoot.bytes;
        return makeBackend();
      },
    });
    root.bytes.fill(9);
    release();
    await constructing;
    expect(received).toEqual(new Uint8Array(32));
    expect(root.bytes).toEqual(new Uint8Array(32).fill(9));
  });

  it("exposes identity and a freshly synced bigint balance", async () => {
    const backend = makeBackend();
    const wallet = await EcashWallet.fromDomainRoot({
      operationStore: new InMemoryEcashOperationStore(),
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });

    expect(wallet.identity).toEqual({
      address: { raw: ADDRESS },
      displayAddress: ADDRESS,
    });
    await expect(wallet.getReceiveAddress()).resolves.toEqual({ raw: ADDRESS });
    expect(backend.getReceiveAddress).toHaveBeenCalledWith(3);
    await expect(wallet.getBalance()).resolves.toBe(12_345n);
    expect(backend.syncAndDiscoverAddresses).toHaveBeenCalledTimes(2);
    expect(backend.sync).toHaveBeenCalledTimes(1);
  });

  it("does not consume HD indices when the receive address is displayed repeatedly", async () => {
    const backend = makeBackend();
    const wallet = await EcashWallet.fromDomainRoot({
      operationStore: new InMemoryEcashOperationStore(),
      domainRoot: ROOT,
      chronik: makeChronik(),
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: () => backend,
    });

    const addresses = await Promise.all(
      Array.from({ length: 21 }, () => wallet.getReceiveAddress())
    );

    expect(new Set(addresses.map((address) => address.raw))).toEqual(
      new Set([ADDRESS])
    );
    expect(backend.getReceiveAddress).toHaveBeenCalledTimes(22);
    expect(backend.getReceiveAddress).toHaveBeenCalledWith(0);
    expect(backend.getReceiveAddress).toHaveBeenCalledWith(3);
  });

  it("rejects a Chronik endpoint that lacks the eCash mainnet checkpoint", async () => {
    const chronik = makeChronik();
    jest.spyOn(chronik, "block").mockResolvedValueOnce({
      blockInfo: { hash: "a-bch-block-at-the-same-height" },
    } as Awaited<ReturnType<ChronikClient["block"]>>);

    await expect(
      EcashWallet.fromDomainRoot({
        operationStore: new InMemoryEcashOperationStore(),
        domainRoot: ROOT,
        chronik,
        networkId: "xec-mainnet",
        nativeAttemptStore,
        walletFactory: () => makeBackend(),
      })
    ).rejects.toThrow("eCash Chronik checkpoint mismatch");
  });

  it("verifies and rejects a testnet Chronik endpoint based on ECASH_TESTNET_CHECKPOINT", async () => {
    const chronik = makeChronik();
    const blockSpy = jest.spyOn(chronik, "block").mockResolvedValueOnce({
      blockInfo: { hash: "wrong-testnet-hash" },
    } as Awaited<ReturnType<ChronikClient["block"]>>);

    await expect(
      EcashWallet.fromDomainRoot({
        operationStore: new InMemoryEcashOperationStore(),
        domainRoot: ROOT,
        chronik,
        networkId: "xec-testnet",
        nativeAttemptStore,
        walletFactory: () => makeBackend(),
      })
    ).rejects.toThrow("eCash Chronik checkpoint mismatch");
    expect(blockSpy).toHaveBeenCalledWith(ECASH_TESTNET_CHECKPOINT_HEIGHT);

    // Now with valid testnet checkpoint hash
    blockSpy.mockResolvedValueOnce({
      blockInfo: { hash: ECASH_TESTNET_CHECKPOINT_HASH },
    } as Awaited<ReturnType<ChronikClient["block"]>>);

    const wallet = await EcashWallet.fromDomainRoot({
      operationStore: new InMemoryEcashOperationStore(),
      domainRoot: ROOT,
      chronik,
      networkId: "xec-testnet",
      nativeAttemptStore,
      walletFactory: () =>
        makeBackend("ectest:qq86jv6h0y97q8l63ndynvk3fn9aq8fqruhjcef2tw"),
    });
    expect(wallet.networkId).toBe("xec-testnet");
  });

  it("rejects an unverified fallback in a multi-endpoint Chronik client", async () => {
    const chronik = {
      proxyInterface: () => ({
        getEndpointArray: () => [
          { url: "https://xec.example" },
          { url: "https://bch.example" },
        ],
      }),
    } as unknown as ChronikClient;
    const walletFactory = jest.fn(() => makeBackend());

    await expect(
      EcashWallet.fromDomainRoot({
        operationStore: new InMemoryEcashOperationStore(),
        domainRoot: ROOT,
        chronik,
        networkId: "ecash-mainnet",
        nativeAttemptStore,
        walletFactory,
        checkpointClientFactory: (url) => ({
          block: jest.fn().mockResolvedValue({
            blockInfo: {
              hash:
                url === "https://xec.example"
                  ? ECASH_MAINNET_CHECKPOINT_HASH
                  : "bch-checkpoint",
            },
          }),
        }),
      })
    ).rejects.toThrow("checkpoint mismatch for https://bch.example");
    expect(walletFactory).not.toHaveBeenCalled();
  });

  it("rejects the legacy Chronik client shape before creating the SDK wallet", async () => {
    const legacyChronik = makeChronik() as ChronikClient & {
      proxyInterface?: unknown;
    };
    legacyChronik.proxyInterface = undefined;

    await expect(
      EcashWallet.fromDomainRoot({
        operationStore: new InMemoryEcashOperationStore(),
        domainRoot: ROOT,
        chronik: legacyChronik,
        networkId: "ecash-mainnet",
        nativeAttemptStore,
      })
    ).rejects.toThrow("requires chronik-client 4.3 or newer");
  });

  it("rejects unsupported mnemonic passphrases explicitly", async () => {
    const factory = jest.fn(() => makeBackend());
    await expect(
      EcashWallet.fromLegacyMnemonic({
        operationStore: new InMemoryEcashOperationStore(),
        mnemonic: MNEMONIC,
        passphrase: "secret",
        chronik: makeChronik(),
        networkId: "ecash-mainnet",
        nativeAttemptStore,
        walletFactory: factory,
      })
    ).rejects.toThrow("does not support BIP-39 passphrases");
    expect(factory).not.toHaveBeenCalled();
  });

  it("keeps mnemonic import behind the explicitly named legacy constructor", async () => {
    const factory = jest.fn(() => makeBackend());
    const chronik = makeChronik();
    const wallet = await EcashWallet.fromLegacyMnemonic({
      operationStore: new InMemoryEcashOperationStore(),
      mnemonic: MNEMONIC,
      chronik,
      networkId: "ecash-mainnet",
      nativeAttemptStore,
      walletFactory: factory,
    });
    expect(factory).toHaveBeenCalledWith({
      mnemonic: MNEMONIC,
      chronik,
      addressPrefix: "ecash",
    });
    expect(wallet.identity.address.raw).toBe(ADDRESS);
  });

  it("rejects malformed recovery phrases before constructing a backend", async () => {
    const factory = jest.fn(() => makeBackend());
    await expect(
      EcashWallet.fromLegacyMnemonic({
        operationStore: new InMemoryEcashOperationStore(),
        mnemonic: "not a valid BIP-39 mnemonic",
        chronik: makeChronik(),
        networkId: "ecash-mainnet",
        nativeAttemptStore,
        walletFactory: factory,
      })
    ).rejects.toThrow("Invalid BIP-39 mnemonic");
    expect(factory).not.toHaveBeenCalled();
  });

  it("asks the backend for testnet addresses on the testnet", async () => {
    const chronik = makeChronik();
    jest.spyOn(chronik, "block").mockResolvedValue({
      blockInfo: { hash: ECASH_TESTNET_CHECKPOINT_HASH },
    } as Awaited<ReturnType<ChronikClient["block"]>>);
    const factory = jest.fn(() =>
      makeBackend(
        Address.fromCashAddress(ADDRESS).withPrefix("ectest").toString()
      )
    );
    await EcashWallet.fromDomainRoot({
      operationStore: new InMemoryEcashOperationStore(),
      domainRoot: ROOT,
      chronik,
      networkId: "xec-testnet",
      nativeAttemptStore,
      walletFactory: factory,
    });
    const wallet = await EcashWallet.fromDomainRoot({
      operationStore: new InMemoryEcashOperationStore(),
      domainRoot: ROOT,
      chronik,
      networkId: "xec-testnet",
      nativeAttemptStore,
      walletFactory: factory,
    });
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ addressPrefix: "ectest" })
    );
    // The Send page compares this with the chain it reviewed.
    expect(wallet.chainIdentifier).toBe("xec-testnet");
    expect(wallet.networkId).toBe("xec-testnet");
  });

  describe("on a regtest network", () => {
    const checkpoint = { height: 1, hash: "ab".repeat(32) };
    const regtestAddress = Address.fromCashAddress(ADDRESS)
      .withPrefix("ecregtest")
      .toString();
    const open = (
      chronik: ChronikClient,
      given?: { height: number; hash: string }
    ) =>
      EcashWallet.fromDomainRoot({
        operationStore: new InMemoryEcashOperationStore(),
        domainRoot: ROOT,
        chronik,
        networkId: "xec-regtest",
        checkpoint: given,
        nativeAttemptStore,
        walletFactory: () => makeBackend(regtestAddress),
      });
    const chronikWith = (hash: string) => {
      const chronik = makeChronik();
      jest.spyOn(chronik, "block").mockResolvedValue({
        blockInfo: { hash },
      } as Awaited<ReturnType<ChronikClient["block"]>>);
      return chronik;
    };

    it("opens on the node that has the given checkpoint block, with regtest addresses", async () => {
      const chronik = chronikWith(checkpoint.hash);
      const wallet = await open(chronik, checkpoint);
      expect(chronik.block).toHaveBeenCalledWith(1);
      expect(wallet.chainIdentifier).toBe("xec-regtest");
      expect(wallet.identity.address.raw).toBe(regtestAddress);
      await expect(
        wallet.sendNative({ recipient: { raw: ADDRESS }, value: 1n })
      ).rejects.toThrow("Invalid eCash recipient for the configured network");
    });

    it("is refused without a checkpoint and on a node that has another block there", async () => {
      await expect(open(chronikWith(checkpoint.hash))).rejects.toThrow(
        "xec-regtest needs the checkpoint block"
      );
      await expect(
        open(chronikWith(checkpoint.hash), { height: 0, hash: checkpoint.hash })
      ).rejects.toThrow("xec-regtest needs the checkpoint block");
      await expect(
        open(chronikWith("cd".repeat(32)), checkpoint)
      ).rejects.toThrow("eCash Chronik checkpoint mismatch");
    });

    it("does not let a public network take a checkpoint from its caller", async () => {
      await expect(
        EcashWallet.fromDomainRoot({
          operationStore: new InMemoryEcashOperationStore(),
          domainRoot: ROOT,
          chronik: chronikWith(checkpoint.hash),
          networkId: "xec-mainnet",
          checkpoint,
          nativeAttemptStore,
          walletFactory: () => makeBackend(),
        })
      ).rejects.toThrow("The checkpoint of xec-mainnet is fixed");
    });
  });
});
