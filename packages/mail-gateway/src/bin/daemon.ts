#!/usr/bin/env node

/**
 * The old executable supplied a fake stamp provider, accepted incoming mail,
 * and reported invented payment hashes without opening a Frank wallet. Keeping
 * that executable runnable would make a deployment claim mail delivery while
 * silently discarding the funded operation. The real host will own wallet
 * restoration, the journal, and transport before it starts listeners.
 */
throw new Error(
  'The mail gateway has no production host yet. Its previous executable used fake stamps and did not start the Frank mailbox listener. Configure the wallet, durable mail journal, and verified mail transport before enabling this service.'
);
