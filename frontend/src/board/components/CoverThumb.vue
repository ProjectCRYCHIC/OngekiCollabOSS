<script setup lang="ts">
import { computed, ref } from "vue";
import { catalogState, songMeta } from "../songs";
import type { BoardSong } from "../types";

const props = defineProps<{ song: BoardSong; size?: "sm" | "md" }>();

const failed = ref(false);
// Read the reactive catalog flag so covers appear once the catalog lands.
const coverUrl = computed(() => {
  void catalogState.ready;
  return failed.value ? null : songMeta(props.song).coverUrl;
});
</script>

<template>
  <img
    v-if="coverUrl"
    class="cover"
    :class="size"
    :src="coverUrl"
    alt=""
    loading="lazy"
    referrerpolicy="no-referrer"
    draggable="false"
    @error="failed = true"
  >
  <span v-else class="cover cover-fallback" :class="size" aria-hidden="true">♪</span>
</template>
