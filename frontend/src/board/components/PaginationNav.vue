<script setup lang="ts">
defineProps<{
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  label: string;
}>();
const emit = defineEmits<{ previous: []; next: [] }>();
</script>

<template>
  <nav class="pagination" :aria-label="label">
    <button v-if="page > 0 || hasNext" type="button" :disabled="page === 0" @click="emit('previous')">
      {{ $t('common.prevPage') }}
    </button>
    <span v-if="page > 0 || hasNext" class="page-label">{{ $t('common.pageInfo', { page: page + 1 }) }}</span>
    <button v-if="page > 0 || hasNext" type="button" :disabled="!hasNext" @click="emit('next')">
      {{ $t('common.nextPage') }}
    </button>
  </nav>
</template>
