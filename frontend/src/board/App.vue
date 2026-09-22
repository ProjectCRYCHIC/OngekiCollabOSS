<script setup lang="ts">
import { watch } from "vue";
import { useI18n } from "vue-i18n";
import { persistLocale } from "../shared/i18n";
import { useBoard } from "./board";
import BoardModal from "./components/BoardModal.vue";
import HistoryCard from "./components/HistoryCard.vue";
import PaginationNav from "./components/PaginationNav.vue";
import PoolForm from "./components/PoolForm.vue";
import RoomCard from "./components/RoomCard.vue";
import SiteHeader from "./components/SiteHeader.vue";
import { openHistory, openRoom } from "./modal";

const { t, locale } = useI18n();
const {
  pool, rooms, history, roomList, historyList, connecting,
  recruitingCount, playingCount, srStatus,
  refresh, switchPool, previousPage, nextPage,
} = useBoard();

watch(locale, (next) => persistLocale(next));
watch(locale, () => { document.title = t("board.title"); }, { immediate: true });

function stagger(index: number) {
  return { "--card-i": index > 8 ? 8 : index };
}
</script>

<template>
  <div class="site-shell">
    <SiteHeader @refresh="refresh" />

    <main>
      <PoolForm :model-value="pool" @submit="switchPool" />

      <section class="directory-section" aria-labelledby="rooms-title">
        <div class="section-heading">
          <h1 id="rooms-title">{{ $t('board.rooms.heading') }}</h1>
          <div class="section-counts">
            <span><i class="dot recruiting" />{{ $t('board.rooms.recruiting') }} <b>{{ recruitingCount ?? '—' }}</b></span>
            <span><i class="dot playing" />{{ $t('board.rooms.playing') }} <b>{{ playingCount ?? '—' }}</b></span>
          </div>
        </div>
        <div class="sr-only" role="status" aria-live="polite">{{ srStatus }}</div>
        <div class="card-grid" :aria-busy="connecting ? 'true' : 'false'">
          <template v-if="roomList.length">
            <RoomCard v-for="(room, index) in roomList" :key="room.id" :room="room" :style="stagger(index)" @open="openRoom(room)" />
          </template>
          <div v-else class="empty-state" :class="{ error: rooms.failed }">
            {{ rooms.failed ? $t('board.rooms.failed') : (connecting ? $t('common.connecting') : $t('board.rooms.empty')) }}
          </div>
        </div>
        <PaginationNav
          :page="rooms.page"
          :has-previous="rooms.page > 0"
          :has-next="Boolean(rooms.nextCursor)"
          :label="$t('board.rooms.heading')"
          @previous="previousPage('rooms')"
          @next="nextPage('rooms')"
        />
      </section>

      <section class="directory-section history-section" aria-labelledby="history-title">
        <div class="section-heading"><h2 id="history-title">{{ $t('board.history.heading') }}</h2></div>
        <div class="sr-only" role="status" aria-live="polite">{{ srStatus }}</div>
        <div class="history-list" :aria-busy="connecting ? 'true' : 'false'">
          <template v-if="historyList.length">
            <HistoryCard v-for="(record, index) in historyList" :key="record.id" :record="record" :style="stagger(index)" @open="openHistory(record)" />
          </template>
          <div v-else class="empty-state" :class="{ error: history.failed }">
            {{ history.failed ? $t('board.history.failed') : (connecting ? $t('common.connecting') : $t('board.history.empty')) }}
          </div>
        </div>
        <PaginationNav
          :page="history.page"
          :has-previous="history.page > 0"
          :has-next="Boolean(history.nextCursor)"
          :label="$t('board.history.heading')"
          @previous="previousPage('history')"
          @next="nextPage('history')"
        />
      </section>
    </main>

    <BoardModal />
  </div>
</template>
