import reservedLocalParts from '../../../../docs/protocol/mail/reserved-local-parts-v1.json'

const reserved = new Set<string>(reservedLocalParts)

/** Shared policy with the relay username claim boundary. */
export function isOperationalLocalPart(localPart: string): boolean {
  return reserved.has(localPart.trim().toLowerCase())
}

/** An address issuer must call this before assigning a user mailbox. */
export function assertIssuableLocalPart(localPart: string): string {
  const canonical = localPart.trim().toLowerCase()
  if (isOperationalLocalPart(canonical))
    throw new Error('This email address is reserved for mail operations')
  return canonical
}
