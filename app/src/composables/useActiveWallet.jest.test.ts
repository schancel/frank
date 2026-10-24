import { peekActiveWallet } from './useActiveWallet'
import { accountSession } from '../accounts/session'

jest.mock('../accounts/session', () => ({
  accountSession: { peekWallet: jest.fn(), getWallet: jest.fn() },
}))

it('reads an existing public-query wallet without initializing custody', () => {
  const ready = { chainIdentifier: 'ethereum-sepolia' }
  ;(accountSession.peekWallet as jest.Mock).mockReturnValueOnce(ready)
  expect(peekActiveWallet()).toBe(ready)
  ;(accountSession.peekWallet as jest.Mock).mockReturnValueOnce(undefined)
  expect(peekActiveWallet()).toBeUndefined()
  expect(accountSession.getWallet).not.toHaveBeenCalled()
})
