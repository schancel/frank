import { ElectrumClient, ElectrumRpcError } from "./electrum-client";
import { electrumIndexer } from "./electrum-indexer";
import { UtxoBroadcastRefused } from "../utxo-wallet";

/** An indexer over a client whose every request fails with `error`. */
function failing(error: Error) {
  const client = {
    request: jest.fn().mockRejectedValue(error),
    broadcastTransaction: jest.fn().mockRejectedValue(error),
  } as unknown as ElectrumClient;
  return electrumIndexer(client);
}
const rpc = (code: number | undefined, message: string) =>
  new ElectrumRpcError("blockchain.transaction.broadcast", message, code);

describe("who answered decides what an Electrum error means", () => {
  it("treats only the node's own refusal as 'not broadcast', with its reason", async () => {
    const error = await failing(rpc(-32000, "bad-txns-inputs-missingorspent"))
      .broadcast("00")
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(UtxoBroadcastRefused);
    expect(error.reason).toBe("bad-txns-inputs-missingorspent");
  });

  it.each([
    rpc(-32005, "hourly quota exceeded"),
    rpc(-32005, "relay busy"),
    rpc(-32005, "pending request limit exceeded"),
    rpc(-32003, "no Electrum upstream available"),
    rpc(-32001, "upstream RPC error"),
    rpc(undefined, "something"),
    new Error("Electrum request timed out after 30000ms"),
  ])("leaves a broadcast's outcome unknown on %s", async (error) => {
    const outcome = await failing(error).broadcast("00").catch((caught) => caught);
    expect(outcome).toBe(error);
    expect(outcome).not.toBeInstanceOf(UtxoBroadcastRefused);
  });

  it("says a transaction is unknown only when the Electrum server answered so", async () => {
    await expect(
      failing(rpc(-32001, "upstream RPC error")).hasTransaction("ab")
    ).resolves.toBe(false);
    for (const error of [
      rpc(-32005, "hourly quota exceeded"),
      rpc(-32003, "no Electrum upstream available"),
      new Error("socket closed"),
    ]) {
      await expect(failing(error).hasTransaction("ab")).rejects.toBe(error);
    }
  });
});
