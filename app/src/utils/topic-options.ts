/**
 * The options offered by the New Post "Topic" select (ticket #368). The select used to open with a
 * single empty row (the typed text, still empty, was always prepended) and offered only topics
 * already present in the forum store, so a fresh user saw nothing to pick.
 *
 * - Nothing typed: every known topic, in order, never an empty row.
 * - Something typed: the typed text first (so a brand-new topic can be chosen), then the known
 *   topics that contain it.
 */
export function topicOptions(
  input: string,
  known: readonly string[],
): string[] {
  const typed = input.trim()
  const seen = new Set<string>()
  const matches: string[] = []
  for (const topic of known) {
    if (topic === '' || seen.has(topic) || !topic.includes(typed)) continue
    seen.add(topic)
    matches.push(topic)
  }
  if (typed === '') return matches
  return [typed, ...matches.filter(topic => topic !== typed)]
}
