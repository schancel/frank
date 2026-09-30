/** `0x12ab...9f`-style abbreviation for showing a recipient next to its name. */
export function shortAddress(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 6)}...${address.slice(-4)}`
    : address
}
