import { readViteEnv } from "./vite-env";

/** Primary RPC network composition shared by wallet and standalone extension hosts. */
export function primaryRpcChainFromEnv(overrides?: {
  isTestnet?: boolean;
}): string {
  if (overrides?.isTestnet !== undefined) {
    return overrides.isTestnet ? "monad-testnet" : "monad-mainnet";
  }
  return (
    readViteEnv("QCLI_MONAD_RPC_CHAIN") ??
    (typeof process !== "undefined"
      ? process.env.MONAD_RPC_CHAIN
      : undefined) ??
    "monad-testnet"
  );
}
