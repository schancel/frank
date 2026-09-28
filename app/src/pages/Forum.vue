<template>
  <template v-if="sortedPosts?.length > 0">
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
  <!-- Ticket #61 (found live): hasFetchedOnce distinguishes "still loading" from "loaded, really
  no posts" -- this used to spin forever in both cases, with no way to tell a genuinely empty
  forum from a stuck fetch. -->
  <template v-else-if="!hasFetchedOnce">
    <div>
      <q-spinner-puff class="absolute-center" color="purple" size="20rem" />
    </div>
  </template>
  <template v-else>
    <div class="text-center text-grey q-pa-xl">No posts yet.</div>
  </template>
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue'
import { storeToRefs } from 'pinia'

import { activeChain } from '@frank/wallet/chain'
import { useForumStore } from 'src/stores/forum'
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
    const {
      messages,
      sortMode,
      topics,
      selectedTopic,
      voteThreshold,
      duration,
      hasFetchedOnce,
    } = storeToRefs(forumStore)
    const showMessage = (topic: string) => {
      return topic.startsWith(selectedTopic.value)
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
      console.log(filteredMessages)
      // Ticket #61: this used `* 1_000_000` (Lotus sats-per-XPI) against `msg.satoshis`, which for
      // Monad-sourced posts is actually `view.voteWeight` in wei (see chain/monad-chain.ts's
      // `viewToForumMessage`) -- a Lotus-scale constant against a wei-scale value, off by 12 orders
      // of magnitude. Uses `activeChain.fromDisplayAmount` (already-established chain-agnostic
      // display<->raw conversion, `chain/active-chain.ts`) so the "Vote Threshold" field in
      // ForumDrawer.vue is interpreted in the active chain's own display unit (MON), not a
      // hardcoded Lotus one. Not renaming `satoshis` itself here -- that's the pre-existing,
      // deliberately-deferred field-name question this code's own header already flags.
      const voteThresholdRaw = Number(
        activeChain.fromDisplayAmount(voteThreshold.value.toString()),
      )
      return sortPostsByMode(filteredMessages, sortMode.value).filter(
        msg => msg.satoshis >= voteThresholdRaw,
      )
    })

    return {
      duration,
      sortedPosts,
      sortMode,
      topics,
      selectedTopic,
      voteThreshold,
      hasFetchedOnce,
      showMessage,
    }
  },
})
</script>
