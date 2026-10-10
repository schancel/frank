<template>
  <q-page-container>
    <q-page class="q-ma-none q-pa-sm">
      <!-- Edit / Selection State -->
      <q-card v-if="!isReviewing" data-test="send-contact-edit-card">
        <q-card-section>
          <div class="text-h6" data-test="send-contact-title">
            {{ $t('sendContactDialog.title') }}
          </div>
        </q-card-section>

        <!-- If no contact selected yet: Contact Picker -->
        <q-card-section v-if="!selectedContactAddress" class="q-pt-none">
          <q-input
            v-model="search"
            filled
            dense
            :placeholder="$t('sendContactDialog.searchContacts')"
            data-test="contact-search-input"
            class="q-mb-md"
          >
            <template #prepend>
              <q-icon name="search" />
            </template>
          </q-input>

          <q-list
            separator
            bordered
            class="rounded-borders"
            style="max-height: 250px; overflow-y: auto"
          >
            <q-item
              v-for="(contact, addr) in filteredContacts"
              :key="addr"
              clickable
              data-test="contact-item"
              @click="selectContact(String(addr))"
            >
              <q-item-section avatar>
                <q-avatar color="primary" text-color="white" size="36px">
                  {{
                    contact?.profile?.name
                      ? contact.profile.name.charAt(0).toUpperCase()
                      : '?'
                  }}
                </q-avatar>
              </q-item-section>
              <q-item-section>
                <q-item-label class="text-weight-bold" data-test="contact-name">
                  {{ contact?.profile?.name || shortAddress(String(addr)) }}
                </q-item-label>
                <q-item-label caption class="ellipsis" style="max-width: 250px">
                  {{ addr }}
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                <q-icon name="chevron_right" />
              </q-item-section>
            </q-item>
            <q-item v-if="Object.keys(filteredContacts).length === 0">
              <q-item-section class="text-center text-grey-7 q-py-md">
                {{ $t('sendContactDialog.noContactsFound') }}
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>

        <!-- Selected Contact Card -->
        <q-card-section v-else class="q-pt-none">
          <div class="text-caption text-grey-7 q-mb-xs">
            {{ $t('sendContactDialog.selectedContact') }}
          </div>
          <q-item
            class="bg-grey-2 rounded-borders items-center q-pa-sm"
            data-test="selected-contact-card"
          >
            <q-item-section avatar>
              <q-avatar color="primary" text-color="white" size="36px">
                {{
                  selectedContactName
                    ? selectedContactName.charAt(0).toUpperCase()
                    : '?'
                }}
              </q-avatar>
            </q-item-section>
            <q-item-section>
              <q-item-label
                class="text-weight-bold"
                data-test="selected-contact-name"
              >
                {{ selectedContactName }}
              </q-item-label>
              <q-item-label caption class="ellipsis" style="max-width: 220px">
                {{ selectedContactAddress }}
              </q-item-label>
            </q-item-section>
            <q-item-section side>
              <q-btn
                flat
                dense
                no-caps
                color="primary"
                :label="$t('sendContactDialog.changeContact')"
                data-test="change-contact-button"
                @click="clearSelectedContact"
              />
            </q-item-section>
          </q-item>
        </q-card-section>

        <!-- Amount & Memo Inputs -->
        <q-card-section class="q-pt-none">
          <div class="row justify-between items-center q-mb-xs">
            <span class="text-caption text-grey-7">{{
              $t('sendContactDialog.amount')
            }}</span>
            <span
              class="text-caption text-grey-7"
              :title="balanceText ? exactBalance : undefined"
              >{{ balanceText }}</span
            >
          </div>
          <q-input
            v-model="amount"
            class="text-bold text-h6"
            inputmode="decimal"
            filled
            dense
            data-test="send-contact-amount-input"
            :placeholder="$t('sendContactDialog.enterAmount', { unit })"
          />
          <div
            v-if="tooLarge"
            class="text-negative text-caption q-mt-xs"
            role="alert"
            data-test="send-contact-too-large"
          >
            {{ tooLargeText }}
          </div>
        </q-card-section>

        <q-card-section class="q-pt-none">
          <q-input
            v-model="memo"
            filled
            dense
            data-test="send-contact-memo-input"
            :placeholder="$t('sendContactDialog.memo')"
          />
        </q-card-section>

        <q-card-actions align="right" class="wrap">
          <q-btn
            :label="$t('sendContactDialog.cancel')"
            color="negative"
            flat
            data-test="send-contact-cancel-button"
            @click="cancelEdit"
          />
          <q-btn
            :disable="!isValid || sending"
            :loading="sending"
            :label="$t('sendContactDialog.reviewTransfer')"
            color="primary"
            data-test="send-contact-review-button"
            @click="reviewTransfer"
          />
        </q-card-actions>
      </q-card>

      <!-- Review State -->
      <q-card v-else data-test="send-contact-review-card">
        <q-card-section>
          <div class="text-h6" data-test="review-title">
            {{ $t('sendContactDialog.reviewTransfer') }}
          </div>
        </q-card-section>

        <q-card-section class="q-pt-none">
          <div class="q-gutter-y-sm">
            <div class="row justify-between items-center q-py-xs">
              <span class="text-caption text-grey-7">{{
                $t('sendContactDialog.recipient')
              }}</span>
              <span
                class="text-weight-bold text-body2"
                data-test="review-recipient"
              >
                {{ selectedContactName }} ({{
                  shortAddress(selectedContactAddress)
                }})
              </span>
            </div>

            <div class="row justify-between items-center q-py-xs">
              <span class="text-caption text-grey-7">{{
                $t('sendContactDialog.amount')
              }}</span>
              <span
                class="text-weight-bold text-primary"
                data-test="review-amount"
              >
                {{ amount }} {{ unit }}
              </span>
            </div>

            <div v-if="memo" class="row justify-between items-center q-py-xs">
              <span class="text-caption text-grey-7">{{
                $t('sendContactDialog.memo')
              }}</span>
              <span class="text-body2" data-test="review-memo">{{ memo }}</span>
            </div>
          </div>
        </q-card-section>

        <q-card-section class="q-pt-none">
          <q-banner
            class="bg-blue-1 text-primary q-pa-sm"
            rounded
            data-test="review-stealth-notice"
          >
            <template #avatar>
              <q-icon name="lock" color="primary" />
            </template>
            {{ $t('sendContactDialog.stealthNotice') }}
          </q-banner>
        </q-card-section>

        <q-card-actions align="right" class="wrap">
          <q-btn
            :disable="sending"
            :label="$t('sendContactDialog.edit')"
            flat
            color="primary"
            data-test="review-cancel-button"
            @click="cancelReview"
          />
          <q-btn
            :disable="sending"
            :loading="sending"
            :label="$t('sendContactDialog.confirmAndSend')"
            color="primary"
            data-test="review-confirm-button"
            @click="confirmSend"
          />
        </q-card-actions>
      </q-card>
    </q-page>
  </q-page-container>
</template>

<script lang="ts">
import { computed, defineComponent, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { activeChain, MAX_STEALTH_ITEM_AMOUNT } from '@frank/wallet/chain'
import { useChatStore } from 'src/stores/chats'
import { useMonadWallet } from 'src/utils/clients'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { useBalance } from 'src/composables/useBalance'
import { useContactStore } from 'src/stores/contacts'
import { useTranslate } from 'src/composables/useTranslate'
import { navigateBack } from 'src/utils/navigate-back'
import {
  sentTransactionNotify,
  errorNotify,
  infoNotify,
} from 'src/utils/notifications'

export default defineComponent({
  setup() {
    const $t = useTranslate()
    const route = useRoute()
    const router = useRouter()
    const contactStore = useContactStore()
    const chatStore = useChatStore()
    const { formattedBalance, exactBalance, loaded } = useBalance()

    const search = ref('')
    const selectedContactAddress = ref<string>(
      (route.query?.to as string) || '',
    )
    const amount = ref('')
    const memo = ref('')
    const isReviewing = ref(false)
    const sending = ref(false)

    const balanceText = computed(() =>
      loaded.value ? formattedBalance.value : '',
    )
    const unit = computed(() => activeChain.unit)

    const allContacts = computed(() => contactStore.getContacts ?? {})

    const filteredContacts = computed(() => {
      const q = search.value.trim().toLowerCase()
      const entries = Object.entries(allContacts.value)
      if (!q) {
        return Object.fromEntries(entries)
      }
      return Object.fromEntries(
        entries.filter(([addr, c]) => {
          if (!c) return false
          const nameMatch = c.profile?.name?.toLowerCase().includes(q)
          const addrMatch = addr.toLowerCase().includes(q)
          return nameMatch || addrMatch
        }),
      )
    })

    const selectedContactName = computed(() => {
      if (!selectedContactAddress.value) return ''
      const profile = contactStore.getContactProfile(
        selectedContactAddress.value,
      )
      return profile?.name || shortAddress(selectedContactAddress.value)
    })

    function shortAddress(addr: string): string {
      if (!addr) return ''
      return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
    }

    const parsedValue = computed(() => {
      const trimmed = amount.value.trim()
      if (!trimmed || isNaN(Number(trimmed)) || Number(trimmed) <= 0) {
        return undefined
      }
      try {
        return activeChain.fromDisplayAmount(trimmed)
      } catch {
        return undefined
      }
    })

    /** More than one contact payment can carry: said before review. */
    const tooLarge = computed(
      () =>
        parsedValue.value !== undefined &&
        parsedValue.value > MAX_STEALTH_ITEM_AMOUNT,
    )
    const tooLargeText = computed(() =>
      $t('sendContactDialog.tooLarge', {
        max: activeChain.toDisplayAmount(MAX_STEALTH_ITEM_AMOUNT).slice(0, 4),
        unit: activeChain.unit,
      }),
    )
    const isValid = computed(() => {
      return (
        Boolean(selectedContactAddress.value) &&
        parsedValue.value !== undefined &&
        parsedValue.value > 0n &&
        !tooLarge.value
      )
    })

    return {
      search,
      selectedContactAddress,
      selectedContactName,
      amount,
      memo,
      isReviewing,
      sending,
      balanceText,
      exactBalance,
      unit,
      filteredContacts,
      isValid,
      tooLarge,
      tooLargeText,
      shortAddress,
      selectContact(addr: string) {
        selectedContactAddress.value = addr
      },
      clearSelectedContact() {
        selectedContactAddress.value = ''
      },
      cancelEdit() {
        navigateBack(router)
      },
      reviewTransfer() {
        if (tooLarge.value) {
          errorNotify(new Error(tooLargeText.value), {
            safeMessage: tooLargeText.value,
          })
          return
        }
        if (!isValid.value) {
          errorNotify(new Error('Invalid transfer details'), {
            fallbackKey: 'sendContactDialog.invalidAmount',
          })
          return
        }
        isReviewing.value = true
      },
      cancelReview() {
        isReviewing.value = false
      },
      async confirmSend() {
        if (sending.value) return
        if (!isValid.value) {
          // The details stopped being a payment that can be sent (the contact or the amount
          // is gone): said, and back to the form, never a button that does nothing.
          isReviewing.value = false
          errorNotify(new Error('Invalid transfer details'), {
            fallbackKey: 'sendContactDialog.invalidAmount',
          })
          return
        }
        sending.value = true

        try {
          const wallet = await useActiveWallet()

          if (!wallet.prepareContactPayment) {
            throw new Error('sendToContact is not supported on this chain')
          }
          // Asked for first: with no messaging wallet nothing is signed.
          const messaging = useMonadWallet()

          // The wallet signs and saves the transfer from its spendable funds (nothing is
          // broadcast) and returns the item. The message carrying it goes through the
          // conversation's ordinary send, so it shows in the chat with the contact, with its
          // pending state and Retry; the wallet broadcasts the transfer once the relay has
          // stored that message.
          // The message carries the stamp chosen for the conversation with this contact, as
          // a payment sent from the chat itself does; the amount is the payment's own.
          const stampValue = chatStore.getStampWei(selectedContactAddress.value)
          const prepared = await wallet.prepareContactPayment({
            recipient: { raw: selectedContactAddress.value },
            value: parsedValue.value!,
            memo: memo.value.trim() || undefined,
            stampValue,
          })
          const outcome = await chatStore.sendMessage({
            wallet: messaging,
            address: selectedContactAddress.value,
            items: [prepared.item],
            stampValue,
          })

          if (outcome.state === 'sent') {
            sentTransactionNotify(prepared.txHash, $t('sendContactDialog.sent'))
          } else if (outcome.state === 'failed') {
            // Saved in the conversation with its Retry: the same payment, never a second one.
            errorNotify(new Error(outcome.reason), {
              fallbackKey: 'sendContactDialog.messageEnded',
            })
          } else {
            infoNotify($t('sendContactDialog.pending'))
          }
          navigateBack(router)
        } catch (err) {
          // Refused before anything was signed: nothing was sent.
          errorNotify(err, { fallbackKey: 'sendContactDialog.notSent' })
        } finally {
          sending.value = false
        }
      },
    }
  },
})
</script>
