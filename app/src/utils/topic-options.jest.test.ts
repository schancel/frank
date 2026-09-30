import { topicOptions } from './topic-options'

const KNOWN = ['stamp', 'news', 'trading', 'memes', 'help']

describe('topicOptions (New Post topic select)', () => {
  it('offers every known topic, and no empty row, before anything is typed', () => {
    expect(topicOptions('', KNOWN)).toEqual(KNOWN)
    expect(topicOptions('   ', KNOWN)).toEqual(KNOWN)
  })

  it('never offers an empty topic even if a store holds one', () => {
    expect(topicOptions('', ['', 'news'])).toEqual(['news'])
  })

  it('lists each topic once', () => {
    expect(topicOptions('', ['news', 'help', 'news'])).toEqual(['news', 'help'])
  })

  it('puts the typed text first so a brand-new topic can be chosen, then the matches', () => {
    expect(topicOptions('ne', ['news', 'help', 'newsletter'])).toEqual([
      'ne',
      'news',
      'newsletter',
    ])
  })

  it('does not repeat the typed text when it is already a known topic', () => {
    expect(topicOptions('news', ['help', 'news', 'news-eu'])).toEqual([
      'news',
      'news-eu',
    ])
  })

  it('offers only the typed text when nothing known matches', () => {
    expect(topicOptions('zzz', KNOWN)).toEqual(['zzz'])
  })
})
