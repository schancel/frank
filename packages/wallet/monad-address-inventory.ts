/**
 * Unified HD Address Inventory for Monad / EVM (Ticket #924, generalized in Ticket #955).
 *
 * @deprecated Use `EvmAddressInventory` or generic `HdAddressInventory` from `./hd-address-inventory`.
 * Maintained as a backwards-compatible alias for existing Monad / EVM callers.
 */

export {
  EvmAddressInventory as MonadAddressInventory,
  type HDAddressBranch,
  type InventoryAccountRecord,
  type AccountSelectionOptions,
  type InventoryKeyringParams,
} from './hd-address-inventory'
