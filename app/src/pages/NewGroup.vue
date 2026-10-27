<template>
  <div class="column full-height overflow-hidden">
    <q-header>
      <q-toolbar class="q-pl-sm">
        <!-- The form's own cancel when it is shown (it stops the member lookups first). -->
        <q-btn
          class="q-px-sm"
          flat
          dense
          icon="arrow_back"
          :aria-label="$t('a11y.backToChats')"
          data-test="new-group-back"
          @click="back"
        />
        <q-toolbar-title class="h6">{{
          $t('groupChat.createGroupTitle')
        }}</q-toolbar-title>
      </q-toolbar>
    </q-header>
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
          ref="form"
          :key="$route.fullPath"
          :initial-members="initialMembers"
          @cancel="cancel"
        />
      </q-page>
    </q-page-container>
  </div>
</template>

<script lang="ts">
import { computed, defineComponent, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import NewGroupForm from '../components/chat/NewGroupForm.vue'
import { isChainAddress, toChainDisplayAddress } from '../utils/chain-address'
import { activeChain } from '@frank/wallet/chain'
import { messagingState } from '../utils/messaging-state'
import { viewportPageStyle } from '../utils/layout'
import { returnTo } from '../utils/navigation'

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
      // Back to where the form was opened from; the form leaves no entry behind.
      returnTo(router, target)
    }
    const form = ref<{ cancel(): void } | null>(null)
    const back = () => (form.value ? form.value.cancel() : cancel())
    return {
      form,
      back,
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
