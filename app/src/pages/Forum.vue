<template>
  <div class="forum-feed-container">
    <div
      v-if="stampPreparationStatus"
      class="full-width text-caption text-center bg-accent text-white q-py-xs q-mb-sm rounded-borders"
      role="status"
      data-testid="stamp-preparation-status"
    >
      {{ stampPreparationStatus }}
    </div>
    <div
      v-if="selectedTopic"
      class="row items-center q-px-sm q-py-xs q-mb-md active-topic-banner rounded-borders"
      data-test="forum-active-topic-banner"
    >
      <q-icon name="filter_alt" size="18px" class="q-mr-xs text-grey-6" />
      <span class="text-caption text-grey-7 q-mr-xs"
        >{{ $t('forum.filteredBy') }}:</span
      >
      <q-chip
        dense
        removable
        size="sm"
        color="primary"
        text-color="white"
        class="text-weight-bold"
        data-test="feed-topic-chip"
        @remove="clearFilter"
      >
        #{{ selectedTopic }}
      </q-chip>
      <q-space />
      <q-btn
        flat
        dense
        no-caps
        size="sm"
        color="primary"
        :label="$t('forum.clearTopicFilter')"
        data-test="clear-topic-filter"
        @click="clearFilter"
      />
    </div>
    <template v-if="sortedPosts && sortedPosts.length > 0">
      <div
        v-if="outageStatus === 'outage'"
        class="q-pa-sm"
        data-test="forum-outage-banner"
      >
        <q-banner rounded class="bg-negative text-white" role="alert">
          <template #avatar>
            <q-icon name="cloud_off" color="white" />
          </template>
          <div class="text-weight-bold">{{ $t('forum.outageTitle') }}</div>
          <div>{{ $t('forum.outageBanner') }}</div>
          <template #action>
            <q-btn
              flat
              color="white"
              :label="$t('forum.retry')"
              :loading="isRefreshing"
              data-test="forum-retry-button"
              @click="retryRefresh"
            />
          </template>
        </q-banner>
      </div>
      <div
        v-else-if="outageStatus === 'degraded'"
        class="q-pa-sm"
        data-test="forum-degraded-banner"
      >
        <q-banner rounded class="bg-warning text-dark" role="alert">
          <template #avatar>
            <q-icon name="sync_problem" color="dark" />
          </template>
          <div class="text-weight-bold">{{ $t('forum.degradedTitle') }}</div>
          <div>{{ $t('forum.degradedBanner') }}</div>
          <template #action>
            <q-btn
              flat
              color="dark"
              :label="$t('forum.retry')"
              :loading="isRefreshing"
              data-test="forum-retry-button"
              @click="retryRefresh"
            />
          </template>
        </q-banner>
      </div>
      <template v-for="message in sortedPosts" :key="message.payloadDigest">
        <forum-post
          v-show="showMessage(message.topic)"
          @set-topic="(...args) => $emit('set-topic', ...args)"
          :message="message"
          :show-parent="true"
          :show-replies="false"
        />
      </template>
    </template>
    <!-- Ticket #61: hasFetchedOnce distinguishes "still loading" from "loaded, really no posts" -->
    <template v-else-if="!hasFetchedOnce">
      <div>
        <q-spinner-puff class="absolute-center" color="purple" size="20rem" />
      </div>
    </template>
    <!-- Ticket #533: when initial refresh experiences an outage, exit loading and render clear alert with retry -->
    <template v-else-if="outageStatus === 'outage'">
      <div
        class="column items-center justify-center q-pa-xl text-center"
        data-test="forum-outage-state"
        role="alert"
      >
        <q-icon name="cloud_off" size="4rem" color="negative" class="q-mb-md" />
        <div class="text-h6 q-mb-sm">{{ $t('forum.outageTitle') }}</div>
        <div class="text-body2 text-grey-7 q-mb-md">
          {{ $t('forum.outageDescription') }}
        </div>
        <q-btn
          color="primary"
          :label="$t('forum.retry')"
          :loading="isRefreshing"
          data-test="forum-retry-button"
          @click="retryRefresh"
        />
      </div>
    </template>
    <!-- Ticket #533: partial topic failure with no posts rendered reports degraded state with retry -->
    <template v-else-if="outageStatus === 'degraded'">
      <div class="q-pa-sm" data-test="forum-degraded-banner">
        <q-banner rounded class="bg-warning text-dark q-mb-md" role="alert">
          <template #avatar>
            <q-icon name="sync_problem" color="dark" />
          </template>
          <div class="text-weight-bold">{{ $t('forum.degradedTitle') }}</div>
          <div>{{ $t('forum.degradedBanner') }}</div>
          <template #action>
            <q-btn
              flat
              color="dark"
              :label="$t('forum.retry')"
              :loading="isRefreshing"
              data-test="forum-retry-button"
              @click="retryRefresh"
            />
          </template>
        </q-banner>
      </div>
      <div class="column items-center text-center text-grey q-pa-xl">
        <div class="q-mb-sm">{{ $t('forum.noPosts') }}</div>
        <q-btn
          v-if="selectedTopic"
          flat
          dense
          no-caps
          color="primary"
          :label="$t('forum.clearTopicFilter')"
          data-test="empty-clear-topic-filter"
          @click="clearFilter"
        />
      </div>
    </template>
    <template v-else>
      <div class="column items-center text-center text-grey q-pa-xl">
        <div class="q-mb-sm">{{ $t('forum.noPosts') }}</div>
        <q-btn
          v-if="selectedTopic"
          flat
          dense
          no-caps
          color="primary"
          :label="$t('forum.clearTopicFilter')"
          data-test="empty-clear-topic-filter"
          @click="clearFilter"
        />
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, onUnmounted, watch, computed } from 'vue'
import { storeToRefs } from 'pinia'

import { activeChain } from '@frank/wallet/chain'
import { accountStatus } from 'src/accounts/session'
import { useForumStore } from 'src/stores/forum'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { sortPostsByMode } from '../utils/sorting'

import ForumPost from '../components/forum/ForumPost.vue'

export default defineComponent({
  props: {},
  components: {
    ForumPost,
  },
  emits: ['set-topic'],
  setup() {
    const forumStore = useForumStore()
    onUnmounted(() => forumStore.invalidateRefresh())
    watch(
      () => [accountStatus.revision, accountStatus.status],
      () => forumStore.invalidateRefresh(),
    )
    const {
      messages,
      sortMode,
      topics,
      selectedTopic,
      voteThreshold,
      duration,
      hasFetchedOnce,
      outageStatus,
      isRefreshing,
      stampPreparationStatus,
    } = storeToRefs(forumStore)
    const showMessage = (topic: string) => {
      return topic.startsWith(selectedTopic.value)
    }
    const retryRefresh = async () => {
      try {
        let wallet
        try {
          wallet = await useActiveWallet()
        } catch {
          // Public reading requires no active wallet
        }
        await forumStore.refreshMessages({
          wallet,
          topic: selectedTopic.value,
        })
      } catch (error) {
        // Handled: store records outageStatus; no unhandled browser exception
      }
    }
    const sortedPosts = computed(() => {
      if (!messages) {
        return
      }
      const from = Date.now() - duration.value
      const filteredMessages = messages.value.filter(message => {
        // Real bug found live: this never filtered by `selectedTopic` at all -- only the
        // template's `v-show="showMessage(...)"` did, per-rendered-item. That meant
        // `sortedPosts.length > 0` (this computed's return) stayed true as long as *any* topic
        // had posts, even when every single one was hidden for the currently selected topic --
        // so the template's `v-if="sortedPosts?.length > 0"` branch won, and the `v-else`/
        // `v-else-if` branches that show "No posts yet." or the loading spinner never got a
        // chance to run. Net effect: switching to a topic with zero posts (but the relay having
        // *any* posts at all, in any topic) rendered a fully blank page -- not even an empty
        // state, since every v-for'd item existed in the DOM with `v-show="false"`. Filtering
        // here too, matching `showMessage`, makes `.length` (and therefore the empty-state
        // branching) reflect what's actually visible.
        //
        // FIXME: Something is converting the timestamp to a string.
        return (
          new Date(message.timestamp).valueOf() >= from &&
          showMessage(message.topic)
        )
      })
      let voteThresholdRaw: bigint
      try {
        voteThresholdRaw = activeChain.fromDisplayAmount(voteThreshold.value)
      } catch {
        return []
      }
      return sortPostsByMode(filteredMessages, sortMode.value).filter(
        msg => BigInt(msg.voteWeightWei) >= voteThresholdRaw,
      )
    })

    const clearFilter = async () => {
      forumStore.setSelectedTopic('')
      await retryRefresh()
    }

    return {
      duration,
      sortedPosts,
      sortMode,
      topics,
      selectedTopic,
      voteThreshold,
      hasFetchedOnce,
      outageStatus,
      isRefreshing,
      retryRefresh,
      clearFilter,
      showMessage,
      stampPreparationStatus,
    }
  },
})
</script>

<style lang="scss" scoped>
.forum-feed-container {
  max-width: 860px;
  margin: 0 auto;
  padding: 8px 12px 32px;
}

.active-topic-banner {
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(0, 0, 0, 0.03);
}

body.body--dark {
  .active-topic-banner {
    border-color: rgba(255, 255, 255, 0.12);
    background: rgba(255, 255, 255, 0.04);
  }
}
</style>
