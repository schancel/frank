import { nextFollowBottom } from './follow-bottom'

describe('nextFollowBottom', () => {
  it('follows while the view is at the bottom', () => {
    expect(nextFollowBottom(false, 100, 400, 0)).toBe(true)
    expect(nextFollowBottom(false, 100, 400, 10)).toBe(true)
  })

  it('keeps following when the content grows under an unmoved view', () => {
    // Same position, the end moved 180px away: a bubble rendered its result.
    expect(nextFollowBottom(true, 400, 400, 180)).toBe(true)
  })

  it('stops following when the user scrolls up', () => {
    expect(nextFollowBottom(true, 400, 250, 150)).toBe(false)
  })

  it('does not start following again until the bottom is reached', () => {
    expect(nextFollowBottom(false, 250, 300, 100)).toBe(false)
    expect(nextFollowBottom(false, 300, 395, 5)).toBe(true)
  })

  it('ignores sub-pixel jitter in the reported position', () => {
    expect(nextFollowBottom(true, 400, 399, 181)).toBe(true)
  })
})
