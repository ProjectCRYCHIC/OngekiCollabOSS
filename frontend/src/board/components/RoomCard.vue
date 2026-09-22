<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { formatStamp } from "../../shared/format";
import type { RoomItem } from "../board";
import { catalogState, songMeta } from "../songs";
import CoverThumb from "./CoverThumb.vue";
import PlayerChips from "./PlayerChips.vue";
const props = defineProps<{ room: RoomItem }>();
const { t, locale } = useI18n();

const playing = computed(() => props.room.status === "playing");
const song = computed(() => {
  const source = props.room.song ?? {};
  return {
    ...source,
    title: source.title || t("board.song.unknown"),
  };
});
const artist = computed(() => {
  void catalogState.ready;
  return songMeta(song.value).entry?.a || song.value.artist || "";
});

</script>

<template>
  <article
    class="room-card"
    :class="{ 'is-playing': playing }"
    role="button"
    tabindex="0"
    :aria-label="$t('board.rooms.openAria', { title: song.title })"
    @click="$emit('open')"
    @keydown.enter.prevent="$emit('open')"
    @keydown.space.prevent="$emit('open')"
  >
    <div class="card-lead">
      <CoverThumb :song="song" size="md" />
      <div class="card-main">
        <div class="room-top">
          <span class="status-tag" :class="{ playing }">{{ playing ? $t('board.status.playing') : $t('board.status.recruiting') }}</span>
          <span v-if="playing" class="start-at">
            <span class="caption">{{ $t('board.song.start') }}</span>
            <strong>{{ formatStamp(locale, room.startedAt) }}</strong>
          </span>
        </div>
        <h3 class="song-title">{{ song.title }}</h3>
        <p v-if="artist" class="song-artist">{{ artist }}</p>
      </div>
    </div>
    <PlayerChips :players="room.players ?? []" :capacity="Number(room.maxPlayers) || 4" />
  </article>
</template>
