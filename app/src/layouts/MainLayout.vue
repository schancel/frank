<template>
  <q-layout
    view="lHr lpr lFr"
    :class="{
      'frank-has-mobile-bottom-nav': showMobileBottomNav,
      'frank-is-extension-popup': isExtensionPopup,
    }"
  >
    <q-drawer
      v-model="myDrawerOpen"
      class="frank-main-drawer"
      :width="drawerWidth"
      :breakpoint="drawerBreakpoint"
      :class="{ 'no-transition': isDragging }"
      show-if-above
      @keydown.esc="closeOverlayOnEscape"
    >
      <!-- `closeDrawer` bubbles up from ChatList.vue (several layers below, via LeftDrawer.vue's
      own `v-bind="$attrs"` on `<chat-list>` -- LeftDrawer.vue declares no `emits` of its own, so
      this listener lands in its `$attrs` and forwards straight through). See ChatList.vue's own
      comment on `setActiveChat` for why. -->
      <left-drawer
        @closeDrawer="closeDrawerForNavigation"
        @updateWidth="onDrawerWidthUpdate"
        @resizing="onDrawerResizing"
      />
    </q-drawer>
    <router-view
      @toggleContactDrawerOpen="toggleContactDrawerOpen"
      @toggleMyDrawerOpen="toggleMyDrawerOpen"
      @setupNavigationLocked="setSetupNavigationLocked"
      @setupCompleted="$emit('setupCompleted')"
    />
    <div
      v-if="showMobileBottomNav"
      class="frank-mobile-bottom-nav row items-center justify-around no-wrap"
      data-testid="mobile-bottom-nav"
    >
      <q-btn
        flat
        dense
        no-caps
        stack
        class="frank-mobile-bottom-nav-btn col"
        icon="forum"
        :label="mobileNavChatsLabel"
        :aria-label="$t('chatList.directMessages')"
        :color="currentRoutePath.startsWith('/chat') ? 'primary' : undefined"
        data-testid="mobile-nav-chats"
        @click="openMobileChatsTab"
      />
      <q-btn
        flat
        dense
        no-caps
        stack
        class="frank-mobile-bottom-nav-btn col"
        icon="dynamic_feed"
        :label="$t('leftDrawer.forum')"
        :aria-label="$t('leftDrawer.forum')"
        :color="currentRoutePath.startsWith('/forum') ? 'primary' : undefined"
        data-testid="mobile-nav-forum"
        @click="$router.push('/forum')"
      />
      <q-btn
        flat
        dense
        no-caps
        stack
        class="frank-mobile-bottom-nav-btn col"
        icon="contacts"
        :label="$t('contactBookDialog.contacts')"
        :aria-label="$t('contactBookDialog.contacts')"
        :color="
          currentRoutePath.startsWith('/add-contact') ||
          currentRoutePath.startsWith('/contacts')
            ? 'primary'
            : undefined
        "
        data-testid="mobile-nav-contacts"
        @click="$router.push('/add-contact')"
      />
      <q-btn
        flat
        dense
        no-caps
        stack
        class="frank-mobile-bottom-nav-btn col"
        icon="account_balance_wallet"
        :label="$t('leftDrawer.wallet')"
        :aria-label="$t('leftDrawer.wallet')"
        :color="currentRoutePath.startsWith('/wallet') ? 'primary' : undefined"
        data-testid="mobile-nav-wallet"
        @click="$router.push('/wallet')"
      />
      <q-btn
        flat
        dense
        no-caps
        stack
        class="frank-mobile-bottom-nav-btn col"
        icon="qr_code_scanner"
        :label="mobileNavQrLabel"
        :aria-label="$t('contactBookDialog.myQrCode')"
        :color="currentRoutePath.startsWith('/qr') ? 'primary' : undefined"
        data-testid="mobile-nav-qr"
        @click="$router.push('/qr')"
      />
      <q-btn
        flat
        dense
        no-caps
        stack
        class="frank-mobile-bottom-nav-btn col"
        icon="settings"
        :label="$t('leftDrawer.settings')"
        :aria-label="$t('leftDrawer.settings')"
        :color="
          currentRoutePath.startsWith('/settings') ? 'primary' : undefined
        "
        data-testid="mobile-nav-settings"
        @click="$router.push('/settings')"
      />
    </div>
  </q-layout>
</template>

<script lang="ts">
import { computed, defineComponent } from 'vue'
import type { NavigationFailure, RouteLocationNormalized } from 'vue-router'

import { REVEAL_CHAT_DRAWER } from '../composables/useChatSearchShortcut'
import { MY_DRAWER_OPEN_KEY } from '../composables/useMyDrawerOpen'
import { DRAWER_BREAKPOINT, isNarrowWidth } from '../utils/layout'
import {
  applyViewportScaleAndMetrics,
  getEffectiveScreenWidth,
} from '../utils/mobile-viewport-scale'
import {
  getExtensionRuntime,
  isBrowserExtensionRuntime,
  openCompanionPanel,
  openExtensionInWindow,
  sendRuntimeMessage,
} from '../../src-bex/runtime-adapter'
import { FRANK_DAPP_BRIDGE_CHANNEL } from '../../src-bex/inpage'
import { useChatStore } from 'src/stores/chats'

import LeftDrawer from '../components/panels/LeftDrawer.vue'

const compactWidth = 70
const compactCutoff = 325
const compactMidpoint = (compactCutoff + compactWidth) / 2
// Same value passed to `q-drawer`'s own `:breakpoint` below -- kept as one named constant so
// the two can't silently drift apart, since `myDrawerOpen`'s own initial value (see `data()`)
// has to agree with it to avoid the mobile bug this constant's introduction fixed (ticket #123,
// found live): `show-if-above` only forces the drawer open *above* the breakpoint -- below it,
// visibility is governed by `v-model` alone, and `myDrawerOpen` defaulted to `true`
// unconditionally, so a page loaded directly at a narrow width (no resize event to trigger
// Quasar's own breakpoint-crossing logic) showed the drawer open as a permanent overlay,
// squeezing the actual chat/forum content into a sliver instead of collapsing it out of the way.
const drawerBreakpoint = DRAWER_BREAKPOINT

export default defineComponent({
  components: {
    LeftDrawer,
  },
  setup() {
    return {}
  },
  emits: ['setupCompleted'],
  data() {
    const initialRawWidth =
      (this as unknown as { $q?: { screen?: { width?: number } } }).$q?.screen
        ?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1024)
    return {
      railNavigation: false,
      removeAfterEach: undefined as (() => void) | undefined,
      removeOnError: undefined as (() => void) | undefined,
      // Control that had focus when the overlay was opened (the page header's menu button).
      drawerOpener: null as HTMLElement | null,
      // Set by @closeDrawer (chat picked): the restore then waits for the navigation to settle,
      // because the opener may be swapped out with the route. `ownedClose` tells the
      // myDrawerOpen watcher not to also restore for that same close.
      pendingRestore: null as { opener: HTMLElement | null } | null,
      pendingRestoreTimer: undefined as
        | ReturnType<typeof setTimeout>
        | undefined,
      ownedClose: false,
      // Background layout children this component marked `inert` for the open overlay; only these
      // are un-marked again, so an `inert` set by anything else is never touched (#277).
      inertedByOverlay: [] as HTMLElement[],
      // Set in beforeUnmount: a restore still in flight must not touch a dead layout's page.
      disposed: false,
      trueSplitterRatio: compactCutoff,
      desktopDrawerWidth: compactCutoff,
      isDragging: false,
      // See `drawerBreakpoint`'s own comment above for why this can't just be `true`.
      myDrawerOpen: !isNarrowWidth(getEffectiveScreenWidth(initialRawWidth)),
      contactDrawerOpen: false as boolean,
      compact: false,
      compactWidth,
      drawerBreakpoint,
      // #387: Setup reports its completion lock (pending persistence, terminal, or entry
      // retry) through this flag. While it is set, the drawer is a navigation surface this
      // layout must not expose, and its own toggle is a no-op; the setup page's own
      // route-leave guard blocks whatever else still tries to route away.
      setupNavigationLocked: false,
      // Whether the drawer was open (or the desktop default) when the setup lock engaged, so
      // the width's default can be restored when the lock clears.
      drawerClosedForSetupLock: false,
    }
  },
  provide() {
    return {
      [REVEAL_CHAT_DRAWER]: async () => {
        if (this.setupNavigationLocked || this.disposed) return false
        this.myDrawerOpen = true
        await this.$nextTick()
        await this.moveFocusIntoDrawer()
        return !this.disposed && this.myDrawerOpen
      },
      [MY_DRAWER_OPEN_KEY]: computed(() => this.myDrawerOpen),
      markRailNavigation: () => {
        this.railNavigation = true
      },
    }
  },
  created() {
    // Every navigation that picks a destination from the drawer (chat select, forum topic,
    // settings items, balance/receive, ...) must dismiss the overlay on narrow screens, otherwise it
    // stays on top of the page just navigated to. One router hook instead of a per-call-site
    // emit; desktop keeps the drawer open.
    this.removeAfterEach = this.$router.afterEach(
      (
        _to: RouteLocationNormalized,
        _from: RouteLocationNormalized,
        failure?: NavigationFailure | void,
      ) => {
        // Consume the rail-tab marker on every navigation outcome so it can't leak.
        const railTab = this.railNavigation
        this.railNavigation = false
        // Duplicate/cancelled/blocked navigations never left the drawer; rail-tab switches
        // stay inside it.
        // The navigation has settled: a pending @closeDrawer focus restore can run now.
        this.flushPendingRestore()
        if (failure) return
        // A settled navigation either is the authorized setup completion (the page unmounts)
        // or ran from a pre-lock state: the lock the page reported is stale either way, and a
        // blocked (failed) navigation must keep it.
        this.setupNavigationLocked = false
        if (railTab) return
        if (isNarrowWidth(this.screenWidth)) {
          // Focus is restored by the myDrawerOpen watcher, shared with every other way the
          // overlay can close (Escape, backdrop, swipe, @closeDrawer).
          this.myDrawerOpen = false
        }
      },
    )
    // A guard that throws (e.g. redirectIfNoProfile) skips afterEach entirely and routes to
    // onError instead, so the marker would otherwise survive and keep the overlay open for the
    // *next* navigation.
    this.removeOnError = this.$router.onError(() => {
      this.railNavigation = false
      this.flushPendingRestore()
    })
  },
  mounted() {
    if (typeof window !== 'undefined') {
      this.syncMobileViewport()
      this.onWindowScroll()
      window.addEventListener('scroll', this.onWindowScroll, { passive: true })
      window.addEventListener('resize', this.syncMobileViewport, {
        passive: true,
      })
      window.visualViewport?.addEventListener(
        'resize',
        this.syncMobileViewport,
        { passive: true },
      )
      window.visualViewport?.addEventListener(
        'scroll',
        this.syncMobileViewport,
        { passive: true },
      )
    }
    try {
      const saved = localStorage.getItem('frank:sidebar-width')
      if (saved) {
        const parsed = parseInt(saved, 10)
        if (parsed >= 260 && parsed <= 960) {
          this.desktopDrawerWidth = parsed
          this.trueSplitterRatio = parsed
        }
      }
    } catch {
      // ignore
    }
  },
  beforeUnmount() {
    this.disposed = true
    if (typeof window !== 'undefined') {
      window.removeEventListener('scroll', this.onWindowScroll)
      window.removeEventListener('resize', this.syncMobileViewport)
      window.visualViewport?.removeEventListener(
        'resize',
        this.syncMobileViewport,
      )
      window.visualViewport?.removeEventListener(
        'scroll',
        this.syncMobileViewport,
      )
    }
    this.setBackgroundInert(false)
    this.removeAfterEach?.()
    this.removeOnError?.()
    clearTimeout(this.pendingRestoreTimer)
  },
  watch: {
    // #387: Setup's completion lock hides the layout's navigation surface. Close the drawer
    // for the lock's duration (on desktop it would otherwise stay open with usable
    // destinations, on mobile the overlay must not open either) and restore the width's
    // default when the lock clears.
    setupNavigationLocked(locked: boolean) {
      if (locked) {
        if (this.myDrawerOpen) this.drawerClosedForSetupLock = true
        this.myDrawerOpen = false
        return
      }
      if (!this.drawerClosedForSetupLock) return
      this.drawerClosedForSetupLock = false
      this.myDrawerOpen = !isNarrowWidth(this.screenWidth)
    },
    // While the drawer is an overlay, nothing behind it may take focus or clicks (#277): Tab must
    // stay in the drawer, and a screen reader must not read the page under the backdrop. Synchronous
    // so the background is interactive again before any focus restore for the same close runs.
    overlayOpen: {
      handler(open: boolean) {
        this.setBackgroundInert(open)
      },
      flush: 'sync',
    },
    // Any open/close, however triggered: refresh the opener on every open so a stale one is never
    // restored, and hand focus back on every narrow-screen close.
    myDrawerOpen(open: boolean, wasOpen: boolean) {
      // Nothing may expose the drawer while Setup's completion lock is active -- not a stray
      // toggle and not Quasar's own `show-if-above` reopen when a resize crosses the breakpoint.
      if (open && this.setupNavigationLocked) {
        this.myDrawerOpen = false
        return
      }
      const narrow = isNarrowWidth(this.screenWidth)
      if (open) {
        // Only the narrow overlay hands focus back; never keep a control from a desktop open.
        const active = document.activeElement
        this.drawerOpener =
          narrow && active instanceof HTMLElement && active !== document.body
            ? active
            : null
        if (narrow) void this.moveFocusIntoDrawer()
        return
      }
      // Every close forgets the opener, restored or not.
      const opener = this.drawerOpener
      this.drawerOpener = null
      if (this.ownedClose) {
        this.ownedClose = false
        return
      }
      if (wasOpen && narrow) this.restoreFocusAfterOverlay(opener)
    },
  },
  methods: {
    // Opening the overlay leaves focus on the (now covered) opener, so the first Tab walked the
    // whole page behind the drawer before reaching it (#277). Land on the rail's selected tab -- the
    // drawer's roving-tabindex stop -- or, failing that, the first control in the drawer.
    async moveFocusIntoDrawer() {
      await this.$nextTick()
      if (this.disposed || !this.overlayOpen) return
      const drawer = this.$el?.querySelector?.('.q-drawer') as
        | HTMLElement
        | null
        | undefined
      const target =
        drawer?.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]',
        ) ??
        drawer?.querySelector<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        )
      target?.focus({ preventScroll: true })
    },
    // Quasar's own Escape handling is a window-level keydown+keyup pair that does not fire while a
    // rail tab or drawer item has focus in the browser -- exactly where focus now lands on open --
    // so the drawer closes itself on Escape from anywhere inside it.
    closeOverlayOnEscape() {
      if (this.overlayOpen) this.myDrawerOpen = false
    },
    setBackgroundInert(on: boolean) {
      if (!on) {
        for (const el of this.inertedByOverlay) el.removeAttribute('inert')
        this.inertedByOverlay = []
        return
      }
      const root = this.$el as HTMLElement | undefined
      if (!root?.children) return
      for (const child of Array.from(root.children) as HTMLElement[]) {
        // The drawer (and its backdrop) live in Quasar's drawer container; everything else in the
        // layout -- header, page container, footer, the forum's own drawer -- is background.
        if (child.classList.contains('q-drawer-container')) continue
        if (child.classList.contains('q-drawer')) continue
        if (child.hasAttribute('inert')) continue
        child.setAttribute('inert', '')
        this.inertedByOverlay.push(child)
      }
    },
    toggleContactDrawerOpen() {
      this.contactDrawerOpen = !this.contactDrawerOpen
    },
    // Closing the overlay unmounts/hides the control that had focus, which drops focus to <body>
    // (keyboard and screen-reader users lose their place). Hand it back to the control that
    // opened the drawer if it survived the navigation, else to the main content region.
    closeDrawerForNavigation() {
      if (this.myDrawerOpen && isNarrowWidth(this.screenWidth)) {
        this.pendingRestore = { opener: this.drawerOpener }
        this.drawerOpener = null
        this.ownedClose = true
        // Fallback for a pick that never navigates at all.
        clearTimeout(this.pendingRestoreTimer)
        this.pendingRestoreTimer = setTimeout(
          () => this.flushPendingRestore(),
          1500,
        )
      }
      this.myDrawerOpen = false
    },
    flushPendingRestore() {
      const pending = this.pendingRestore
      if (!pending) return
      this.pendingRestore = null
      clearTimeout(this.pendingRestoreTimer)
      this.restoreFocusAfterOverlay(pending.opener)
    },
    async restoreFocusAfterOverlay(opener: HTMLElement | null) {
      await this.$nextTick()
      if (this.disposed) return
      // Only repair focus the close lost or trapped; never move focus the user put elsewhere
      // (e.g. typing in the composer when a resize hid the drawer).
      const active = document.activeElement
      const focusLost =
        !active ||
        active === document.body ||
        active === document.documentElement ||
        // A click on the backdrop focuses the nearest focusable ancestor, the layout root itself
        // (Quasar gives it tabindex -1): that is focus lost as well, not a place the user chose.
        active.classList.contains('q-layout') ||
        active.closest('.q-drawer') !== null
      if (!focusLost) return
      const target =
        opener?.isConnected && opener !== document.body
          ? opener
          : document.querySelector<HTMLElement>(
              '[role="main"], main, .q-page-container',
            )
      if (!target) return
      if (
        !target.matches('a[href], button, input, select, textarea, [tabindex]')
      ) {
        target.setAttribute('tabindex', '-1')
      }
      target.focus({ preventScroll: true })
    },
    setSetupNavigationLocked(locked: boolean) {
      this.setupNavigationLocked = locked
    },
    toggleMyDrawerOpen() {
      // #387: the drawer must not open while Setup's completion lock is active.
      if (this.setupNavigationLocked) return
      if (this.compact) {
        this.compact = false
        this.trueSplitterRatio = compactCutoff
      }
      this.myDrawerOpen = !this.myDrawerOpen
    },
    onDrawerWidthUpdate(width: number) {
      if (isNarrowWidth(this.screenWidth)) return
      this.desktopDrawerWidth = width
      this.trueSplitterRatio = width
      try {
        localStorage.setItem('frank:sidebar-width', String(width))
      } catch {
        // ignore
      }
    },
    onDrawerResizing(val: boolean) {
      this.isDragging = val
    },
    syncMobileViewport() {
      applyViewportScaleAndMetrics()
      this.onWindowScroll()
    },
    onWindowScroll() {
      if (
        typeof window !== 'undefined' &&
        (window.scrollY !== 0 || window.scrollX !== 0)
      ) {
        window.scrollTo(0, 0)
      }
    },
    async openExtensionSidePanel() {
      const res = await openCompanionPanel()
      try {
        await sendRuntimeMessage({
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'set-sidepanel-behavior',
          openPanelOnActionClick: true,
        })
      } catch {
        // Ignore runtime message errors outside extension runtime
      }
      if (
        res.opened &&
        typeof window !== 'undefined' &&
        typeof window.close === 'function'
      ) {
        try {
          window.close()
        } catch {
          // Ignore window.close errors in restricted contexts
        }
      }
    },
    async popOutExtensionWindow() {
      const res = await openExtensionInWindow()
      try {
        await sendRuntimeMessage({
          channel: FRANK_DAPP_BRIDGE_CHANNEL,
          type: 'set-launch-mode',
          launchMode: 'window',
        })
      } catch {
        // Ignore runtime message errors outside extension runtime
      }
      if (
        res.opened &&
        typeof window !== 'undefined' &&
        typeof window.close === 'function'
      ) {
        try {
          window.close()
        } catch {
          // Ignore window.close errors in restricted contexts
        }
      }
    },
    openMobileChatsTab() {
      try {
        const chats = useChatStore()
        const target =
          chats.activeConversationId ??
          chats.activeChatAddr ??
          chats.getSortedChatOrder?.[0]?.id ??
          chats.getSortedChatOrder?.[0]?.address
        if (target) {
          if (typeof chats.setActiveConversation === 'function') {
            chats.setActiveConversation(target)
          }
          void this.$router.push(`/chat/${target}`)
          return
        }
      } catch {
        // Fallback to /chat when store is unavailable
      }
      void this.$router.push('/chat')
    },
  },
  computed: {
    screenWidth(): number {
      const q = (this as unknown as { $q?: { screen?: { width?: number } } }).$q
      const raw =
        q?.screen?.width ??
        (typeof window !== 'undefined' ? window.innerWidth : 1024)
      return getEffectiveScreenWidth(raw)
    },
    overlayOpen(): boolean {
      return this.myDrawerOpen && isNarrowWidth(this.screenWidth)
    },
    currentRoutePath(): string {
      return this.$router?.currentRoute?.value?.path ?? ''
    },
    isExtensionPopup(): boolean {
      const routeQueryMode = (
        this.$router?.currentRoute?.value?.query as
          | Record<string, unknown>
          | undefined
      )?.extMode
      if (routeQueryMode === 'popup' || routeQueryMode === 'sidepanel' || routeQueryMode === 'sidebar') {
        return true
      }
      if (routeQueryMode === 'window' || routeQueryMode === 'tab') {
        return false
      }
      const docMode =
        typeof document !== 'undefined'
          ? document.documentElement?.getAttribute('data-ext-mode')
          : null
      if (docMode === 'popup' || docMode === 'sidepanel' || docMode === 'sidebar') {
        return true
      }
      if (docMode === 'window' || docMode === 'tab') {
        return false
      }
      if (typeof window !== 'undefined') {
        const search = window.location?.search ?? ''
        if (
          search.includes('extMode=popup') ||
          search.includes('extMode=sidepanel') ||
          search.includes('extMode=sidebar')
        ) {
          return true
        }
        if (search.includes('extMode=window') || search.includes('extMode=tab')) {
          return false
        }
      }
      return isBrowserExtensionRuntime()
    },
    extOpenSidePanelLabel(): string {
      return 'Open in Side Panel'
    },
    extPopoutWindowLabel(): string {
      return 'Pop Out Window'
    },
    supportsSidePanel(): boolean {
      if (getExtensionRuntime().kind === 'safari-extension') return false
      if (typeof window !== 'undefined') {
        const search = window.location?.search ?? ''
        if (search.includes('extMode=sidepanel') || search.includes('extMode=sidebar')) {
          return false
        }
      }
      return true
    },
    showMobileBottomNav(): boolean {
      const setup = Boolean(
        (this as unknown as { $status?: { setup?: boolean } }).$status?.setup,
      )
      if (!setup || this.setupNavigationLocked) return false
      if (!isNarrowWidth(this.screenWidth)) return false
      const path = this.currentRoutePath
      return !path.startsWith('/chat/') && !path.startsWith('/setup')
    },
    mobileNavChatsLabel(): string {
      return 'Messages'
    },
    mobileNavQrLabel(): string {
      return 'QR'
    },
    drawerWidth(): number {
      if (isNarrowWidth(this.screenWidth)) {
        return compactCutoff
      }
      return this.desktopDrawerWidth
    },
    splitterRatio: {
      get(): number {
        return this.trueSplitterRatio
      },
      set(inputRatio: number): void {
        this.trueSplitterRatio = inputRatio
        this.$nextTick(() => {
          if (inputRatio < compactMidpoint) {
            this.trueSplitterRatio = compactWidth
            this.compact = true
          } else if (
            inputRatio > compactMidpoint &&
            inputRatio < compactCutoff
          ) {
            this.compact = false
            this.trueSplitterRatio = compactCutoff
          } else {
            this.compact = false
          }
        })
      },
    },
  },
})
</script>

<style lang="scss">
.q-layout {
  width: var(--frank-vw, 100%);
  height: 100vh;
  height: var(--frank-vh, 100dvh);
  min-height: 0 !important;
  max-height: 100vh;
  max-height: var(--frank-vh, 100dvh);
  overflow: hidden;
}

.q-layout.frank-has-mobile-bottom-nav {
  --frank-bottom-nav-offset: calc(56px + env(safe-area-inset-bottom, 0px));
}

.q-layout.frank-has-mobile-bottom-nav .q-page-container {
  padding-bottom: var(
    --frank-bottom-nav-offset,
    calc(56px + env(safe-area-inset-bottom, 0px))
  ) !important;
}

.q-layout.frank-has-mobile-bottom-nav
  .q-page-container.overflow-hidden
  > .q-page {
  height: 100% !important;
  max-height: 100% !important;
  min-height: 0 !important;
}

.frank-mobile-bottom-nav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: calc(56px + env(safe-area-inset-bottom, 0px));
  min-height: 56px;
  max-height: calc(56px + env(safe-area-inset-bottom, 0px));
  padding: 0 2px env(safe-area-inset-bottom, 0px);
  background: var(--q-color-bg-surface, #fff);
  border-top: 1px solid rgba(128, 128, 128, 0.2);
  z-index: 1000;
  overflow: hidden;

  .q-btn {
    flex: 1 1 0%;
    min-width: 0;
    max-width: 100%;
    height: 54px;
    min-height: 54px;
    max-height: 54px;
    padding: 4px 2px !important;
    border-radius: 8px;
    font-size: 10px;
    line-height: 1.15;
  }

  .q-btn__content {
    flex-direction: column !important;
    flex-wrap: nowrap !important;
    justify-content: center;
    align-items: center;
    gap: 2px;
    width: 100%;
    min-width: 0;
    overflow: hidden;

    .q-icon {
      font-size: 20px;
      margin: 0 !important;
    }

    .block {
      display: block;
      width: 100%;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: center;
      font-size: 10px;
      line-height: 1.2;
    }
  }
}

// Long page content can grow q-layout beyond the viewport; Quasar's standard drawer is
// positioned against that layout, so its pinned rail/footer would otherwise fall below
// the visible screen. Dynamic viewport units also follow Safari's browser chrome.
.frank-main-drawer {
  max-height: 100vh;
  max-height: var(--frank-vh, 100dvh);

  .q-drawer__content {
    height: 100%;
    overflow: hidden;
  }
}

// The main region is only a programmatic focus target (restoreFocusAfterOverlay); it must not
// draw a focus ring around the whole page.
.q-page-container[tabindex='-1']:focus {
  outline: none;
}
.no-transition,
.no-transition .q-drawer {
  transition: none !important;
}
body.resizing-drawer {
  user-select: none !important;
  cursor: col-resize !important;
}
</style>
