export function legacyLotusModeForFlag(
  skipLegacySetupGate: string | undefined,
): boolean {
  return skipLegacySetupGate === 'false'
}
