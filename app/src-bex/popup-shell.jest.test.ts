/** @jest-environment jsdom */
import { installPopupHost } from './popup-shell'
import {
  closeExtensionView,
  FRANK_POPUP_FRAME_ID,
  FRANK_PWA_EXTENSION_SYNC_CHANNEL,
  hasOtherExtensionViews,
  sendRuntimeMessage,
} from './runtime-adapter'
import { applyToolbarClickBehavior } from './background'

test('the framed app closes its popup and requests sync navigation through the top-level host', async () => {
  const send = jest.fn(async () => ({ ok: true }))
  const parent = {
    close: jest.fn(),
    browser: { runtime: { id: 'frank', sendMessage: send } },
    frankPopupHost: undefined as any,
  }
  installPopupHost(parent)
  const childSend = jest.fn()
  const child: Record<string, any> = {
    frameElement: { id: FRANK_POPUP_FRAME_ID },
    parent,
    close: jest.fn(),
    browser: {
      runtime: { id: 'frank', sendMessage: childSend },
      extension: { getViews: () => [parent] },
    },
  }
  expect(await hasOtherExtensionViews(child)).toBe(false)
  child.browser.extension.getViews = () => [parent, {}]
  expect(await hasOtherExtensionViews(child)).toBe(true)
  expect(
    await sendRuntimeMessage(
      {
        channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
        type: 'request-sync-sender',
      },
      child,
    ),
  ).toEqual({ ok: true })
  expect(send).toHaveBeenCalledWith({
    channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
    type: 'request-sync-sender',
  })
  expect(childSend).not.toHaveBeenCalled()
  expect(closeExtensionView(child)).toBe(true)
  expect(parent.close).toHaveBeenCalledTimes(1)
  expect(child.close).not.toHaveBeenCalled()
})

test('reapplying Safari toolbar preferences keeps the fixed shell as the popup', () => {
  const setPopup = jest.fn()
  applyToolbarClickBehavior(
    {
      browser: {
        runtime: {
          id: 'frank',
          getURL: (path: string) => `safari-web-extension://frank/${path}`,
        },
        action: { setPopup },
      },
    },
    'popup',
  )
  expect(setPopup).toHaveBeenCalledWith({ popup: 'popup.html' })
})
