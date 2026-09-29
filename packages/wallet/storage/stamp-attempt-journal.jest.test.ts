import {
  LevelStampAttemptJournal,
  OutgoingStampAttempt,
} from './stamp-attempt-journal'

it('persists an exact outgoing attempt across restart until deletion', async () => {
  const os = await import('os')
  const path = await import('path')
  const fs = await import('fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-attempt-journal-'))
  const attempt: OutgoingStampAttempt = {
    payloadHashHex: 'ab'.repeat(32),
    messageBytes: [1, 2, 3],
    leaseIndices: [4, 7],
    recipientPublicKeyHex: `02${'11'.repeat(32)}`,
  }
  try {
    const first = new LevelStampAttemptJournal(dir)
    await first.Open()
    await first.put(attempt)
    await first.Close()

    const reopened = new LevelStampAttemptJournal(dir)
    await reopened.Open()
    expect(reopened.getAll()).toEqual([attempt])
    await reopened.delete(attempt.payloadHashHex)
    expect(reopened.getAll()).toEqual([])
    await reopened.Close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

it('persists an incompatible-protobuf authority terminal across restart', async () => {
  const os = await import('os')
  const path = await import('path')
  const fs = await import('fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-attempt-journal-'))
  const pending: OutgoingStampAttempt = {
    payloadHashHex: 'cd'.repeat(32),
    messageBytes: [4, 5, 6],
    leaseIndices: [8],
    recipientPublicKeyHex: `02${'22'.repeat(32)}`,
    authorityState: 'pending',
  }
  const incompatible: OutgoingStampAttempt = {
    ...pending,
    authorityState: 'incompatible-protobuf',
    authorityReason: 'noncanonical_protobuf',
  }
  try {
    const first = new LevelStampAttemptJournal(dir)
    await first.Open()
    await first.put(pending)
    await first.put(incompatible)
    await first.Close()

    const reopened = new LevelStampAttemptJournal(dir)
    await reopened.Open()
    expect(reopened.getAll()).toEqual([incompatible])
    await expect(reopened.put(pending)).rejects.toThrow(/move backward/i)
    expect(reopened.getAll()).toEqual([incompatible])
    await reopened.Close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
