<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { formatStamp, valueOrDash } from "../../shared/format";
import type { HistoryItem } from "../board";
import { catalogState, songMeta } from "../songs";
import CoverThumb from "./CoverThumb.vue";
import PlayerChips from "./PlayerChips.vue";

const props = defineProps<{ record: HistoryItem }>();
const { t, locale } = useI18n();

const song = computed(() => {
  const source = props.record.song ?? {};
  return { ...source, title: source.title || t("board.song.unknown") };
});
const artist = computed(() => {
  void catalogState.ready;
  return songMeta(song.value).entry?.a || song.value.artist || "";
});

const reason = computed(() => {
  const key = `board.endReason.${props.record.endReason}`;
  const label = t(key);
  return label === key ? valueOrDash(props.record.endReason) : label;
});
</script>

<template>
  <article
    class="history-card"
    role="button"
    tabindex="0"
    :aria-label="$t('board.history.openAria', { title: song.title })"
    @click="$emit('open')"
    @keydown.enter.prevent="$emit('open')"
    @keydown.space.prevent="$emit('open')"
  >
    <div class="history-song">
      <CoverThumb :song="song" size="sm" />
      <div class="history-song-text">
        <h3 class="song-title">{{ song.title }}</h3>
        <p v-if="artist" class="song-artist">{{ artist }}</p>
        <div class="history-stamp">
          <span>{{ formatStamp(locale, record.startedAt) }} - {{ formatStamp(locale, record.endedAt) }}</span>
          <span v-if="reason" class="end-reason">{{ reason }}</span>
        </div>
      </div>
    </div>
    <PlayerChips class="history-players" :players="record.players ?? []" :capacity="Number(record.maxPlayers) || 4" />
  </article>
</template>
