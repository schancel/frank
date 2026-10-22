<template>
  <q-page-container class="col full-height overflow-hidden">
    <q-page
      class="new-group-page q-pa-sm"
      :style-fn="pageStyle"
      data-test="new-group-page"
    >
      <template v-if="invalidMembers || unavailableReason">
        <q-btn
          flat
          icon="arrow_back"
          :label="$t('groupChat.cancel')"
          @click="cancel"
        />
        <q-banner class="text-negative" role="alert">{{
          $t(invalidMembers ? 'groupChat.invalidMembers' : unavailableReason)
        }}</q-banner>
      </template>
      <new-group-form
        v-else
        :key="$route.fullPath"
        :initial-members="initialMembers"
        @cancel="cancel"
      />
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { computed, defineComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import NewGroupForm from '../components/chat/NewGroupForm.vue'
import { isChainAddress, toChainDisplayAddress } from '../utils/chain-address'
import { activeChain } from '@frank/wallet/chain'
import { messagingState } from '../utils/messaging-state'
import { viewportPageStyle } from '../utils/layout'

export default defineComponent({
  name: 'NewGroupPage',
  components: { NewGroupForm },
  setup() {
    const route = useRoute()
    const router = useRouter()
    const unavailableReason = computed(() =>
      !activeChain.capabilities.directMessages
        ? 'groupChat.unavailableNetwork'
        : messagingState.status !== 'ready'
        ? 'groupChat.messagingNotReady'
        : '',
    )
    const members = computed(() => {
      const value = route.query.member
      return value === undefined ? [] : Array.isArray(value) ? value : [value]
    })
    const invalidMembers = computed(() =>
      members.value.some(
        value => typeof value !== 'string' || !isChainAddress(value),
      ),
    )
    const initialMembers = computed(() =>
      invalidMembers.value
        ? []
        : members.value
            .filter((value): value is string => typeof value === 'string')
            .map(toChainDisplayAddress),
    )
    const cancel = () => {
      const from = route.query.from
      const target =
        typeof from === 'string' && /^\/chat(?:\/|\?|$)/.test(from)
          ? from
          : '/chat'
      void router.replace(target)
    }
    return {
      pageStyle: viewportPageStyle,
      initialMembers,
      invalidMembers,
      unavailableReason,
      cancel,
    }
  },
})
</script>

<style scoped>
.new-group-page {
  max-width: 100%;
  overflow-x: hidden;
  overflow-y: auto;
}
</style>
