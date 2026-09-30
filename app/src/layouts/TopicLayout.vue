<template>
  <div>
    <q-drawer
      v-model="showTopicDrawer"
      side="right"
      :breakpoint="drawerBreakpoint"
      show-if-above
    >
      <topic-drawer :topic="topic" />
    </q-drawer>

    <q-header>
      <q-toolbar class="q-pl-sm">
        <q-btn
          class="q-px-sm"
          flat
          dense
          @click="toggleSettingsDrawerOpen"
          icon="menu"
        />
        <q-toolbar-title class="h6">{{ topic }}</q-toolbar-title>
        <q-space />
        <q-btn
          class="q-px-sm"
          flat
          dense
          @click="toggleTopicDrawer"
          icon="settings"
        />
      </q-toolbar>
    </q-header>

    <q-page-container>
      <q-page>
        <router-view />
      </q-page>
    </q-page-container>

    <q-footer bordered v-show="$status.setup">
      <topic-input
        @send-message="sendMessage"
        v-model:message="message"
        :disable="sendingMessage"
      />
    </q-footer>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue'
import { RouteLocationNormalized, useRouter } from 'vue-router'

import TopicInput from 'src/components/topic/TopicInput.vue'
import TopicDrawer from 'src/components/topic/TopicDrawer.vue'

import { useTopicStore } from 'src/stores/topics'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import {
  BurnRefreshError,
  notifyBurnFailure,
} from 'src/utils/burn-refresh-error'
import { DRAWER_BREAKPOINT } from 'src/utils/layout'
import assert from 'assert'

export default defineComponent({
  data() {
    return {
      message: '',
      sendingMessage: false,
      drawerBreakpoint: DRAWER_BREAKPOINT,
    }
  },
  props: {},
  components: {
    TopicInput,
    TopicDrawer,
  },
  setup() {
    const router = useRouter()
    const topicsStore = useTopicStore()
    const routeParams = router.currentRoute.value.params
    const topic = routeParams['topic']
    const showTopicDrawer = ref(false)
    const toggleTopicDrawer = () => {
      showTopicDrawer.value = !showTopicDrawer.value
    }
    assert(typeof topic === 'string', 'Topic param should be string')
    return {
      topic: ref(topic),
      putMessage: topicsStore.putMessage,
      showTopicDrawer,
      toggleTopicDrawer,
    }
  },
  emits: ['toggleMyDrawerOpen'],
  beforeRouteUpdate(
    to: RouteLocationNormalized,
    from: RouteLocationNormalized,
    next: () => void,
  ) {
    console.log('moving')
    this.topic = to.params.topic as string
    next()
  },
  methods: {
    async sendMessage(message: string) {
      if (this.sendingMessage || !message) {
        // Don't send blank messages
        return
      }

      const submittedMessage = message
      this.sendingMessage = true
      if (this.message === submittedMessage) this.message = ''

      const entry = {
        kind: 'post' as const,
        message: submittedMessage,
      }

      console.log('posting message', entry)
      if (!entry) {
        console.error('entry is null in CreatePost.vue post handler')
        return
      }

      try {
        const wallet = await useActiveWallet()
        await this.putMessage({
          wallet,
          entry,
          topic: this.topic,
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        // A burn that landed but could not be read back clears the draft (resending would burn
        // again) and says so; any other failure keeps the draft for a retry.
        notifyBurnFailure(err, key => this.$t(key))
        if (!(err instanceof BurnRefreshError)) {
          // Restore a post that never landed without overwriting a new draft typed in flight.
          this.message = this.message
            ? `${submittedMessage}\n${this.message}`
            : submittedMessage
        }
        return
      } finally {
        this.sendingMessage = false
      }
    },
    toggleSettingsDrawerOpen() {
      this.$emit('toggleMyDrawerOpen')
    },
  },
})
</script>
