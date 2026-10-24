<template>
  <div>
    <q-drawer
      v-model="showForumDrawer"
      side="right"
      :breakpoint="drawerBreakpoint"
    >
      <forum-drawer />
    </q-drawer>

    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          v-if="isThreadRoute"
          class="q-px-sm no-shrink"
          flat
          dense
          @click="navigateBack"
          icon="arrow_back"
          :aria-label="$t('a11y.backToForum')"
          data-test="forum-back"
        />
        <q-btn
          class="q-px-sm no-shrink"
          flat
          dense
          @click="toggleSettingsDrawerOpen"
          icon="menu"
          :aria-label="$t('a11y.openNavigation')"
          :aria-expanded="myDrawerOpen"
          data-test="forum-menu"
        />
        <!-- Narrow: the title is just "#topic" and gives way (ellipsis) before any button does. -->
        <q-toolbar-title class="h6 forum-toolbar-title">
          <div
            v-if="narrow"
            class="ellipsis"
            :class="{ 'cursor-pointer': isThreadRoute }"
            data-test="forum-compact-title"
            @click="isThreadRoute && navigateBack()"
          >
            <template v-if="selectedTopic">#{{ selectedTopic }}</template>
            <template v-else-if="isThreadRoute">{{
              $t('forum.thread')
            }}</template>
            <template v-else>{{ $t('leftDrawer.forum') }}</template>
          </div>
          <div
            v-else-if="isThreadRoute"
            class="row items-center no-wrap cursor-pointer"
            @click="navigateBack"
            data-test="forum-breadcrumb"
          >
            <span>{{ $t('leftDrawer.forum') }}</span>
            <q-icon name="chevron_right" size="1em" class="q-mx-xs" />
            <span v-if="selectedTopic" data-test="forum-thread-topic">
              #{{ selectedTopic }}
            </span>
            <span v-else class="text-body2 text-grey-4">{{
              $t('forum.thread')
            }}</span>
          </div>
          <div
            v-else-if="selectedTopic"
            class="row items-center no-wrap"
            data-test="forum-topic-header"
          >
            <span
              class="cursor-pointer"
              @click="clearTopic"
              data-test="forum-breadcrumb-root"
              >{{ $t('leftDrawer.forum') }}</span
            >
            <q-icon name="chevron_right" size="1em" class="q-mx-xs" />
            <span data-test="forum-active-topic">#{{ selectedTopic }}</span>
          </div>
          <span v-else>{{ $t('leftDrawer.forum') }}</span>
        </q-toolbar-title>
        <q-btn
          icon="refresh"
          :aria-label="$t('a11y.forumRefresh')"
          flat
          class="q-mx-none q-pa-sm no-shrink"
          data-test="forum-refresh"
          :loading="isRefreshing"
          @click="refreshContent"
        />
        <q-btn
          flat
          icon="post_add"
          class="q-mx-none q-pa-sm no-shrink"
          to="/new-post"
          :aria-label="$t('a11y.newPost')"
        />
        <extension-popout-btn class="no-shrink" />
        <q-btn
          icon="settings"
          flat
          :aria-label="$t('a11y.forumSettings')"
          :aria-expanded="showForumDrawer"
          class="q-mx-none q-pa-sm no-shrink"
          @click="showForumDrawer = !showForumDrawer"
        />
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page>
        <q-scroll-area
          ref="chatScroll"
          class="q-px-sm absolute full-width full-height"
          @wheel.capture="pullWithWheel"
          :content-style="{ display: 'flex', flexDirection: 'column' }"
          :content-active-style="{ display: 'flex', flexDirection: 'column' }"
        >
          <q-pull-to-refresh
            no-mouse
            class="forum-refresh-surface"
            data-test="forum-pull-to-refresh"
            @touchstart.capture="prepareTouchRefresh"
            @touchend.capture="restoreTouchDrag"
            @touchcancel.capture="restoreTouchDrag"
            @refresh="pullToRefresh"
          >
            <router-view @set-topic="setTopic" />
          </q-pull-to-refresh>
        </q-scroll-area>
        <div
          v-if="wheelPullDistance > 0 || wheelRefreshing"
          class="forum-wheel-refresh row no-wrap items-center text-primary shadow-2"
          :class="$q.dark?.isActive ? 'bg-grey-10' : 'bg-white'"
          data-test="forum-wheel-refresh"
          role="status"
          aria-live="polite"
        >
          <q-spinner v-if="wheelRefreshing" size="24px" />
          <q-circular-progress
            v-else
            :value="Math.min(100, wheelPullDistance)"
            size="24px"
            :thickness="0.2"
          />
          <span>{{
            wheelRefreshing
              ? $t('forum.refreshing')
              : wheelPullReady
              ? $t('forum.releaseToRefresh')
              : $t('forum.pullToRefresh')
          }}</span>
        </div>
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { defineComponent, onBeforeUnmount } from 'vue'

import { useMyDrawerOpen } from '../composables/useMyDrawerOpen'
import { storeToRefs } from 'pinia'

import { useForumStore } from 'src/stores/forum'
import { useTopicStore } from 'src/stores/topics'
import { peekActiveWallet } from 'src/composables/useActiveWallet'

import ForumDrawer from '../components/panels/ForumDrawer.vue'
import ExtensionPopoutBtn from '../components/navigation/ExtensionPopoutBtn.vue'
import { DRAWER_BREAKPOINT, isNarrowWidth } from '../utils/layout'
import { getEffectiveScreenWidth } from '../utils/mobile-viewport-scale'

export default defineComponent({
  data() {
    return {
      showForumDrawer: false,
      drawerBreakpoint: DRAWER_BREAKPOINT,
      wheelPullDistance: 0,
      wheelStartedAtTop: false,
      wheelLastAt: 0,
      wheelCooldownUntil: 0,
      wheelRefreshing: false,
      wheelRefreshRevision: 0,
      wheelReleaseTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
  },
  setup() {
    // Quasar ignores a pan that starts on a natively draggable image/link,
    // including touch pans. Suspend native drag for this touch only; mouse
    // dragging and the element's original attribute survive the gesture.
    let touchDragTarget: HTMLElement | undefined
    let touchDragAttribute: string | null = null
    function restoreTouchDrag() {
      if (!touchDragTarget) return
      if (touchDragAttribute === null) {
        touchDragTarget.removeAttribute('draggable')
      } else {
        touchDragTarget.setAttribute('draggable', touchDragAttribute)
      }
      touchDragTarget = undefined
    }
    function prepareTouchRefresh(event: TouchEvent) {
      restoreTouchDrag()
      const target = event.target
      if (target instanceof HTMLElement && target.draggable) {
        touchDragTarget = target
        touchDragAttribute = target.getAttribute('draggable')
        target.draggable = false
      }
    }
    onBeforeUnmount(restoreTouchDrag)

    const forumStore = useForumStore()
    const topicStore = useTopicStore()
    const { topics, selectedTopic, isRefreshing } = storeToRefs(forumStore)

    return {
      prepareTouchRefresh,
      restoreTouchDrag,
      myDrawerOpen: useMyDrawerOpen(),
      refreshMessages: forumStore.refreshMessages,
      setSelectedTopic: forumStore.setSelectedTopic,
      // Ticket #72: `refreshDiscoveredTopics` merges relay-discovered topics into `useTopicStore`
      // (the store `AddTopic.vue`/`TopicList.vue`/`TopicDrawer.vue` read from, distinct from this
      // layout's own `forumStore`) alongside its hardcoded `defaultTopics` fallback. Wired here
      // (this layout's `mounted()` below) rather than at global app startup: unlike ticket #49's
      // curated contacts (which matter immediately, before the user picks a screen), a topic list
      // is only relevant once someone has actually opened the Forum -- this layout wraps every
      // Forum-area route (`Forum.vue`/`Topic.vue` via `router-view`), so its `mounted()` hook is
      // this codebase's real "the user opened the Forum" moment.
      refreshDiscoveredTopics: topicStore.refreshDiscoveredTopics,
      topics,
      storeSelectedTopic: selectedTopic,
      isRefreshing,
    }
  },
  components: { ForumDrawer, ExtensionPopoutBtn },
  emits: ['toggleMyDrawerOpen'],
  mounted() {
    void this.refreshContent()
    // Fire-and-forget: `refreshDiscoveredTopics` already fails soft (never throws, see
    // `stores/topics.ts`), so there's nothing meaningful to await or catch here -- matches
    // `refreshContent`'s own un-awaited call just above.
    this.refreshDiscoveredTopics()
  },
  beforeUnmount() {
    this.clearWheelFeedback()
  },
  watch: {
    '$route.fullPath'() {
      this.clearWheelFeedback()
    },
  },
  methods: {
    clearWheelFeedback() {
      this.resetWheelPull()
      this.wheelRefreshRevision++
      this.wheelRefreshing = false
    },
    resetWheelPull() {
      if (this.wheelReleaseTimer !== undefined)
        clearTimeout(this.wheelReleaseTimer)
      this.wheelReleaseTimer = undefined
      this.wheelPullDistance = 0
      this.wheelStartedAtTop = false
      this.wheelLastAt = 0
    },
    pullWithWheel(event: WheelEvent) {
      const scroll = (
        this.$refs.chatScroll as { getScrollTarget(): HTMLElement } | undefined
      )?.getScrollTarget()
      if (!scroll) return
      const now = performance.now()
      // A wheel burst has no release event. A quiet interval marks finger lift;
      // a burst that began below the top never turns into a refresh on reaching it.
      if (this.wheelLastAt === 0 || now - this.wheelLastAt > 160) {
        this.resetWheelPull()
        this.wheelStartedAtTop = scroll.scrollTop === 0
      }
      this.wheelLastAt = now
      if (this.wheelReleaseTimer !== undefined)
        clearTimeout(this.wheelReleaseTimer)
      this.wheelReleaseTimer = undefined
      if (
        event.ctrlKey ||
        (event.target instanceof Element &&
          Boolean(
            event.target.closest('input, textarea, [contenteditable="true"]'),
          )) ||
        event.deltaMode !== 0 ||
        event.deltaY >= 0 ||
        Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
        scroll.scrollTop !== 0 ||
        this.wheelRefreshing ||
        this.isRefreshing ||
        now < this.wheelCooldownUntil
      ) {
        this.wheelStartedAtTop = false
        this.wheelPullDistance = 0
        return
      }
      if (!this.wheelStartedAtTop) return
      event.preventDefault()
      this.wheelPullDistance = Math.min(
        140,
        this.wheelPullDistance - event.deltaY,
      )
      this.wheelReleaseTimer = setTimeout(() => {
        const ready = this.wheelPullReady
        this.resetWheelPull()
        if (!ready || this.isRefreshing || this.wheelRefreshing) return
        this.wheelCooldownUntil = performance.now() + 1000
        this.wheelRefreshing = true
        const revision = ++this.wheelRefreshRevision
        void this.refreshContent().finally(() => {
          if (this.wheelRefreshRevision === revision)
            this.wheelRefreshing = false
        })
      }, 160)
    },
    toggleSettingsDrawerOpen() {
      this.$emit('toggleMyDrawerOpen')
    },
    pullToRefresh(done: () => void) {
      void this.refreshContent().finally(done)
    },
    async refreshContent() {
      try {
        const wallet = peekActiveWallet()
        await this.refreshMessages({ wallet, topic: this.selectedTopic })
      } catch (error) {
        // Handled: forumStore records outageStatus; no unhandled browser exception
      }
    },
    async setTopic(text: string) {
      this.selectedTopic = text
      if (this.$route.path !== '/forum') {
        await this.$router.push('/forum')
      }
      void this.refreshContent()
    },
    navigateBack() {
      void this.$router.push('/forum')
    },
    clearTopic() {
      this.selectedTopic = ''
      void this.refreshContent()
    },
  },
  computed: {
    wheelPullReady(): boolean {
      return this.wheelPullDistance >= 100
    },
    narrow(): boolean {
      const raw =
        this.$q?.screen?.width ??
        (typeof window !== 'undefined' ? window.innerWidth : 1024)
      return isNarrowWidth(getEffectiveScreenWidth(raw))
    },
    isThreadRoute(): boolean {
      return (
        Boolean(this.$route?.params?.payloadDigest) ||
        Boolean(this.$route?.params?.parentDigest) ||
        Boolean(
          this.$route?.path?.startsWith('/forum/') &&
            this.$route?.path !== '/forum',
        ) ||
        Boolean(this.$route?.path?.startsWith('/new-post'))
      )
    },
    selectedTopic: {
      set(newVal?: string) {
        this.setSelectedTopic(newVal ?? '')
        // If the contents were cleared then we should refresh.
        if (!newVal) {
          void this.refreshContent()
        }
      },
      get(): string {
        return this.storeSelectedTopic
      },
    },
  },
})
</script>

<style scoped>
.forum-wheel-refresh {
  gap: 8px;
  position: absolute;
  z-index: 2;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(100% - 32px);
  padding: 8px 12px;
  border-radius: 24px;
  pointer-events: none;
}

.forum-refresh-surface {
  flex: 1;
}

.forum-toolbar-title {
  min-width: 0;
}
</style>
