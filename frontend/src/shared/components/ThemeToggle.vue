<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useTheme } from "../theme";

const { t } = useI18n();
const { theme, toggle } = useTheme();
const dark = computed(() => theme.value === "dark");
</script>

<template>
  <button
    class="button icon-button theme-toggle"
    type="button"
    :aria-label="dark ? $t('common.themeToLight') : $t('common.themeToDark')"
    :title="dark ? $t('common.themeToLight') : $t('common.themeToDark')"
    @click="toggle"
  >
    <svg v-if="dark" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" fill="currentColor" />
      <g stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.2 5.2l1.7 1.7M17.1 17.1l1.7 1.7M18.8 5.2l-1.7 1.7M6.9 17.1l-1.7 1.7" />
      </g>
    </svg>
    <svg v-else viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M20.4 14.2A8.6 8.6 0 0 1 9.8 3.6a8.6 8.6 0 1 0 10.6 10.6Z" fill="currentColor" />
    </svg>
  </button>
</template>
