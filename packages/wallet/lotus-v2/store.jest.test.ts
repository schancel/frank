/**
 * The Lotus v2 wallet's browser record: one key per chain, regtest run (checkpoint block) and
 * account; a stage 1-2 (`v1`) record of the same account is refused with the reset.
 */
import { browserLotusV2WalletStore, LOTUS_V2_STORE_RESET, lotusV2StoreKey } from "./wallet";

const params = {
  chainIdentifier: "lotus-v2-regtest",
  checkpointHash: "ab".repeat(32),
  firstAddress: "rxpi1pexample",
};

describe("browserLotusV2WalletStore", () => {
  const storage = new Map<string, string>();
  beforeAll(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    };
  });
  afterAll(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  beforeEach(() => storage.clear());

  it("names the record by chain, run checkpoint and first address under the v2 prefix", () => {
    expect(lotusV2StoreKey(params)).toBe(
      `frank:lotus-v2-wallet:v2:lotus-v2-regtest:${"ab".repeat(32)}:rxpi1pexample`
    );
    const store = browserLotusV2WalletStore(params);
    store.save("{}");
    expect(storage.get(lotusV2StoreKey(params))).toBe("{}");
    expect(store.load()).toBe("{}");
    // Another run of the chain is another record.
    expect(browserLotusV2WalletStore({ ...params, checkpointHash: "cd".repeat(32) }).load()).toBeUndefined();
  });

  it("refuses to open while a stage 1-2 record of the same account exists", () => {
    storage.set("frank:lotus-v2-wallet:v1:lotus-v2-regtest:rxpi1pexample", "{}");
    expect(() => browserLotusV2WalletStore(params).load()).toThrow(LOTUS_V2_STORE_RESET);
    // Another account's old record is not this account's concern.
    expect(browserLotusV2WalletStore({ ...params, firstAddress: "rxpi1pother" }).load()).toBeUndefined();
  });
});
