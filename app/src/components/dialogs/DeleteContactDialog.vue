<template>
  <q-card
    @keydown.stop
    data-test="delete-contact-dialog"
    style="max-width: 480px"
  >
    <q-card-section>
      <div class="text-h6">
        {{ $t('chatRightDrawer.deleteContactAndConversations') }}
      </div>
      <p class="q-mt-sm q-mb-none">
        {{ $t('deleteContactDialog.message', { name: capturedName }) }}
      </p>
      <div
        v-if="failed"
        role="alert"
        class="text-negative q-mt-sm"
        data-test="delete-contact-error"
      >
        {{ $t('deleteContactDialog.failed') }}
      </div>
    </q-card-section>
    <q-card-actions align="right">
      <q-btn
        flat
        :label="$t('deleteContactDialog.cancel')"
        :disable="deleting"
        data-test="delete-contact-cancel"
        @click="$emit('cancel')"
      />
      <q-btn
        flat
        color="negative"
        :label="$t('deleteContactDialog.delete')"
        :loading="deleting"
        :disable="deleting"
        data-test="delete-contact-confirm"
        @click="confirm"
      />
    </q-card-actions>
  </q-card>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { useContactStore } from 'src/stores/contacts'
import { accountSession } from 'src/accounts/session'
const props = defineProps<{ address: string; name: string }>()
const emit = defineEmits<{
  (event: 'cancel'): void
  (event: 'deleted'): void
}>()
// Each opening mounts one confirmation: later selection changes never redirect its authority.
const revision = accountSession.state.revision
const account = accountSession.state.account
// eslint-disable-next-line vue/no-setup-props-destructure -- confirmation authority is captured once, never redirected by selection changes
const capturedAddress = props.address
const capturedName = props.name || props.address
const contacts = useContactStore()
const deleting = ref(false)
const failed = ref(false)
async function confirm() {
  if (deleting.value) return
  deleting.value = true
  failed.value = false
  try {
    if (
      accountSession.state.revision !== revision ||
      accountSession.state.account !== account
    )
      throw new Error('Account changed before contact deletion')
    await contacts.deleteContact(capturedAddress)
    emit('deleted')
  } catch {
    failed.value = true
  } finally {
    deleting.value = false
  }
}
</script>
