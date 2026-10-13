import {
  bytesToHex,
  computeGroupIdFromPubKey,
  decryptGroupRoster,
  deriveEpochKeys,
  deriveGroupIdentity,
  deriveMemberEpochSigningKey,
  encryptGroupRoster,
  formatGroupIdentifier,
  groupConversationUuid,
  isGroupIdentifier,
  openGroupMessage,
  parseGroupIdentifier,
  sealGroupMessage,
  signEpochFrame,
  verifyEpochFrame,
} from './group-crypto'
import type { GroupRoster } from './group-crypto'

function seedOf(byte: number): Uint8Array {
  const buf = new Uint8Array(32)
  buf.fill(byte)
  return buf
}

describe('packages/cashweb/groups/group-crypto', () => {
  test('derives deterministic group identity and group:<hex(group_id)> address', () => {
    const seed = seedOf(0x11)
    const id1 = deriveGroupIdentity(seed)
    const id2 = deriveGroupIdentity(seed)

    expect(id1.groupPubKey.length).toBe(33)
    expect(id1.groupIdHex).toHaveLength(64)
    expect(id1.groupIdHex).toBe(id2.groupIdHex)
    expect(id1.groupIdHex).toBe(computeGroupIdFromPubKey(id1.groupPubKeyHex))
    expect(id1.groupIdentifier).toBe(`group:${id1.groupIdHex}`)
    expect(isGroupIdentifier(id1.groupIdentifier)).toBe(true)
    expect(parseGroupIdentifier(id1.groupIdentifier)).toBe(id1.groupIdHex)
    expect(isGroupIdentifier('group:not-a-hex')).toBe(false)
    expect(id1.conversationId).toBe(groupConversationUuid(id1.groupIdHex))
    expect(id1.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  test('derives distinct epoch keys and rotates member ephemeral signing keys per epoch', () => {
    const group = deriveGroupIdentity(seedOf(0x21))
    const epoch0Secret = seedOf(0x30)
    const epoch1Secret = seedOf(0x31)

    const keys0 = deriveEpochKeys(epoch0Secret, group.groupIdHex, 0)
    const keys1 = deriveEpochKeys(epoch1Secret, group.groupIdHex, 1)

    expect(keys0.encryptionKeyHex).not.toBe(keys1.encryptionKeyHex)
    expect(keys0.writeKeyPair.publicKeyHex).not.toBe(
      keys1.writeKeyPair.publicKeyHex,
    )
    expect(keys0.readTokenHex).not.toBe(keys1.readTokenHex)
    expect(keys0.readTokenHashHex).not.toBe(keys1.readTokenHashHex)

    const aliceSeed = seedOf(0x41)
    const aliceEpoch0 = deriveMemberEpochSigningKey(
      aliceSeed,
      group.groupIdHex,
      0,
    )
    const aliceEpoch1 = deriveMemberEpochSigningKey(
      aliceSeed,
      group.groupIdHex,
      1,
    )
    expect(aliceEpoch0.publicKeyHex).not.toBe(aliceEpoch1.publicKeyHex)
  })

  test('encrypts and decrypts group roster and signs/verifies epoch frames', () => {
    const group = deriveGroupIdentity(seedOf(0x51))
    const epochKeys0 = deriveEpochKeys(seedOf(0x52), group.groupIdHex, 0)
    const aliceSig0 = deriveMemberEpochSigningKey(
      seedOf(0x61),
      group.groupIdHex,
      0,
    )
    const bobSig0 = deriveMemberEpochSigningKey(
      seedOf(0x62),
      group.groupIdHex,
      0,
    )

    const roster: GroupRoster = {
      epoch: 0,
      groupName: 'Protocol Architects',
      homeRelay: 'https://relay-a.frank.example',
      members: [
        {
          index: 0,
          address: 'eip155:10143:0x1111111111111111111111111111111111111111',
          epochSigningPubKeyHex: aliceSig0.publicKeyHex,
          role: 'admin',
        },
        {
          index: 1,
          address: 'eip155:10143:0x2222222222222222222222222222222222222222',
          epochSigningPubKeyHex: bobSig0.publicKeyHex,
          role: 'member',
        },
      ],
    }

    const encryptedRoster = encryptGroupRoster(roster, epochKeys0)
    const decryptedRoster = decryptGroupRoster(encryptedRoster, epochKeys0)
    expect(decryptedRoster).toEqual(roster)

    // Wrong epoch keys cannot decrypt the roster
    const wrongEpochKeys = deriveEpochKeys(seedOf(0x99), group.groupIdHex, 0)
    expect(() => decryptGroupRoster(encryptedRoster, wrongEpochKeys)).toThrow()

    // Sign and verify genesis epoch frame under k_G
    const frame0 = signEpochFrame({
      groupIdHex: group.groupIdHex,
      groupPubKeyHex: group.groupPubKeyHex,
      epoch: 0,
      epochKeys: epochKeys0,
      encryptedRoster,
      authorityPrivateKey: group.groupSecretKey,
    })
    expect(
      verifyEpochFrame(frame0, group.groupIdHex, group.groupPubKeyHex),
    ).toBe(true)
    expect(
      verifyEpochFrame(
        frame0,
        group.groupIdHex,
        wrongEpochKeys.writeKeyPair.publicKeyHex,
      ),
    ).toBe(false)
  })

  test('seals and opens group messages with outer W_{G,e} write_sig and inner S_{i,e} member attribution', () => {
    const group = deriveGroupIdentity(seedOf(0x71))
    const epochKeys = deriveEpochKeys(seedOf(0x72), group.groupIdHex, 3)
    const aliceSig = deriveMemberEpochSigningKey(
      seedOf(0x81),
      group.groupIdHex,
      3,
    )
    const bobSig = deriveMemberEpochSigningKey(
      seedOf(0x82),
      group.groupIdHex,
      3,
    )
    const mallorySig = deriveMemberEpochSigningKey(
      seedOf(0x83),
      group.groupIdHex,
      3,
    )

    const roster: GroupRoster = {
      epoch: 3,
      groupName: 'Shared Mailbox Group',
      homeRelay: 'https://relay-a.frank.example',
      members: [
        {
          index: 0,
          address: 'eip155:10143:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          epochSigningPubKeyHex: aliceSig.publicKeyHex,
          role: 'admin',
        },
        {
          index: 1,
          address: 'eip155:10143:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          epochSigningPubKeyHex: bobSig.publicKeyHex,
          role: 'member',
        },
      ],
    }

    const envelope = sealGroupMessage({
      epochKeys,
      senderIndex: 1,
      senderEpochKeyPair: bobSig,
      payload: 'Hello group from Bob!',
      timestampMs: 1700000123456,
    })

    // Outer envelope exposes only epoch, nonce, ciphertext, write_sig — zero user identity
    expect(Object.keys(envelope).sort()).toEqual([
      'ciphertext',
      'epoch',
      'nonce',
      'write_sig',
    ])

    const opened = openGroupMessage({
      envelope,
      epochKeys,
      roster,
    })
    expect(opened.groupId).toBe(group.groupIdHex)
    expect(opened.epoch).toBe(3)
    expect(opened.senderIndex).toBe(1)
    expect(opened.senderEpochPubKeyHex).toBe(bobSig.publicKeyHex)
    expect(opened.senderAddress).toBe(
      'eip155:10143:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    )
    expect(opened.payloadText).toBe('Hello group from Bob!')
    expect(opened.timestampMs).toBe(1700000123456)

    // Impersonation attempt: Mallory knows epochKeys (e.g. compromised shared epoch key)
    // and tries to send claiming Bob's senderIndex (1) signed with Mallory's key
    const impersonatedEnvelope = sealGroupMessage({
      epochKeys,
      senderIndex: 1,
      senderEpochKeyPair: mallorySig,
      payload: 'Forged as Bob',
    })
    expect(() =>
      openGroupMessage({
        envelope: impersonatedEnvelope,
        epochKeys,
        roster,
      }),
    ).toThrow(/Sender epoch pubkey mismatch/)

    // Tampered outer write_sig is rejected
    const badOuterEnvelope = {
      ...envelope,
      write_sig: bytesToHex(new Uint8Array(64).fill(0x42)),
    }
    expect(() =>
      openGroupMessage({
        envelope: badOuterEnvelope,
        epochKeys,
        roster,
      }),
    ).toThrow()
  })
})
