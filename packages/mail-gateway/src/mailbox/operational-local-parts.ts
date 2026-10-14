import reservedLocalParts from '../../../../docs/protocol/mail/reserved-local-parts-v1.json'

const reserved = new Set<string>(reservedLocalParts)
const operatorContact = new Set<string>(['help', 'info', 'contact'])

/** Shared policy with the relay username claim boundary. */
export function isOperationalLocalPart(localPart: string): boolean {
  return reserved.has(localPart.trim().toLowerCase())
}

/** Additional operator contact aliases that route to the operator when unclaimed by a user. */
export function isOperatorContactLocalPart(localPart: string): boolean {
  return operatorContact.has(localPart.trim().toLowerCase())
}

/** True when a local-part is an operational or operator-contact mailbox. */
export function isOperatorMailboxLocalPart(localPart: string): boolean {
  const canonical = localPart.trim().toLowerCase()
  return reserved.has(canonical) || operatorContact.has(canonical)
}

/** An address issuer must call this before assigning a user mailbox. */
export function assertIssuableLocalPart(localPart: string): string {
  const canonical = localPart.trim().toLowerCase()
  if (isOperationalLocalPart(canonical))
    throw new Error('This email address is reserved for mail operations')
  return canonical
}
