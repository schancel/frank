<template>
  <q-page-container class="col full-height overflow-hidden">
    <q-page
      class="account-sync-page q-pa-md"
      :style-fn="viewportPageStyle"
      data-test="account-sync-send"
    >
      <main class="account-sync-content">
        <template v-if="complete">
          <q-icon name="check_circle" color="positive" size="48px" />
          <h1 class="text-h5">{{ $t('accountSync.sent') }}</h1>
          <q-btn
            unelevated
            no-caps
            color="primary"
            :label="$t('accountSync.done')"
            to="/profile"
            replace
            data-test="sync-done"
          />
        </template>
        <template v-else>
          <q-btn
            flat
            no-caps
            icon="arrow_back"
            :label="$t('accountSync.back')"
            to="/profile"
            replace
            data-test="sync-back"
          />
          <h1 class="text-h5">{{ $t('accountSync.send') }}</h1>
          <template v-if="needsPersistentView">
            <p role="status" data-test="sync-promotion-status">
              {{
                $t(
                  promoted
                    ? 'accountSync.continueInTab'
                    : 'accountSync.openingPersistentView',
                )
              }}
            </p>
            <p v-if="promotionError" role="alert" class="text-negative">
              {{ promotionError }}
            </p>
            <q-btn
              v-if="!promoted"
              unelevated
              no-caps
              color="primary"
              :label="$t('accountSync.openPersistentView')"
              :loading="promoting"
              :disable="promoting"
              data-test="sync-promotion-retry"
              @click="promoteToPersistentView"
            />
          </template>
          <template v-else>
            <p>{{ $t('accountSync.senderIntro') }}</p>
            <div v-if="view?.pin" class="q-my-lg" data-test="sync-pin-block">
              <p>
                {{
                  $t(
                    view.status === 'new-pin'
                      ? 'accountSync.newPinAfterMismatch'
                      : 'accountSync.showPin',
                  )
                }}
              </p>
              <output
                class="account-sync-pin text-h3 text-weight-bold"
                data-test="sync-sender-pin"
                >{{ view.pin }}</output
              >
              <p class="text-caption q-mt-md">
                {{ $t('accountSync.pinPrivate') }}
              </p>
            </div>
            <p
              v-if="view?.status === 'expired' || view?.status === 'ended'"
              role="status"
            >
              {{ $t(`accountSync.${view.status}`) }}
            </p>
            <p
              v-if="error"
              role="alert"
              class="text-negative"
              data-test="sync-sender-error"
            >
              {{ error }}
            </p>
            <q-btn
              v-if="!view?.pin"
              unelevated
              no-caps
              color="primary"
              :label="$t('accountSync.showPinAction')"
              :loading="busy"
              :disable="busy"
              data-test="sync-show-pin"
              @click="showPin"
            />
          </template>
          <q-btn
            flat
            no-caps
            :label="$t('accountSync.cancel')"
            to="/profile"
            replace
            data-test="sync-cancel"
          />
        </template>
      </main>
    </q-page>
  </q-page-container>
</template>

<script setup lang="ts">
import { onBeforeRouteLeave } from 'vue-router'
import { useAccountSyncSender } from '../composables/useAccountSyncSender'
import { viewportPageStyle } from '../utils/layout'
const {
  view,
  busy,
  error,
  complete,
  showPin,
  cancel,
  needsPersistentView,
  promoting,
  promoted,
  promotionError,
  promoteToPersistentView,
} = useAccountSyncSender()
onBeforeRouteLeave(() => cancel())
</script>

<style scoped>
.account-sync-page {
  overflow-y: auto;
  overflow-x: hidden;
}
.account-sync-content {
  width: 100%;
  max-width: 32rem;
  margin: 0 auto;
  padding-bottom: calc(5rem + env(safe-area-inset-bottom, 0px));
}
.account-sync-pin {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.16em;
  overflow-wrap: anywhere;
}
</style>
