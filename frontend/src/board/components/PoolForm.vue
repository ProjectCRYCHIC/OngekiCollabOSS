<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ submit: [value: string] }>();
const draft = ref(props.modelValue);

function onSubmit() {
  emit("submit", draft.value.trim());
}
</script>

<template>
  <form class="pool-form" autocomplete="off" @submit.prevent="onSubmit">
    <label for="pool-name">{{ $t('board.pool.label') }}</label>
    <input
      id="pool-name"
      v-model="draft"
      name="pool"
      type="text"
      class="text-input pool-input"
      :placeholder="$t('board.pool.placeholder')"
      maxlength="64"
      spellcheck="false"
    >
    <button class="button primary" type="submit">{{ $t('board.pool.view') }}</button>
  </form>
</template>
