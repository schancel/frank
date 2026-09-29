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
