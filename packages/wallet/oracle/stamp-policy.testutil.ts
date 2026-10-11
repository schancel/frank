import type { StampDefaultResolver } from "./stamp-policy";

/** Unit-only resolver seam: an explicit native recipient target, without a simulated feed. */
export function fixedStampDefault(targetAmount: bigint): StampDefaultResolver {
  return async ({ chainIdentifier, minimumStamp = 0n }) => ({
    status: "available",
    chainIdentifier,
    amount: targetAmount > minimumStamp ? targetAmount : minimumStamp,
    targetAmount,
    minimumStamp,
    rateAt: 1,
  });
}
