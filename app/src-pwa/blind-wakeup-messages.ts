/*
 * The messages the service worker and the page exchange about a blind WebPush wakeup. A module of
 * its own so the page can import them without loading the service worker itself: importing
 * `custom-service-worker` from the page would run its listener registration in the window, and
 * the dev server resolves that bare path to the CommonJS `custom-service-worker.js` first.
 */
export const BLIND_WAKEUP_MESSAGE_TYPE = 'FRANK_BLIND_WAKEUP_SYNC'
export const BLIND_WAKEUP_HANDLED_TYPE = 'FRANK_BLIND_WAKEUP_HANDLED'
