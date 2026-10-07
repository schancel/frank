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
          class="q-px-sm"
          flat
          dense
          @click="navigateBack"
          icon="arrow_back"
          :aria-label="$t('a11y.backToForum')"
          data-test="forum-back"
        />
        <q-btn
          class="q-px-sm"
          flat
          dense
          @click="toggleSettingsDrawerOpen"
          icon="menu"
          :aria-label="$t('a11y.openNavigation')"
          :aria-expanded="myDrawerOpen"
          data-test="forum-menu"
        />
        <q-toolbar-title class="h6">
          <div
            v-if="isThreadRoute"
            class="row items-center no-wrap cursor-pointer"
            @click="navigateBack"
            data-test="forum-breadcrumb"
          >
            <span>{{ $t('leftDrawer.forum') }}</span>
            <q-icon
              name="chevron_right"
              size="18px"
              class="q-mx-xs text-grey-5"
            />
            <q-chip
              v-if="selectedTopic"
              dense
              outline
              size="sm"
              color="white"
              text-color="white"
              class="q-ma-none text-weight-medium"
            >
              #{{ selectedTopic }}
            </q-chip>
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
            <q-icon
              name="chevron_right"
              size="18px"
              class="q-mx-xs text-grey-5"
            />
            <q-chip
              dense
              removable
              size="sm"
              color="white"
              text-color="primary"
              class="q-ma-none text-weight-medium cursor-pointer"
              data-test="forum-active-topic-chip"
              @remove="clearTopic"
              @click="clearTopic"
            >
              #{{ selectedTopic }}
            </q-chip>
          </div>
          <span v-else>{{ $t('leftDrawer.forum') }}</span>
        </q-toolbar-title>
        <q-space />
        <q-btn
          icon="refresh"
          :aria-label="$t('a11y.forumRefresh')"
          flat
          class="q-mx-none q-pa-sm"
          :loading="isRefreshing"
          @click="refreshContent"
        />
        <q-btn
          flat
          icon="menu_book"
          class="q-mx-none q-pa-sm"
          to="/docs"
          aria-label="Documentation"
        >
          <q-tooltip>Documentation & Protocol</q-tooltip>
        </q-btn>
        <q-btn
          flat
          icon="post_add"
          class="q-mx-none q-pa-sm"
          to="/new-post"
          :aria-label="$t('a11y.newPost')"
        />
        <q-btn
          icon="settings"
          flat
          :aria-label="$t('a11y.forumSettings')"
          :aria-expanded="showForumDrawer"
          class="q-mx-none q-pa-sm"
          @click="showForumDrawer = !showForumDrawer"
        />
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page>
        <q-scroll-area
          ref="chatScroll"
          class="q-px-sm absolute full-width full-height"
        >
          <router-view @set-topic="setTopic" />
        </q-scroll-area>
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

import { useMyDrawerOpen } from '../composables/useMyDrawerOpen'
import { storeToRefs } from 'pinia'

import { useForumStore } from 'src/stores/forum'
import { useTopicStore } from 'src/stores/topics'
import { useActiveWallet } from 'src/composables/useActiveWallet'

import ForumDrawer from '../components/panels/ForumDrawer.vue'
import { DRAWER_BREAKPOINT } from '../utils/layout'

export default defineComponent({
  data() {
    return {
      showForumDrawer: false,
      drawerBreakpoint: DRAWER_BREAKPOINT,
    }
  },
  setup() {
    const forumStore = useForumStore()
    const topicStore = useTopicStore()
    const { topics, selectedTopic, isRefreshing } = storeToRefs(forumStore)

    return {
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
  components: { ForumDrawer },
  emits: ['toggleMyDrawerOpen'],
  mounted() {
    void this.refreshContent()
    // Fire-and-forget: `refreshDiscoveredTopics` already fails soft (never throws, see
    // `stores/topics.ts`), so there's nothing meaningful to await or catch here -- matches
    // `refreshContent`'s own un-awaited call just above.
    this.refreshDiscoveredTopics()
  },
  methods: {
    toggleSettingsDrawerOpen() {
      this.$emit('toggleMyDrawerOpen')
    },
    async refreshContent() {
      try {
        let wallet
        try {
          wallet = await useActiveWallet()
        } catch {
          // Public reading requires no active wallet
        }
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
