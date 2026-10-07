<template>
  <q-dialog
    :model-value="modelValue"
    data-test="avu-explainer-dialog"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <q-card
      style="max-width: 540px; width: 100%"
      data-test="avu-explainer-card"
    >
      <q-card-section class="row items-center q-pb-none">
        <q-avatar
          icon="bolt"
          color="primary"
          text-color="white"
          size="36px"
          class="q-mr-sm"
        />
        <div>
          <div class="text-h6 text-weight-bold">
            {{ $t('walletPanel.avuDialogTitle') }}
          </div>
          <div class="text-caption text-grey-7">
            {{ $t('walletPanel.avuDialogSubtitle') }}
          </div>
        </div>
        <q-space />
        <q-btn
          icon="close"
          flat
          round
          dense
          @click="$emit('update:modelValue', false)"
        />
      </q-card-section>

      <q-card-section class="q-pt-md">
        <p class="text-body2 text-grey-9 q-mb-md">
          {{ $t('walletPanel.avuDialogDesc') }}
        </p>

        <div class="q-mb-md">
          <div
            class="text-subtitle2 text-weight-bold text-primary flex items-center q-gutter-xs"
          >
            <q-icon name="psychology" size="18px" />
            <span>{{ $t('walletPanel.avuMemeHeading') }}</span>
          </div>
          <p class="text-body2 text-grey-8 q-mt-xs q-mb-none">
            {{ $t('walletPanel.avuMemeDesc') }}
          </p>
        </div>

        <div class="q-mb-md">
          <div
            class="text-subtitle2 text-weight-bold text-primary flex items-center q-gutter-xs"
          >
            <q-icon name="precision_manufacturing" size="18px" />
            <span>{{ $t('walletPanel.avuSupplyChainHeading') }}</span>
          </div>
          <p class="text-body2 text-grey-8 q-mt-xs q-mb-none">
            {{ $t('walletPanel.avuSupplyChainDesc') }}
          </p>
        </div>

        <div class="q-mb-md">
          <div
            class="text-subtitle2 text-weight-bold text-primary flex items-center q-gutter-xs"
          >
            <q-icon name="trending_down" size="18px" />
            <span>{{ $t('walletPanel.avuCpiHeading') }}</span>
          </div>
          <p class="text-body2 text-grey-8 q-mt-xs q-mb-none">
            {{ $t('walletPanel.avuCpiDesc') }}
          </p>
        </div>

        <div>
          <div
            class="text-subtitle2 text-weight-bold text-primary flex items-center q-gutter-xs"
          >
            <q-icon name="verified" size="18px" />
            <span>{{ $t('walletPanel.avuOracleLessHeading') }}</span>
          </div>
          <p class="text-body2 text-grey-8 q-mt-xs q-mb-none">
            {{ $t('walletPanel.avuOracleLessDesc') }}
          </p>
        </div>
      </q-card-section>

      <q-card-actions align="right" class="q-pa-md q-pt-none">
        <q-btn
          flat
          no-caps
          color="primary"
          :label="$t('walletPanel.avuDialogClose')"
          data-test="avu-dialog-close-btn"
          @click="$emit('update:modelValue', false)"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
defineProps<{
  modelValue: boolean
}>()

defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()
</script>
