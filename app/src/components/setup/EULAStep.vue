<template>
  <div class="col q-gutter-y-md" data-test="eula-step">
    <div class="row p-mx-sm text-h6">
      <q-space />
      {{ $t('setup.welcomeToStampChat') }}
      <q-space />
    </div>

    <q-banner
      rounded
      class="bg-primary text-white"
      data-test="eula-testnet-banner"
    >
      <template #avatar>
        <q-icon name="info" color="white" />
      </template>
      <div class="text-subtitle2 text-weight-bold">
        {{ $t('setup.networkTitle') }}
      </div>
      <div>
        {{ $t('setup.testnetDisclaimer') }}
      </div>
    </q-banner>

    <q-card flat bordered class="q-pa-sm" data-test="eula-economic-disclosure">
      <q-card-section class="q-pb-xs">
        <div class="text-subtitle1 text-weight-bold">
          {{ $t('setup.economicModelTitle') }}
        </div>
        <div class="text-body2 q-mt-xs" data-test="eula-costs-explanation">
          {{ $t('setup.costsDisclaimer') }}
        </div>
      </q-card-section>

      <q-card-section class="q-pt-xs">
        <q-list dense>
          <q-item data-test="eula-dm-payment">
            <q-item-section avatar top>
              <q-icon name="send" color="primary" />
            </q-item-section>
            <q-item-section>
              <q-item-label class="text-weight-medium">
                {{ $t('setup.directMessagesTitle') }}
              </q-item-label>
              <q-item-label caption>
                {{ $t('setup.directMessagesDesc') }}
              </q-item-label>
            </q-item-section>
          </q-item>

          <q-item data-test="eula-topic-burn">
            <q-item-section avatar top>
              <q-icon name="local_fire_department" color="negative" />
            </q-item-section>
            <q-item-section>
              <q-item-label class="text-weight-medium">
                {{ $t('setup.topicActionsTitle') }}
              </q-item-label>
              <q-item-label caption>
                {{ $t('setup.topicActionsDesc') }}
              </q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
      </q-card-section>

      <q-separator />

      <q-card-section data-test="eula-funding-info">
        <div class="text-subtitle2 text-weight-medium">
          {{ $t('setup.fundingTitle') }}
        </div>
        <div class="text-caption">
          {{ $t('setup.fundingDesc') }}
        </div>
      </q-card-section>
    </q-card>

    <div class="row q-gutter-y-md text-body2" data-test="eula-disclaimer">
      {{ $t('setup.eulaDisclaimer') }}
    </div>

    <div class="row q-gutter-y-md text-body2" data-test="eula-understand">
      {{ $t('setup.eulaYouUnderstand') }}
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({})
</script>
