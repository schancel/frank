<template>
  <p v-if="account.account" class="q-pa-sm" data-test="backup-reminder">
    {{
      $t(
        'accountRecovery.frank_account_backups_were_verified_before_activation',
      )
    }}
  </p>
</template>
<script setup lang="ts">
import { accountStatus as account } from '../../accounts/session'
</script>
