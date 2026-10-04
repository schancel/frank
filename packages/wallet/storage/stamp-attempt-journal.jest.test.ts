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

it('C0 retains the other exact obligation when one owner is deleted and disk is reopened', async () => {
  const fs = await import('fs')
  const os = await import('os')
  const path = await import('path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c0-attempt-owners-'))
  const attempts: OutgoingStampAttempt[] = [
    {
      payloadHashHex: 'ab'.repeat(32),
      messageBytes: [0, 255, 17],
      leaseIndices: [4, 7],
    },
    {
      payloadHashHex: 'cd'.repeat(32),
      messageBytes: [255, 0, 18],
      leaseIndices: [9, 11],
    },
  ]
  let journal = new LevelStampAttemptJournal(dir)
  let opened = false
  try {
    await journal.Open()
    opened = true
    for (const attempt of attempts) await journal.put(attempt)
    await journal.delete(attempts[0].payloadHashHex)
    await journal.Close()
    opened = false
    journal = new LevelStampAttemptJournal(dir)
    await journal.Open()
    opened = true
    expect(journal.getAll()).toEqual([attempts[1]])
    await journal.delete(attempts[0].payloadHashHex)
    expect(journal.getAll()).toEqual([attempts[1]])
  } finally {
    if (opened) await journal.Close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
