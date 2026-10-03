// Explicit legacy-import boundary; loaded only by EcashWallet.fromLegacyMnemonic.
import * as bip39 from "bip39";
import type { ChronikClient } from "chronik-client";
import type {
  EcashAddressPrefix,
  EcashWalletBackend,
  EcashWalletOptions,
} from "./ecash-wallet";

export interface LegacyEcashSeedOptions {
  mnemonic: string;
  passphrase?: string;
  walletFactory?: (params: {
    mnemonic: string;
    chronik: ChronikClient;
    addressPrefix: EcashAddressPrefix;
  }) => EcashWalletBackend | Promise<EcashWalletBackend>;
}

export function legacyEcashBackendFactory(
  params: EcashWalletOptions & LegacyEcashSeedOptions
) {
  if (params.passphrase !== undefined && params.passphrase.length > 0) {
    throw new Error(
      "The eCash wallet backend does not support BIP-39 passphrases"
    );
  }
  if (!bip39.validateMnemonic(params.mnemonic))
    throw new Error("Invalid BIP-39 mnemonic");
  return async (): Promise<EcashWalletBackend> => {
    if (params.walletFactory)
      return params.walletFactory({
        mnemonic: params.mnemonic,
        chronik: params.chronik,
        addressPrefix: "ecash",
      });
    const imported = await import("ecash-wallet/dist/index.js");
    const sdk = imported as unknown as {
      Wallet?: unknown;
      default?: { Wallet?: unknown };
    };
    const Wallet = (sdk.Wallet ?? sdk.default?.Wallet) as
      | {
          fromMnemonic(
            mnemonic: string,
            chronik: ChronikClient,
            options: { hd: true; prefix: EcashAddressPrefix }
          ): EcashWalletBackend;
        }
      | undefined;
    if (Wallet === undefined)
      throw new Error("ecash-wallet did not export Wallet");
    return Wallet.fromMnemonic(params.mnemonic, params.chronik, {
      hd: true,
      prefix: "ecash",
    });
  };
}
