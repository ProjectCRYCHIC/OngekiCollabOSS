<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { difficultyClass } from "../../shared/format";
import { difficultyLabel } from "../types";
import type { BoardPlayer } from "../types";
import { isHost, playerName } from "../view";

const props = withDefaults(defineProps<{ players: BoardPlayer[]; capacity?: number }>(), { capacity: 0 });
const { t } = useI18n();

// Fixed slot count keeps every chip the same width and height; unfilled seats
// render as dashed placeholders. Final scores live in the dialog table only.
const slots = computed(() => {
  const total = Math.min(Math.max(props.capacity, props.players.length), 4);
  return Array.from({ length: total }, (_, index) => props.players[index] ?? null);
});

function difficulty(player: BoardPlayer): string {
  return difficultyLabel(player?.selectedDifficulty, player?.level);
}
</script>

<template>
  <div class="player-list">
    <span
      v-for="(player, index) in slots"
      :key="index"
      class="player-chip"
      :class="{ empty: !player, host: player && isHost(player) }"
      :title="player && isHost(player) ? t('board.table.host') : undefined"
    >
      <template v-if="player">
        <span class="player-name">{{ playerName(player) }}</span>
        <span
          v-if="difficulty(player) !== '—'"
          class="player-difficulty"
          :class="difficultyClass(player.selectedDifficulty)"
        >{{ difficulty(player) }}</span>
      </template>
    </span>
  </div>
</template>
