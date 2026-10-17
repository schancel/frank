import type { GroupEpochCertificate } from '@frank/cashweb/groups/types'

/**
 * Group invitation item delivered via an end-to-end encrypted 1:1 DM (Issues #70 & #1365).
 * Carries the group's public identity (`groupId`, `groupPubKey`), primary relay URL, and
 * initial epoch secret $S_e$. When received from an untrusted/unjoined peer, the group
 * conversation is quarantined in `'invited'` status until explicitly approved by the user.
 */
export interface GroupWelcomeItem {
  type: 'group-welcome'
  /** Sent only in the administrator's authenticated encrypted self-mailbox. */
  adminSecretKeyHex?: string
  epochFrame: GroupEpochCertificate
  groupId: string
  groupPubKey: string
  groupName: string
  homeRelay: string
  epoch: number
  epochSecretHex: string
  memberIndex: number
  inviterAddress?: string
}

/**
 * Group epoch transition & membership control item (Issue #70).
 */
export interface GroupControlItem {
  type: 'group-control'
  epochFrame: GroupEpochCertificate
  groupId: string
  action: 'rotate-epoch' | 'add-member' | 'remove-member' | 'leave'
  epoch: number
  prevEpochHash: string
  epochSecretHex?: string
  targetAddress?: string
  targetMemberIndex?: number
  targetEpochSigningPubKeyHex?: string
  authoritySigHex: string
}

declare module '@frank/cashweb/types/messages' {
  interface MessageItemExtensions {
    'group-welcome': GroupWelcomeItem
    'group-control': GroupControlItem
  }
}
