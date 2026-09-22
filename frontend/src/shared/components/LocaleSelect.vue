<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { LOCALES, LOCALE_LABELS, persistLocale, type Locale } from "../i18n";

const { locale, t } = useI18n();
const open = ref(false);
const root = ref<HTMLElement | null>(null);

const currentLabel = computed(() => LOCALE_LABELS[locale.value as Locale] ?? locale.value);

function choose(next: Locale) {
  locale.value = next;
  persistLocale(next);
  open.value = false;
}

function onDocumentClick(event: MouseEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false;
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && open.value) open.value = false;
}

onMounted(() => {
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeydown);
});
onUnmounted(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onDocumentKeydown);
});
</script>

<template>
  <div ref="root" class="locale-select">
    <button
      class="locale-trigger"
      type="button"
      :aria-label="t('common.language')"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="open = !open"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <g fill="none" stroke="currentColor" stroke-width="1.7">
          <circle cx="12" cy="12" r="8.6" />
          <path d="M3.4 12h17.2M12 3.4c2.5 2.3 3.9 5.3 3.9 8.6s-1.4 6.3-3.9 8.6c-2.5-2.3-3.9-5.3-3.9-8.6s1.4-6.3 3.9-8.6Z" />
        </g>
      </svg>
      <span class="locale-current">{{ currentLabel }}</span>
      <svg class="chev" :class="{ open }" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
        <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <Transition name="pop">
      <ul v-if="open" class="locale-menu" role="listbox" :aria-label="t('common.language')">
        <li v-for="item in LOCALES" :key="item">
          <button
            class="locale-option"
            :class="{ active: item === locale }"
            type="button"
            role="option"
            :aria-selected="item === locale"
            @click="choose(item)"
          >
            <span>{{ LOCALE_LABELS[item] }}</span>
            <svg v-if="item === locale" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
              <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </li>
      </ul>
    </Transition>
  </div>
</template>
