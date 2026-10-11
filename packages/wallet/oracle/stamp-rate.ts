import { ORACLE_REFRESH_INTERVAL_MS } from "@frank/price-feeds";
import {
  ASSET_DECIMALS,
  type OracleRates,
  type SupportedAsset,
} from "./price-oracle";
import {
  quoteDefaultStamp,
  type StampDefaultResolver,
  type StampPolicyConfig,
} from "./stamp-policy";

/** Shared oracle freshness policy, used by valuation display and stamp default quotes. */
export const STALE_AFTER_MS = 2 * ORACLE_REFRESH_INTERVAL_MS;
export const MINING_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** A host supplies its observation owner; the pricing calculation never fetches or opens custody. */
export function createStampDefaultResolver(options: {
  chainIdentifier: string;
  asset: SupportedAsset;
  supportsDirectMessages: boolean;
  /** Actual amount unit of the configured transfer adapter, not a display-name guess. */
  baseUnitsPerCoin: bigint;
  config: StampPolicyConfig;
  getRates(): OracleRates | Promise<OracleRates>;
  now?: () => number;
}): StampDefaultResolver {
  return async (context) => {
    const units = options.baseUnitsPerCoin.toString();
    const decimals = /^10*$/.test(units) ? units.length - 1 : undefined;
    if (
      decimals !== ASSET_DECIMALS[options.asset] ||
      context.chainIdentifier !== options.chainIdentifier ||
      !options.supportsDirectMessages
    )
      return {
        status: "unavailable",
        chainIdentifier: context.chainIdentifier,
        reason: "unsupported",
      };
    if (context.minimumStamp === undefined)
      return {
        status: "unavailable",
        chainIdentifier: context.chainIdentifier,
        reason: "missing-fee",
      };
    let rates: OracleRates;
    try {
      rates = await options.getRates();
    } catch {
      return {
        status: "unavailable",
        chainIdentifier: context.chainIdentifier,
        reason: "missing-rate",
      };
    }
    const now = (options.now ?? Date.now)();
    const priceAt = rates.priceAt[options.asset];
    const hash = rates.avuHash;
    const stale = Boolean(
      rates.priceStale[options.asset] ||
        hash?.stale ||
        (priceAt !== undefined && now - priceAt * 1000 > STALE_AFTER_MS) ||
        (hash && now - hash.oldestInputAt * 1000 > MINING_STALE_AFTER_MS)
    );
    return quoteDefaultStamp({
      chainIdentifier: context.chainIdentifier,
      supportsDirectMessages: options.supportsDirectMessages,
      decimals,
      config: options.config,
      avuPerCoin: hash ? rates.rates[options.asset] : undefined,
      rateAt: priceAt,
      rateStale: stale,
      minimumStamp: context.minimumStamp,
    });
  };
}
