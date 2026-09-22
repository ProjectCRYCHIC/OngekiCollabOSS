<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { formatFull, valueOrDash } from "../../shared/format";

export interface AdminBattle {
  id: string;
  pool?: string;
  status?: string;
  song?: { title?: unknown };
  playerCount?: number;
  createdAt?: number;
  startedAt?: number | null;
  players?: Array<{ id?: unknown; username?: unknown }>;
}

const props = defineProps<{ battle: AdminBattle; busy: boolean }>();
defineEmits<{ find: [id: string]; close: [id: string] }>();
const { t, locale } = useI18n();

function statusKey(status: unknown): string {
  return status === "recruiting" ? "admin.battles.recruiting"
    : status === "playing" ? "admin.battles.playing"
    : status === "closed" ? "admin.battles.closed"
    : "admin.battles.unknown";
}
function statusClass(status: unknown): string {
  return status === "closed" ? "off" : "on";
}
const title = computed(() => typeof props.battle.song?.title === "string" && props.battle.song.title
  ? props.battle.song.title
  : t('admin.battles.unnamed'));

function known(player: { id?: unknown; username?: unknown }): player is { id: string; username?: string } {
  return typeof player?.id === "string";
}
</script>

<template>
  <article class="admin-item">
    <div class="item-heading">
      <strong class="item-name">{{ title }}</strong>
      <span class="mode-badge" :class="statusClass(battle.status)">{{ $t(statusKey(battle.status)) }}</span>
    </div>
    <p class="detail-line"><span class="detail-label">{{ $t('admin.battles.id') }}</span><span class="detail-value">{{ battle.id }}</span></p>
    <p class="detail-line"><span class="detail-label">{{ $t('admin.battles.pool') }}</span><span class="detail-value">{{ battle.pool ? battle.pool : $t('admin.battles.publicPool') }}</span></p>
    <p class="detail-line"><span class="detail-label">{{ $t('admin.battles.count') }}</span><span class="detail-value">{{ valueOrDash(battle.playerCount) }}</span></p>
    <p class="detail-line"><span class="detail-label">{{ $t('admin.battles.createdAt') }}</span><span class="detail-value">{{ formatFull(locale, battle.createdAt) }}</span></p>
    <p v-if="battle.startedAt" class="detail-line"><span class="detail-label">{{ $t('admin.battles.startedAt') }}</span><span class="detail-value">{{ formatFull(locale, battle.startedAt) }}</span></p>
    <div v-if="battle.players?.length" class="participants">
      <strong class="participants-title">{{ $t('admin.battles.playersTitle') }}</strong>
      <div v-for="(player, index) in battle.players" :key="index" class="participant">
        <template v-if="known(player)">
          <span class="participant-name">{{ typeof player.username === "string" && player.username ? player.username : $t('admin.players.unnamed') }}</span>
          <span class="participant-id">{{ player.id }}</span>
          <button class="button small" type="button" :disabled="busy" @click="$emit('find', player.id)">
            {{ $t('admin.battles.findPlayer') }}
          </button>
        </template>
      </div>
    </div>
    <div v-if="battle.status !== 'closed'" class="item-actions">
      <button class="button danger" type="button" :disabled="busy" @click="$emit('close', battle.id)">
        {{ $t('admin.battles.close') }}
      </button>
    </div>
  </article>
</template>
