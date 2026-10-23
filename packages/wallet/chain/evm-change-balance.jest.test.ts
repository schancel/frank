import {
  fixture,
  mockBalances,
  START_BALANCE,
} from "./canonical-two-wallets.testutil";
import { evmWalletInternals } from "../evm-wallet";
jest.mock("../evm-provider", () =>
  require("./canonical-two-wallets.testutil").offlineProviderModule()
);
jest.mock("../evm-http", () =>
  require("./canonical-two-wallets.testutil").offlineHttpModule()
);
jest.mock("@frank/cashweb/relay/mailbox-client", () =>
  require("./canonical-two-wallets.testutil").offlineMailboxModule()
);
test("all six owned funded change coins contribute to balance", async () => {
  const f = await fixture();
  try {
    const state = evmWalletInternals(f.alice);
    const accounts: string[] = [];
    for (let index = 0; index < 6; index++) {
      const derived = state.material!.changeKeyring.deriveChangeAccount(index);
      const account = derived.address.toLowerCase();
      accounts.push(account);
      mockBalances.set(account, 100000000000000000n);
      await state.coinList!.put({
        account,
        nonce: 0,
        privateKey: derived.privateKey,
        valueWei: 100000000000000000n,
        origin: "change",
        changeIndex: index,
      });
    }
    const coins = state
      .coinList!.all()
      .filter((c) => accounts.includes(c.account));
    expect(coins).toHaveLength(6);
    expect(coins.every((c) => c.state === "unspent" && !c.holder)).toBe(true);
    const chainTotal = accounts.reduce(
      (sum, a) => sum + mockBalances.get(a)!,
      START_BALANCE
    );
    const reported = await f.alice.getBalance();
    expect(reported).toBe(chainTotal);
  } finally {
    await f.close();
  }
}, 30000);
