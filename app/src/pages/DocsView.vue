<template>
  <div class="docs-view-container column full-height overflow-hidden">
    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          class="q-px-sm"
          flat
          dense
          @click="toggleSettingsDrawerOpen"
          icon="menu"
          :aria-label="$t('a11y.openNavigation')"
          :aria-expanded="myDrawerOpen"
        />
        <q-toolbar-title class="h6">{{ $t('docs.header') }}</q-toolbar-title>
        <q-btn
          flat
          dense
          icon="open_in_new"
          :label="$t('docs.openInTab')"
          href="/docs/"
          target="_blank"
          class="gt-xs q-mr-sm"
        />
      </q-toolbar>
    </q-header>

    <q-page-container class="col full-height overflow-hidden">
      <q-page
        class="no-padding full-width docs-container col full-height overflow-hidden relative-position"
        :style-fn="pageStyle"
      >
        <iframe
          ref="frame"
          :src="frameSrc"
          class="docs-iframe"
          :title="$t('docs.iframeTitle')"
          @load="watchFrame"
        />
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'
import { useMyDrawerOpen } from '../composables/useMyDrawerOpen'
import { viewportPageStyle } from 'src/utils/layout'

const DOCS_ROOT = '/docs/'

/**
 * The documentation page open in the frame, as the address holds it (`?page=`, relative to
 * `/docs/`), or '' for the documentation's start page. Only a page of the documentation.
 */
function docsPage(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || !value) return ''
  // Relative to /docs/ and nowhere else: no scheme, no host, no way up.
  if (/^[/\\]|:|\.\./.test(value)) return ''
  return value
}

export default defineComponent({
  name: 'DocsView',
  emits: ['toggleMyDrawerOpen'],
  setup(_, { emit }) {
    return {
      myDrawerOpen: useMyDrawerOpen(),
      pageStyle: viewportPageStyle,
      toggleSettingsDrawerOpen() {
        emit('toggleMyDrawerOpen')
      },
    }
  },
  data() {
    // The page open in the documentation is in the address (`?page=`): Back, Forward, a reload
    // and a link open it again.
    const page = docsPage(
      (this as { $route?: { query?: Record<string, unknown> } }).$route?.query
        ?.page,
    )
    return {
      frameSrc: DOCS_ROOT + page,
      stopWatchingFrame: undefined as (() => void) | undefined,
    }
  },
  watch: {
    // The address changed to another page (Back or Forward between two entries): the frame
    // follows, unless it is already there.
    '$route.query.page'(raw: unknown) {
      if (this.$route?.path !== '/docs') return
      const page = docsPage(raw)
      if (page !== this.framePage()) this.frameSrc = DOCS_ROOT + page
    },
  },
  beforeUnmount() {
    this.stopWatchingFrame?.()
  },
  methods: {
    /** The documentation page the frame shows, relative to /docs/; null when unreadable. */
    framePage(): string | null {
      const frame = this.$refs.frame as HTMLIFrameElement | undefined
      try {
        const location = frame?.contentWindow?.location
        if (!location || !location.pathname.startsWith(DOCS_ROOT)) return null
        return (
          location.pathname.slice(DOCS_ROOT.length) +
          location.search +
          location.hash
        )
      } catch {
        // Not the documentation's own origin: nothing to keep.
        return null
      }
    },
    /** Keeps the address on the page the frame shows, in place (no history entry). */
    syncAddress() {
      const route = this.$route
      if (!route || !this.$router || route.path !== '/docs') return
      const page = this.framePage()
      if (page === null || page === docsPage(route.query.page)) return
      const query = { ...route.query }
      if (page) query.page = page
      else delete query.page
      void this.$router.replace({ path: route.path, query })
    },
    /**
     * The documentation moves between its pages inside the frame (its own client-side
     * navigation, or a full load): each move is followed.
     */
    watchFrame() {
      this.stopWatchingFrame?.()
      this.stopWatchingFrame = undefined
      const frame = this.$refs.frame as HTMLIFrameElement | undefined
      let view: Window | null | undefined
      try {
        view = frame?.contentWindow
        // Throws for a page of another origin.
        void view?.location.pathname
      } catch {
        return
      }
      if (!view) return
      const sync = () => this.syncAddress()
      const history = view.history
      const push = history.pushState
      const replace = history.replaceState
      history.pushState = function (...args: Parameters<History['pushState']>) {
        push.apply(this, args)
        sync()
      }
      history.replaceState = function (
        ...args: Parameters<History['replaceState']>
      ) {
        replace.apply(this, args)
        sync()
      }
      view.addEventListener('popstate', sync)
      view.addEventListener('hashchange', sync)
      const watched = view
      this.stopWatchingFrame = () => {
        try {
          history.pushState = push
          history.replaceState = replace
          watched.removeEventListener('popstate', sync)
          watched.removeEventListener('hashchange', sync)
        } catch {
          // The frame is gone.
        }
      }
      sync()
    },
  },
})
</script>

<style scoped>
.docs-container {
  height: 100%;
  overflow: hidden;
}

.docs-iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}
</style>
