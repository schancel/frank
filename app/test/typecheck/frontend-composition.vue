<template>
  <q-btn
    v-if="$status.loaded"
    :label="$t('app.title')"
    @click="$router.push({ path: '/' })"
  />
</template>
