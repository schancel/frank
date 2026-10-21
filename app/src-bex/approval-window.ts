/**
 * The one window in which the user answers dApp requests (connect, sign,
 * send), as MetaMask and Rabby do: a small focused popup window showing only
 * the queued requests. Every pending request shares this window; a new request
 * focuses it instead of opening another. The background closes it once the
 * queue is empty. A window the user closes counts as rejecting everything still
 * waiting in it.
 */

/** Extension page that renders the approval queue (built from approval.ts). */
export const APPROVAL_PAGE_PATH = 'approval.html'
export const APPROVAL_WINDOW_WIDTH = 400
export const APPROVAL_WINDOW_HEIGHT = 620

export interface ApprovalWindow {
  /** Open the approval window, or focus it when it is already open. */
  show(): Promise<void>
  /** Close the window because no request is waiting any more. */
  close(): Promise<void>
}

export function createApprovalWindow(options: {
  /** The browser extension API (`chrome` / `browser`). */
  api: Record<string, any> | null
  /** Called when the user closes the window while it was ours to close. */
  onClosedByUser: () => void
}): ApprovalWindow {
  const { api, onClosedByUser } = options
  // The open window (or, without a windows API, tab) showing the queue.
  let open: { kind: 'window' | 'tab'; id: number } | null = null
  let opening: Promise<void> | null = null
  // Counts show() calls, so a close() that had to wait cannot close a window a
  // request asked for in the meantime.
  let shows = 0

  const url =
    typeof api?.runtime?.getURL === 'function'
      ? String(api.runtime.getURL(APPROVAL_PAGE_PATH))
      : APPROVAL_PAGE_PATH

  const onWindowRemoved = (windowId: number) => {
    if (open?.kind === 'window' && open.id === windowId) {
      open = null
      onClosedByUser()
    }
  }
  const onTabRemoved = (tabId: number) => {
    if (open?.kind === 'tab' && open.id === tabId) {
      open = null
      onClosedByUser()
    }
  }
  api?.windows?.onRemoved?.addListener?.(onWindowRemoved)
  api?.tabs?.onRemoved?.addListener?.(onTabRemoved)

  async function focusExisting(): Promise<boolean> {
    if (!open) return false
    try {
      if (open.kind === 'window') {
        await api!.windows.update(open.id, { focused: true })
      } else {
        await api!.tabs.update(open.id, { active: true })
      }
      return true
    } catch {
      // Closed without us seeing onRemoved (e.g. while the worker slept).
      open = null
      return false
    }
  }

  async function create(): Promise<void> {
    if (typeof api?.windows?.create === 'function') {
      const win = await api.windows.create({
        url,
        type: 'popup',
        width: APPROVAL_WINDOW_WIDTH,
        height: APPROVAL_WINDOW_HEIGHT,
        focused: true,
      })
      if (typeof win?.id === 'number') open = { kind: 'window', id: win.id }
      return
    }
    if (typeof api?.tabs?.create === 'function') {
      const tab = await api.tabs.create({ url, active: true })
      if (typeof tab?.id === 'number') open = { kind: 'tab', id: tab.id }
    }
  }

  return {
    show() {
      shows += 1
      // Requests arriving together share the one window being opened.
      if (!opening) {
        opening = (async () => {
          if (!(await focusExisting())) await create()
        })().finally(() => {
          opening = null
        })
      }
      return opening
    },
    async close() {
      const showsAtClose = shows
      if (opening) await opening.catch(() => undefined)
      if (shows !== showsAtClose) return
      const current = open
      // Forget it first: its onRemoved is ours, not the user's rejection.
      open = null
      if (!current) return
      try {
        if (current.kind === 'window') await api!.windows.remove(current.id)
        else await api!.tabs.remove(current.id)
      } catch {
        // Already closed
      }
    },
  }
}
