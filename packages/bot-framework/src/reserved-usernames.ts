/**
 * The relay setting that keeps bot usernames from being taken by someone else.
 *
 * Any published account may claim any free username. So that nobody can claim `qwen` or
 * `faucet` before the bot's first start, or after the relay's database is reset, the operator
 * lists those names in the relay configuration with the one key allowed to claim each:
 *
 *   [registry.directory]
 *   network = "monad-testnet"
 *   ...
 *   reserved_usernames = { "qwen" = "02ab…", "faucet" = "03cd…" }
 *
 * The relay then answers `taken` to any other key that claims a listed name (and stops serving
 * a listed name some other key took earlier). The bot still claims its name itself at startup.
 *
 * What a launcher must do: before it starts the relay, for every bot it will run, take the
 * bot's identity key (the same key `FrankBotHost` signs the bot's directory entry with:
 * `wallet.identity.compressedPubKey`) and the bot's username (`definition.getProfile().username`,
 * or `definition.id` when the profile names none), and write the line returned by
 * `reservedUsernamesTomlLine` inside the `[registry.directory]` section of the relay's TOML,
 * next to `network` and `endpoint`. It is one line and must stay inside that section.
 */

/** One bot whose username the relay should reserve. */
export interface ReservedUsername {
  /** The bot's username: `profile.username`, or the bot's id. */
  username: string;
  /** The bot's compressed (33-byte) secp256k1 identity key. */
  compressedPubKey: Uint8Array;
}

/**
 * The `reserved_usernames = { ... }` line for the relay's `[registry.directory]` section, or
 * an empty string when there is nothing to reserve. Throws on a name the relay would refuse,
 * a key that is not a compressed secp256k1 key, or the same name twice.
 */
export function reservedUsernamesTomlLine(
  bots: readonly ReservedUsername[]
): string {
  const entries = new Map<string, string>();
  for (const bot of bots) {
    const username = bot.username.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(username))
      throw new Error(`Not a valid username to reserve: "${bot.username}"`);
    const key = Buffer.from(bot.compressedPubKey).toString("hex");
    if (!/^0[23][0-9a-f]{64}$/.test(key))
      throw new Error(`Not a compressed public key for "${username}"`);
    if (entries.has(username))
      throw new Error(`Username reserved twice: "${username}"`);
    entries.set(username, key);
  }
  if (entries.size === 0) return "";
  return `reserved_usernames = { ${[...entries]
    .map(([username, key]) => `"${username}" = "${key}"`)
    .join(", ")} }`;
}
