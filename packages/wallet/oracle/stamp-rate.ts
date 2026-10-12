import { miningFeeCoverage } from "./energy-basket";
import { ORACLE_REFRESH_INTERVAL_MS } from "@frank/price-feeds";
import {
  ASSET_DECIMALS,
  type OracleRates,
  type SupportedAsset,
} from "./price-oracle";
import {
  quoteDefaultStamp,
  type DefaultStampQuote,
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
  /** Host-configured native base units used only until a fresh AVU quote exists. */
  fallbackStamp?: bigint;
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
    if (context.minimumStamp === undefined || context.minimumStamp < 0n)
      return {
        status: "unavailable",
        chainIdentifier: context.chainIdentifier,
        reason: "missing-fee",
      };
    const minimumStamp = context.minimumStamp;
    const withFallback = (quote: DefaultStampQuote): DefaultStampQuote => {
      const fixed = options.fallbackStamp;
      if (
        quote.status !== "unavailable" ||
        (quote.reason !== "missing-rate" && quote.reason !== "stale-rate") ||
        fixed === undefined ||
        fixed <= 0n
      )
        return quote;
      return {
        status: "available",
        chainIdentifier: context.chainIdentifier,
        amount: fixed > minimumStamp ? fixed : minimumStamp,
        targetAmount: fixed,
        minimumStamp,
        pricingBasis: "configured-fallback",
      };
    };
    let rates: OracleRates;
    try {
      rates = await options.getRates();
    } catch {
      return withFallback({
        status: "unavailable",
        chainIdentifier: context.chainIdentifier,
        reason: "missing-rate",
      });
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
    return withFallback(
      quoteDefaultStamp({
        chainIdentifier: context.chainIdentifier,
        supportsDirectMessages: options.supportsDirectMessages,
        decimals,
        config: options.config,
        avuPerCoin: hash ? rates.rates[options.asset] : undefined,
        rateAt: priceAt,
        rateFeeCoverage: hash ? miningFeeCoverage(hash) : undefined,
        rateStale: stale,
        minimumStamp: context.minimumStamp,
      })
    );
  };
}
