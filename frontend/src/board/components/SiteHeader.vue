<script setup lang="ts">
import LocaleSelect from "../../shared/components/LocaleSelect.vue";
import ThemeToggle from "../../shared/components/ThemeToggle.vue";

const emit = defineEmits<{ refresh: [] }>();
</script>

<template>
  <header class="site-header">
    <a class="brand" href="/">Ongeki<span>Collab</span></a>
    <div class="header-actions">
      <LocaleSelect />
      <ThemeToggle />
      <button class="button icon-button" type="button" :aria-label="$t('common.refresh')" :title="$t('common.refresh')" @click="emit('refresh')">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M20 12a8 8 0 1 1-2.9-6.16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          <path d="M20 3.8v4.4h-4.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </header>
</template>
