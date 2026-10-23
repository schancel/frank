<template>
  <div class="column full-height">
    <q-scroll-area class="col">
      <q-list>
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
          <div style="width: 250px" class="q-mx-sm">
            <div class="row items-center justify-between q-mb-xs">
              <span class="text-caption text-weight-medium">{{
                $t('forum.percentileFilter')
              }}</span>
              <span
                class="text-caption text-primary text-weight-bold"
                data-test="forum-percentile-label"
                >{{ percentileLabel }}</span
              >
            </div>
            <q-slider
              v-model="sliderPercentile"
              :min="0"
              :max="100"
              :step="1"
              color="primary"
              dense
              data-test="forum-percentile-slider"
              @update:model-value="onSliderChange"
            />
            <div class="row q-gutter-xs q-mt-xs justify-between">
              <q-btn
                v-for="preset in percentilePresets"
                :key="preset.value"
                size="xs"
                dense
                flat
                :color="
                  currentPercentile === preset.value ? 'primary' : 'grey-7'
                "
                :label="preset.label"
                @click="onSelectPercentile(preset.value)"
              />
            </div>
          </div>
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
          <div style="width: 250px" class="q-mx-sm">
            <q-input
              class="q-pa-none"
              v-model="voteAmount"
              data-test="forum-vote-amount"
              data-testid="forum-vote-amount-input"
              :label="voteAmountLabel"
              :placeholder="defaultVoteAmountPlaceholder"
              clearable
              use-input
            />
            <div class="row q-gutter-xs q-mt-xs justify-between">
              <q-btn
                v-for="preset in voteAmountPresets"
                :key="preset.label"
                size="xs"
                dense
                flat
                no-caps
                :color="
                  isVoteAmountPresetActive(preset.value) ? 'primary' : 'grey-7'
                "
                :label="preset.label"
                :data-test="`forum-vote-amount-preset-${
                  preset.value || 'default'
                }`"
                @click="onSelectVoteAmount(preset.value)"
              />
            </div>
          </div>
        </q-item>

        <q-item>
          <q-btn
            color="primary"
            class="q-mx-sm q-pa-sm"
            label="Create Post"
            to="/new-post"
          />
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

const PERCENTILE_PRESETS = [
  { label: 'All', value: 0 },
  { label: '50%', value: 50 },
  { label: '25%', value: 75 },
  { label: '10%', value: 90 },
  { label: '5%', value: 95 },
]

const VOTE_AMOUNT_PRESETS = [
  { label: 'Default', value: '' },
  { label: '0.01', value: '0.01' },
  { label: '0.1', value: '0.1' },
  { label: '1', value: '1' },
]

export default defineComponent({
  setup() {
    const forum = useForumStore()
    const {
      topics,
      selectedTopic,
      sortMode,
      duration,
      voteThreshold,
      votePercentile,
      voteAmountDisplay,
      messages,
    } = storeToRefs(forum)

    const topicStore = useTopicStore()
    onMounted(() => {
      topicStore.refreshDiscoveredTopics()
    })
    const discoveredTopicNames = computed(() =>
      Object.keys(topicStore.topics).sort(),
    )

    const topicWeights = computed<bigint[]>(() => {
      const topic = selectedTopic.value
      const list = (messages?.value || []).filter(msg =>
        topic ? msg.topic.startsWith(topic) : true,
      )
      return list
        .map(msg => {
          try {
            return BigInt(msg.voteWeightWei)
          } catch {
            return 0n
          }
        })
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    })

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
      storeVotePercentile: votePercentile,
      storeVoteAmountDisplay: voteAmountDisplay,
      topicWeights,
      refreshMessages: forum.refreshMessages,
      setSelectedTopic: forum.setSelectedTopic,
      setSortMode: forum.setSortMode,
      setDuration: forum.setDuration,
      setVoteThreshold: forum.setVoteThreshold,
      setVotePercentile: forum.setVotePercentile,
      setVoteAmountDisplay: forum.setVoteAmountDisplay,
    }
  },
  components: {},
  data() {
    return {
      sortModes: sortModes,
      durations: DURATIONS,
      percentilePresets: PERCENTILE_PRESETS,
      voteAmountPresets: VOTE_AMOUNT_PRESETS,
      sliderPercentile: 0,
      // Ticket #61: the field itself now interprets this in the active chain's display unit
      // (chain/evm-chain.ts's fromDisplayAmount, MON) -- labeling it so a Monad user doesn't
      // read this as a Lotus-XPI amount, matching the mismatch already found in Forum.vue.
      chainUnit: activeChain.unit,
    }
  },
  watch: {
    currentPercentile: {
      immediate: true,
      handler(newVal: number) {
        this.sliderPercentile = newVal
      },
    },
    topicWeights: {
      handler() {
        if (
          this.storeVotePercentile !== null &&
          this.storeVotePercentile !== undefined
        ) {
          this.applyPercentileCutoff(this.storeVotePercentile)
        }
      },
    },
  },
  methods: {
    async refreshContent() {
      if (this.$route.path !== '/forum') {
        await this.$router.push('/forum')
      }
      try {
        const wallet = await useActiveWallet()
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
    async onTopicClear() {
      this.selectedTopic = ''
      if (this.$route.path !== '/forum') {
        await this.$router.push('/forum')
      }
      void this.refreshContent()
    },
    onSliderChange(val: number | null) {
      if (val === null || val === undefined) return
      const p = Math.min(100, Math.max(0, Math.round(val)))
      this.sliderPercentile = p
      this.setVotePercentile?.(p)
      this.applyPercentileCutoff(p)
    },
    onSelectPercentile(val: number) {
      const p = Math.min(100, Math.max(0, Math.round(val)))
      this.sliderPercentile = p
      this.setVotePercentile?.(p)
      this.applyPercentileCutoff(p)
    },
    applyPercentileCutoff(percentile: number) {
      const p = Math.min(100, Math.max(0, percentile))
      if (p === 0 || !this.topicWeights || this.topicWeights.length === 0) {
        this.setVoteThreshold('0')
        return
      }
      const index = Math.min(
        this.topicWeights.length - 1,
        Math.floor((p / 100) * this.topicWeights.length),
      )
      const wei = this.topicWeights[index]
      if (wei === 0n) {
        this.setVoteThreshold('0')
        return
      }
      try {
        const display =
          typeof (activeChain as any).toDisplayAmount === 'function'
            ? activeChain.toDisplayAmount(wei)
            : String(wei)
        this.setVoteThreshold(display)
      } catch {
        this.setVoteThreshold('0')
      }
    },
    onSelectVoteAmount(val: string) {
      this.voteAmount = val
    },
    isVoteAmountPresetActive(val: string): boolean {
      return (this.storeVoteAmountDisplay ?? '') === val
    },
  },
  computed: {
    voteAmountLabel(): string {
      return `Vote Amount (${this.chainUnit})`
    },
    defaultVoteAmountPlaceholder(): string {
      try {
        if (
          typeof (activeChain as any).toDisplayAmount === 'function' &&
          activeChain.defaultTopicVoteValue !== undefined
        ) {
          return activeChain.toDisplayAmount(activeChain.defaultTopicVoteValue)
        }
      } catch {
        // Fallback below
      }
      return '0.01'
    },
    currentPercentile(): number {
      if (
        this.storeVotePercentile !== null &&
        this.storeVotePercentile !== undefined
      ) {
        return this.storeVotePercentile
      }
      const current = this.storeVoteThreshold
      if (!current || current === '0') return 0
      if (!this.topicWeights || this.topicWeights.length === 0) return 0
      let raw: bigint
      try {
        raw = activeChain.fromDisplayAmount(current)
      } catch {
        return 0
      }
      if (raw <= 0n) return 0
      let below = 0
      for (const w of this.topicWeights) {
        if (w < raw) below++
      }
      const p = Math.round((below / this.topicWeights.length) * 100)
      return Math.min(100, Math.max(0, p))
    },
    percentileLabel(): string {
      const p = this.currentPercentile
      if (p <= 0) {
        return this.$t ? this.$t('forum.allPosts') : 'All posts'
      }
      const topPercent = Math.max(1, 100 - p)
      return `Top ${topPercent}%`
    },
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
        this.setVotePercentile?.(null)
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
    voteAmount: {
      set(newVal?: string | null) {
        const trimmed = String(newVal ?? '').trim()
        if (!trimmed) {
          this.setVoteAmountDisplay?.('')
          return
        }
        try {
          const parsed = activeChain.fromDisplayAmount(trimmed)
          if (parsed > 0n) {
            this.setVoteAmountDisplay?.(trimmed)
          } else {
            this.setVoteAmountDisplay?.('')
          }
        } catch {
          this.setVoteAmountDisplay?.('')
        }
      },
      get(): string {
        return (this.storeVoteAmountDisplay ?? '').toString()
      },
    },
  },
})
</script>
