<template>
  <section data-test="directory-provisioning" class="q-gutter-y-sm" aria-labelledby="directory-provisioning-title">
    <h2 id="directory-provisioning-title" class="text-subtitle1">{{ $t('directoryProvisioning.title') }}</h2>
    <p role="status" aria-live="polite" data-test="directory-provisioning-status">{{ $t('directoryProvisioning.pending') }}</p>
    <p>{{ $t('directoryProvisioning.explanation') }}</p>
    <p id="directory-provisioning-policy">{{ $t('directoryProvisioning.policyUnavailable') }}</p>
    <q-btn disable :label="$t('directoryProvisioning.exportPublic')" aria-describedby="directory-provisioning-policy" data-test="directory-export" />
    <p>{{ $t('directoryProvisioning.publicOnly') }}</p>
  </section>
</template>
<script setup lang="ts">
// The authenticated operator policy and real installation/admission adapters are
// separately owned. Mounting Settings cannot discover trust, sign or enroll.
// No success fixture or caller-supplied Current is installed in this component.
</script>
