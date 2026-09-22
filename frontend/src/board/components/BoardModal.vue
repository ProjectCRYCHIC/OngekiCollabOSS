<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { difficultyClass, difficultyName, formatStamp, valueOrDash } from "../../shared/format";
import { closeRoomModal, roomModal } from "../modal";
import { SONG_SOURCE_LABEL, catalogState, songMeta } from "../songs";
import { difficultyLabel, relativeLevelLabel } from "../types";
import { hostFirst, isHost, playerName, playerStatusLabel, scoreValue } from "../view";

const { t, locale } = useI18n();

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && roomModal.open) closeRoomModal();
}

onMounted(() => window.addEventListener("keydown", onWindowKeydown));
onUnmounted(() => window.removeEventListener("keydown", onWindowKeydown));

// Recomputed once the async catalog becomes ready.
const meta = computed(() => {
  void catalogState.ready;
  return songMeta(roomModal.song ?? {});
});

const songTitle = computed(() => meta.value.entry?.t || roomModal.song?.title || t("board.song.unknown"));
const songId = computed(() => {
  const value = roomModal.song?.id;
  return value === undefined || value === null || value === "" ? "" : String(value);
});
const artist = computed(() => meta.value.entry?.a || roomModal.song?.artist || "");
const category = computed(() => meta.value.entry?.c || roomModal.song?.genre || "");
const version = computed(() => meta.value.entry?.v || roomModal.song?.version || "");
const bpm = computed(() => {
  const entryBpm = meta.value.entry?.b;
  return entryBpm ? String(entryBpm) : valueOrDash(roomModal.song?.bpm);
});
const release = computed(() => meta.value.entry?.d || "");
const levels = computed(() => meta.value.entry?.l ?? null);

const reason = computed(() => {
  const code = roomModal.record?.endReason;
  if (!code) return "";
  const label = t(`board.endReason.${code}`);
  return label === `board.endReason.${code}` ? valueOrDash(code) : label;
});

function onBackdrop(event: MouseEvent) {
  if (event.target === event.currentTarget) closeRoomModal();
}
</script>

<template>
  <Transition name="modal-fade">
    <div v-if="roomModal.open" id="room-modal" class="modal-backdrop" @click="onBackdrop">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="room-modal-title">
      <div class="modal-head">
        <div class="modal-heading">
          <h3 id="room-modal-title" class="modal-title">
            <span>{{ songTitle }}</span>
            <small v-if="songId" class="modal-song-id">#{{ songId }}</small>
          </h3>
          <p v-if="roomModal.mode === 'room' && roomModal.status" class="modal-sub modal-live-status" role="status" aria-live="polite">
            {{ roomModal.status }}
          </p>
          <!-- History stamp doubles as the dialog subtitle, like the original
               artist · difficulty line. -->
          <p v-else-if="roomModal.mode === 'history'" class="modal-sub history-status">
            <span>{{ formatStamp(locale, roomModal.record?.startedAt) }} - {{ formatStamp(locale, roomModal.record?.endedAt) }}</span>
            <span v-if="reason" class="end-reason">{{ reason }}</span>
          </p>
        </div>
        <button class="button quiet icon-button modal-close" type="button" :aria-label="$t('common.close')" :title="$t('common.close')" @click="closeRoomModal">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <div class="song-meta">
        <img
          v-if="meta.coverUrl"
          class="meta-cover"
          :src="meta.coverUrl"
          alt=""
          referrerpolicy="no-referrer"
          draggable="false"
        >
        <div class="meta-body">
          <p v-if="!meta.entry" class="meta-missing">{{ $t('board.meta.missing') }}</p>
          <dl class="meta-list">
            <div v-if="artist"><dt>{{ $t('board.meta.artist') }}</dt><dd>{{ artist }}</dd></div>
            <div v-if="category"><dt>{{ $t('board.meta.category') }}</dt><dd>{{ category }}</dd></div>
            <div v-if="version"><dt>{{ $t('board.meta.version') }}</dt><dd>{{ version }}</dd></div>
            <div v-if="bpm !== '—'"><dt>{{ $t('board.meta.bpm') }}</dt><dd>{{ bpm }}</dd></div>
            <div v-if="release"><dt>{{ $t('board.meta.release') }}</dt><dd>{{ release }}</dd></div>
          </dl>
          <div v-if="levels" class="meta-levels">
            <span
              v-for="(level, index) in levels"
              :key="index"
              class="level-chip"
              :class="[difficultyClass(index), { empty: !level }]"
            >
              <i>{{ difficultyName(index) }}</i><b>{{ relativeLevelLabel(level) }}</b>
            </span>
          </div>
        </div>
        <p class="meta-source">
          {{ $t('board.meta.source') }}
          <svg class="source-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path fill="currentColor" d="M4,6H2V20A2,2 0 0,0 4,22H18V20H4M18,7H15V12.5A2.5,2.5 0 0,1 12.5,15A2.5,2.5 0 0,1 10,12.5A2.5,2.5 0 0,1 12.5,10C13.07,10 13.58,10.19 14,10.5V5H18M20,2H8A2,2 0 0,0 6,4V16A2,2 0 0,0 8,18H20A2,2 0 0,0 22,16V4A2,2 0 0,0 20,2Z" />
          </svg>
          <a :href="meta.sourceUrl" target="_blank" rel="noopener noreferrer">{{ SONG_SOURCE_LABEL }}</a>
        </p>
      </div>

      <template v-if="roomModal.mode === 'room'">
        <table class="score-table">
          <thead>
            <tr>
              <th>{{ $t('board.table.player') }}</th>
              <th>{{ $t('board.table.difficulty') }}</th>
              <th>{{ $t('board.table.tech') }}</th>
              <th>{{ $t('board.table.battle') }}</th>
              <th>{{ $t('board.table.status') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(player, index) in hostFirst(roomModal.players)"
              :key="index"
              :class="{ 'host-row': isHost(player) }"
            >
              <td class="player-name-cell">
                <span class="player-name">{{ playerName(player) }}</span>
              </td>
              <td :class="difficultyClass(player?.selectedDifficulty)">{{ difficultyLabel(player?.selectedDifficulty, player?.level) }}</td>
              <td>{{ scoreValue(player?.techScore ?? 0, locale) }}</td>
              <td>{{ scoreValue(player?.battleScore ?? 0, locale) }}</td>
              <td>{{ playerStatusLabel((key: string) => t(key), player) }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <template v-else>
        <table v-if="roomModal.players.length" class="score-table">
          <thead>
            <tr>
              <th>{{ $t('board.table.player') }}</th>
              <th>{{ $t('board.table.difficulty') }}</th>
              <th>{{ $t('board.table.tech') }}</th>
              <th>{{ $t('board.table.battle') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(player, index) in hostFirst(roomModal.players)"
              :key="index"
              :class="{ 'host-row': isHost(player) }"
            >
              <td class="player-name-cell">
                <span class="player-name">{{ playerName(player) }}</span>
              </td>
              <td :class="difficultyClass(player?.selectedDifficulty)">{{ difficultyLabel(player?.selectedDifficulty, player?.level) }}</td>
              <td>{{ scoreValue(player?.techScore ?? 0, locale) }}</td>
              <td>{{ scoreValue(player?.battleScore ?? 0, locale) }}</td>
            </tr>
          </tbody>
        </table>
      </template>
      </div>
    </div>
  </Transition>
</template>
