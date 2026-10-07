/**
 * The topic names every fresh install starts with (ticket #365). The relay serves posts per exact
 * topic name only (`GET /message/monad/topics?topic=<name>`; an empty `topic` matches nothing), so
 * a client with no local history must still know which topics to ask for.
 */
export const DEFAULT_TOPIC_NAMES: readonly string[] = [
  'stamp',
  'news',
  'trading',
  'memes',
  'help',
  'games',
]
