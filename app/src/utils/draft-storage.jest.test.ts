/** @jest-environment jsdom */
import {
  clearChatDraft,
  clearForumPostDraft,
  loadChatDraft,
  loadForumPostDraft,
  loadTopicDraft,
  saveChatDraft,
  saveForumPostDraft,
  saveTopicDraft,
} from './draft-storage'

describe('draft-storage', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('persists, restores, and clears per-conversation chat drafts', () => {
    expect(loadChatDraft('0xAbCd')).toBeNull()

    saveChatDraft('0xAbCd', {
      message: 'Hello draft world',
      attachments: [
        {
          id: '1',
          name: 'diagram.png',
          dataUrl: 'data:image/png;base64,AAAA',
          sizeBytes: 128,
        },
      ],
      replyDigest: 'digest-123',
    })

    const loaded = loadChatDraft('0xabcd')
    expect(loaded).not.toBeNull()
    expect(loaded?.message).toBe('Hello draft world')
    expect(loaded?.replyDigest).toBe('digest-123')
    expect(loaded?.attachments).toHaveLength(1)
    expect(loaded?.attachments[0]?.name).toBe('diagram.png')

    // Saving empty content removes the draft
    saveChatDraft('0xAbCd', {
      message: '',
      attachments: [],
      replyDigest: null,
    })
    expect(loadChatDraft('0xAbCd')).toBeNull()

    // Explicit clearChatDraft also removes the draft
    saveChatDraft('0xAbCd', { message: 'Second draft' })
    expect(loadChatDraft('0xAbCd')?.message).toBe('Second draft')
    clearChatDraft('0xabcd')
    expect(loadChatDraft('0xAbCd')).toBeNull()
  })

  it('persists, restores, and clears forum post and reply drafts independently', () => {
    saveForumPostDraft('top-level', {
      title: 'My Forum Post',
      url: 'https://signet.mx',
      topic: 'general',
      topLevelTopicWasEdited: true,
      offering: '10',
      message: 'Body text here',
      attachments: [],
    })
    saveForumPostDraft('reply:digest-999', {
      title: 'Re: Topic',
      url: null,
      topic: 'dev',
      message: 'Reply body text',
      attachments: [],
    })

    const topDraft = loadForumPostDraft('top-level')
    expect(topDraft?.title).toBe('My Forum Post')
    expect(topDraft?.url).toBe('https://signet.mx')
    expect(topDraft?.topic).toBe('general')
    expect(topDraft?.topLevelTopicWasEdited).toBe(true)
    expect(topDraft?.message).toBe('Body text here')

    const replyDraft = loadForumPostDraft('reply:digest-999')
    expect(replyDraft?.title).toBe('Re: Topic')
    expect(replyDraft?.message).toBe('Reply body text')

    clearForumPostDraft('top-level')
    expect(loadForumPostDraft('top-level')).toBeNull()
    expect(loadForumPostDraft('reply:digest-999')?.message).toBe(
      'Reply body text',
    )
  })

  it('persists and clears topic stream drafts', () => {
    expect(loadTopicDraft('announcements')).toBe('')
    saveTopicDraft('Announcements', 'Draft announcement')
    expect(loadTopicDraft('announcements')).toBe('Draft announcement')
    saveTopicDraft('announcements', '')
    expect(loadTopicDraft('announcements')).toBe('')
  })
})
