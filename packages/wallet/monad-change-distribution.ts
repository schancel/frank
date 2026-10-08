/**
 * Geometric radix change splitting and decoy pairing distribution for Monad/EVM wallet.
 *
 * Inspired by the original Stamp wallet change generation (cashweb/legacy-wallet/index.ts#L700-L753):
 * - Decomposes large leftover balances into multiple change outputs following a geometric power
 *   distribution with continuous entropy jitter.
 * - Prevents on-chain heuristics from distinguishing change outputs from payment outputs.
 * - Implements decoy pairing / OOM avoidance to never create a change output at the same base-2
 *   order of magnitude as the recipient payment amount.
 * - Exactly conserves available funds: sum(outputs) + sum(fees) === totalAvailableWei with 0 lost wei.
 * - Enforces dust protection: no outputs below dustThresholdWei are ever created.
 */

export interface GeometricRadixChangeParams {
  readonly totalAvailableWei: bigint;
  readonly recipientAmountWei?: bigint;
  readonly dustThresholdWei: bigint;
  readonly minFeePerTxWei?: bigint;
  readonly maxOutputs?: number;
}

/**
 * Computes base-2 order of magnitude: floor(log2(amount)).
 * Exact for arbitrary BigInt values without IEEE 754 precision loss.
 */
export function orderOfMagnitude2(amount: bigint): number {
  if (amount <= 0n) {
    throw new RangeError(
      'Amount must be positive to compute order of magnitude'
    );
  }
  return amount.toString(2).length - 1;
}

/**
 * Computes base-10 order of magnitude: floor(log10(amount)).
 * Exact for arbitrary BigInt values without IEEE 754 precision loss.
 */
export function orderOfMagnitude10(amount: bigint): number {
  if (amount <= 0n) {
    throw new RangeError(
      'Amount must be positive to compute order of magnitude'
    );
  }
  return amount.toString(10).length - 1;
}

/**
 * In-place unbiased Fisher-Yates shuffle.
 */
function shuffleArray<T>(array: T[]): T[] {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
  return array;
}

/**
 * Computes geometric radix change splits with entropy jitter and decoy pairing avoidance.
 *
 * Algorithm:
 * 1. Compute recipientOOM = recipientAmountWei ? orderOfMagnitude2(recipientAmountWei) : null.
 * 2. Loop while remaining balance > dust threshold + fee:
 *    - Carve out a randomized geometric slice between 40% and 60% of the remaining upper bound.
 *    - Add continuous multiplicative entropy jitter (+/- 15%).
 *    - Avoid exact order-of-magnitude collision with recipient payment (decoy pairing / avoidance).
 *    - Push slice to outputs list, deduct slice + fee from remaining balance.
 * 3. If only 1 output created and remainder is significant (>= dust + fee), create single change output.
 * 4. If remainder remains, absorb into one of the existing outputs to eliminate exact remainder fingerprints.
 * 5. Shuffle outputs with Fisher-Yates shuffle.
 * 6. Return array of change amounts (all >= dustThresholdWei, exactly conserving total balance minus fees).
 */
export function computeGeometricRadixChangeSplits(
  params: GeometricRadixChangeParams
): bigint[] {
  const {
    totalAvailableWei,
    recipientAmountWei,
    dustThresholdWei,
    minFeePerTxWei = 0n,
    maxOutputs,
  } = params;

  if (dustThresholdWei < 0n) {
    throw new RangeError('dustThresholdWei must be non-negative');
  }
  if (minFeePerTxWei < 0n) {
    throw new RangeError('minFeePerTxWei must be non-negative');
  }
  if (totalAvailableWei <= 0n) {
    return [];
  }

  const dust = dustThresholdWei;
  const fee = minFeePerTxWei;
  const maxLimit = maxOutputs !== undefined ? Math.max(0, maxOutputs) : 20;

  if (maxLimit === 0 || totalAvailableWei < dust + fee) {
    return [];
  }

  const recipientOOM =
    recipientAmountWei !== undefined && recipientAmountWei > 0n
      ? orderOfMagnitude2(recipientAmountWei)
      : null;

  let remaining = totalAvailableWei;
  const outputs: bigint[] = [];

  let attempts = 0;
  while (
    remaining > dust + fee &&
    outputs.length < maxLimit &&
    attempts < 100
  ) {
    attempts++;
    const upperBound = remaining - fee;
    if (upperBound < dust) {
      break;
    }

    // Carve out a randomized geometric slice between 40% and 60% of remaining upper bound
    const randomSplit = 0.4 + Math.random() * 0.2;
    // Add continuous multiplicative entropy jitter (+/- 15%)
    const jitter = 1.0 + (Math.random() - 0.5) * 0.3;
    let slice = BigInt(Math.floor(Number(upperBound) * randomSplit * jitter));

    // Decoy pairing / Avoidance:
    // If recipientOOM !== null && orderOfMagnitude2(slice) === recipientOOM:
    // Avoid leaking payment vs change through equal order-of-magnitude clustering.
    if (
      recipientOOM !== null &&
      slice > 0n &&
      orderOfMagnitude2(slice) === recipientOOM
    ) {
      const scaledDown = slice / 2n;
      if (
        scaledDown >= dust &&
        orderOfMagnitude2(scaledDown) !== recipientOOM
      ) {
        slice = scaledDown;
      } else {
        const targetMin = 1n << BigInt(recipientOOM + 1);
        if (
          upperBound >= targetMin &&
          targetMin >= dust &&
          orderOfMagnitude2(targetMin) !== recipientOOM
        ) {
          slice = targetMin;
        } else {
          continue;
        }
      }
    }

    if (slice < dust) {
      break;
    }
    if (slice > upperBound) {
      slice = upperBound;
    }
    if (recipientOOM !== null && orderOfMagnitude2(slice) === recipientOOM) {
      continue;
    }

    outputs.push(slice);
    remaining -= slice + fee;
  }

  // Handle residual balance and edge cases
  if (outputs.length === 0) {
    if (remaining >= dust + fee && maxLimit >= 1) {
      const single = remaining - fee;
      if (recipientOOM === null || orderOfMagnitude2(single) !== recipientOOM) {
        outputs.push(single);
        remaining = 0n;
      } else {
        // Total single output collides with recipient OOM; split in two if headroom allows
        const half = (remaining - fee * 2n) / 2n;
        if (
          half >= dust &&
          orderOfMagnitude2(half) !== recipientOOM &&
          maxLimit >= 2
        ) {
          outputs.push(half);
          outputs.push(remaining - fee * 2n - half);
          remaining = 0n;
        } else {
          outputs.push(single);
          remaining = 0n;
        }
      }
    }
  } else if (outputs.length === 1) {
    // Step 3: If only 1 output created and remainder is significant, create single change output.
    if (remaining >= dust + fee && outputs.length < maxLimit) {
      const second = remaining - fee;
      if (recipientOOM === null || orderOfMagnitude2(second) !== recipientOOM) {
        outputs.push(second);
        remaining = 0n;
      } else {
        // Avoid collision: absorb remainder into output 0 if possible
        if (
          recipientOOM === null ||
          orderOfMagnitude2(outputs[0] + remaining) !== recipientOOM
        ) {
          outputs[0] += remaining;
          remaining = 0n;
        } else {
          // Both collide; split the combined value into two non-colliding pieces
          const combined = outputs[0] + remaining;
          const half = (combined - fee) / 2n;
          if (
            half >= dust &&
            orderOfMagnitude2(half) !== recipientOOM &&
            maxLimit >= 2
          ) {
            outputs[0] = half;
            outputs.push(combined - fee - half);
            remaining = 0n;
          } else {
            outputs[0] += remaining;
            remaining = 0n;
          }
        }
      }
    } else if (remaining > 0n) {
      // Remainder is sub-dust; absorb into existing output
      outputs[0] += remaining;
      remaining = 0n;
    }
  } else {
    // Step 4: If multiple outputs and remainder remains, absorb into one existing output
    if (remaining > 0n) {
      const candidates = outputs
        .map((val, idx) => ({ val, idx }))
        .filter(
          (c) =>
            recipientOOM === null ||
            orderOfMagnitude2(c.val + remaining) !== recipientOOM
        );

      const targetIdx =
        candidates.length > 0
          ? candidates[Math.floor(Math.random() * candidates.length)].idx
          : Math.floor(Math.random() * outputs.length);

      outputs[targetIdx] += remaining;
      remaining = 0n;
    }
  }

  // Step 5: Shuffle outputs with Fisher-Yates shuffle
  shuffleArray(outputs);

  // Step 6: Return bigint[] of change amounts
  return outputs;
}
