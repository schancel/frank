<template>
  <div class="column full-height">
    <q-scroll-area class="col">
      <q-list>
        <q-item>
          <q-input
            filled
            class="q-mx-sm q-pa-none"
            v-model="selectedTopic"
            data-test="forum-topic"
            label="Topic"
            style="width: 250px"
            @keyup.enter.prevent="refreshContent"
            clearable
          />
        </q-item>

        <q-item>
          <q-select
            class="q-mx-sm q-pa-none"
            v-model="sortMode"
            :options="sortModes"
            label="Sort"
            style="width: 250px"
            use-input
          />
        </q-item>

        <q-item>
          <q-select
            class="q-mx-sm q-pa-none"
            v-model="duration"
            :options="durations"
            label="Duration"
            style="width: 250px"
            use-input
          />
        </q-item>

        <q-item>
          <q-input
            class="q-mx-sm q-pa-none"
            v-model="threshold"
            data-test="forum-threshold"
            :label="`Vote Threshold (${chainUnit})`"
            style="width: 250px"
            use-input
          />
        </q-item>

        <q-item>
          <q-btn
            color="primary"
            class="q-mx-sm q-pa-sm"
            label="Create Post"
            to="/new-post"
          />
        </q-item>

        <!-- Ticket #72 built a real backend index of discovered topic names (post count +
        last-activity) plus a store action to fetch it (`useTopicStore().refreshDiscoveredTopics`,
        wired into `ForumLayout.vue`'s `mounted()`) -- but nothing in the actual visible UI ever
        read the result. The "Topic" field above was the only way to switch topics, and it's a
        free-text input: you had to already know a topic's exact name to type it in. This list
        surfaces that already-built, already-fetched discovery data as something genuinely
        clickable. -->
        <q-separator class="q-my-sm" />
        <q-item-label header>Browse Topics</q-item-label>
        <q-item
          v-for="name in discoveredTopicNames"
          :key="name"
          clickable
          :active="name === selectedTopic"
          active-class="text-primary"
          @click="setTopic(name)"
        >
          <q-item-section>{{ name }}</q-item-section>
          <q-item-section side v-if="discoveredTopics[name]">
            <span data-test="forum-topic-count" :data-topic="name">{{
              discoveredTopics[name].postCount
            }}</span>
            <span class="text-caption">{{ $t('forum.postsLabel') }}</span>
          </q-item-section>
        </q-item>
        <q-item v-if="discoveredTopicNames.length === 0">
          <q-item-section class="text-grey"
            >No topics discovered yet.</q-item-section
          >
        </q-item>
      </q-list>
    </q-scroll-area>
  </div>
</template>

<script lang="ts">
import { useForumStore } from 'src/stores/forum'
import { useTopicStore } from 'src/stores/topics'
import { storeToRefs } from 'pinia'
import { computed, defineComponent, onMounted } from 'vue'

import { activeChain } from '@frank/wallet/chain'
import { sortModes, SortMode } from '../../utils/sorting'
import { useActiveWallet } from 'src/composables/useActiveWallet'

const DURATIONS = [
  { label: '1 Day', value: 1000 * 60 * 60 * 24 * 1 },
  { label: '1 Week', value: 1000 * 60 * 60 * 24 * 7 },
  { label: '1 Month', value: 1000 * 60 * 60 * 24 * 31 },
]

export default defineComponent({
  setup() {
    const forum = useForumStore()
    const { topics, selectedTopic, sortMode, duration, voteThreshold } =
      storeToRefs(forum)

    // Ticket #72's discovery index + `refreshDiscoveredTopics` action already exist on
    // `useTopicStore` (a separate, older store from `useForumStore` above -- see this file's
    // template comment) -- fetch it here too, alongside `ForumLayout.vue`'s own call on mount, so
    // this drawer's list is fresh whenever it's actually opened, not just once at layout mount.
    const topicStore = useTopicStore()
    onMounted(() => {
      topicStore.refreshDiscoveredTopics()
    })
    const discoveredTopicNames = computed(() =>
      Object.keys(topicStore.topics).sort(),
    )

    return {
      topics,
      discoveredTopicNames,
      discoveredTopics: computed(() =>
        topicStore.discoveryStatus === 'verified'
          ? topicStore.discoveredTopics
          : ({} as typeof topicStore.discoveredTopics),
      ),
      storeSelectedTopic: selectedTopic,
      storeSortMode: sortMode,
      storeDuration: duration,
      storeVoteThreshold: voteThreshold,
      refreshMessages: forum.refreshMessages,
      setSelectedTopic: forum.setSelectedTopic,
      setSortMode: forum.setSortMode,
      setDuration: forum.setDuration,
      setVoteThreshold: forum.setVoteThreshold,
    }
  },
  components: {},
  data() {
    return {
      sortModes: sortModes,
      durations: DURATIONS,
      // Ticket #61: the field itself now interprets this in the active chain's display unit
      // (chain/monad-chain.ts's fromDisplayAmount, MON) -- labeling it so a Monad user doesn't
      // read this as a Lotus-XPI amount, matching the mismatch already found in Forum.vue.
      chainUnit: activeChain.unit,
    }
  },
  methods: {
    async refreshContent() {
      try {
        const wallet = await useActiveWallet()
        await this.refreshMessages({ wallet, topic: this.selectedTopic })
      } catch (error) {
        // Handled: forumStore records outageStatus; no unhandled browser exception
      }
    },
    setTopic(text: string) {
      this.selectedTopic = text
      void this.refreshContent()
    },
  },
  computed: {
    sortMode: {
      set(newVal?: string) {
        if (!newVal || !sortModes.includes(newVal as SortMode)) {
          return
        }
        this.setSortMode(newVal as SortMode)
      },
      get(): string {
        return this.storeSortMode
      },
    },
    selectedTopic: {
      set(newVal?: string) {
        this.setSelectedTopic(newVal ?? '')
      },
      get(): string {
        return this.storeSelectedTopic
      },
    },
    duration: {
      set(newVal?: { label: string; value: number }) {
        this.setDuration(newVal?.value ?? 0)
        this.refreshContent()
      },
      get(): { label: string; value: number } | undefined {
        return DURATIONS.find(duration => duration.value === this.storeDuration)
      },
    },
    threshold: {
      set(newVal?: string) {
        const value = String(newVal ?? '0')
        try {
          activeChain.fromDisplayAmount(value)
          this.setVoteThreshold(value)
        } catch {
          this.setVoteThreshold('0')
        }
      },
      get(): string {
        return this.storeVoteThreshold.toString()
      },
    },
  },
})
</script>
