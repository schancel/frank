/**
 * The payment floor: the least value worth putting in a coin someone must move again. A stamp
 * payment, a payout and a change output below it would cost its owner more than a tenth of
 * itself to move, so the wallet never creates one, and a received coin below it is shown as too
 * small to move rather than counted as spendable.
 *
 * The factor has one source, `payment_floor_multiple` in `docs/protocol/chains/v1.json`; the
 * relay reads the same field (`cashweb_config::protocol_payment_floor_wei`). Here it is applied
 * to the node's live gas price; the relay applies it to the network's minimum gas price, which
 * is never more, so a payment at the wallet's floor always passes the relay's.
 */
import protocolChains from "../../../docs/protocol/chains/v1.json";
import { projectPaymentFloorMultiple } from "./protocol-chain-registry";

/** How many plain transfers' fees a payment must be worth, from the protocol registry. */
export const PAYMENT_FLOOR_MULTIPLE: bigint =
  projectPaymentFloorMultiple(protocolChains);

/** Gas of one plain EVM value transfer: what moving a received coin costs. */
export const EVM_TRANSFER_GAS = 21_000n;

/** The EVM payment floor at `gasPriceWei` per gas. */
export function evmPaymentFloorWei(gasPriceWei: bigint): bigint {
  if (gasPriceWei < 0n) throw new RangeError("Gas price must be nonnegative");
  return PAYMENT_FLOOR_MULTIPLE * EVM_TRANSFER_GAS * gasPriceWei;
}
