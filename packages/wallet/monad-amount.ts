/**
 * Human-readable MON amounts for anything a person reads (bot replies, notices, errors). Raw wei
 * is for logs and protocol fields only. Same conversion the app's `activeChain.toDisplayAmount`
 * uses (`formatEther`), so a bot and the app never disagree on how an amount looks.
 */
import { formatEther, parseEther } from 'ethers'

export function formatMon(wei: bigint): string {
  return `${formatEther(wei)} MON`
}

export function parseMon(mon: string): bigint {
  return parseEther(mon)
}
