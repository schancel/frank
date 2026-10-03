<template>
  <q-page-container>
    <q-page class="q-pa-md">
      <h1 class="text-h6">{{ $t('profileDialog.profile') }}</h1>
      <p role="status" data-test="profile-unavailable">
        {{ $t('accountRecovery.profile_unavailable') }}
      </p>
      <q-btn
        :label="$t('profileDialog.cancel')"
        @click="$router.push('/settings')"
      />
    </q-page>
  </q-page-container>
</template>
