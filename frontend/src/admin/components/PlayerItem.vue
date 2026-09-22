<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { formatFull, valueOrDash } from "../../shared/format";

export interface AdminPlayer {
  id: string;
  username?: string;
  kind?: string;
  serverDomain?: string;
  createdAt?: number;
  lastSeenAt?: number;
  bannedAt?: number | null;
  banReason?: string;
}

const props = defineProps<{ player: AdminPlayer; busy: boolean }>();
const emit = defineEmits<{ action: [player: AdminPlayer, action: "ban" | "unban", reason: string] }>();
const { t, locale } = useI18n();

const reason = ref("");
const REASONS = ["", "abuse", "disruption", "other"] as const;

function reasonKey(value: string): string {
  return value === "" ? "admin.players.reasonUnspecified"
    : value === "abuse" ? "admin.players.reasonAbuse"
    : value === "disruption" ? "admin.players.reasonDisruption"
    : "admin.players.reasonOther";
}

const bannedReason = computed(() => {
  const value = props.player.banReason ?? "";
  return t(REASONS.slice(1).includes(value as typeof REASONS[number]) ? reasonKey(value) : "admin.players.reasonOther");
});

function onBan() {
  emit("action", props.player, "ban", reason.value);
}
</script>

<template>
  <article class="admin-item">
    <div class="item-heading">
      <strong class="item-name">{{ player.username ? player.username : $t('admin.players.unnamed') }}</strong>
      <span class="mode-badge" :class="player.bannedAt ? 'off' : 'on'">{{ player.bannedAt ? $t('admin.players.banned') : $t('admin.players.active') }}</span>
    </div>
    <p class="detail-line"><span class="detail-label">{{ $t('admin.players.id') }}</span><span class="detail-value">{{ player.id }}</span></p>
    <p class="detail-line">
      <span class="detail-label">{{ $t('admin.players.type') }}</span>
      <span class="detail-value">{{ player.kind === "anonymous" ? $t('admin.players.kindAnonymous') : $t('admin.players.kindBound') }}</span>
    </p>
    <p class="detail-line"><span class="detail-label">{{ $t('admin.players.serverDomain') }}</span><span class="detail-value">{{ valueOrDash(player.serverDomain) }}</span></p>
    <p class="detail-line"><span class="detail-label">{{ $t('admin.players.createdAt') }}</span><span class="detail-value">{{ formatFull(locale, player.createdAt) }}</span></p>
    <p class="detail-line"><span class="detail-label">{{ $t('admin.players.lastSeen') }}</span><span class="detail-value">{{ formatFull(locale, player.lastSeenAt) }}</span></p>
    <template v-if="player.bannedAt">
      <p class="detail-line"><span class="detail-label">{{ $t('admin.players.bannedAt') }}</span><span class="detail-value">{{ formatFull(locale, player.bannedAt) }}</span></p>
      <p v-if="player.banReason" class="detail-line">
        <span class="detail-label">{{ $t('admin.players.reason') }}</span>
        <span class="detail-value">{{ bannedReason }}</span>
      </p>
    </template>
    <div class="item-actions">
      <template v-if="player.bannedAt">
        <button class="button" type="button" :disabled="busy" @click="$emit('action', player, 'unban', '')">
          {{ $t('admin.players.unban') }}
        </button>
      </template>
      <template v-else>
        <select v-model="reason" class="text-input reason-input" :disabled="busy" :aria-label="$t('admin.players.reasonAria', { id: player.id })">
          <option v-for="value in REASONS" :key="value" :value="value">{{ $t(reasonKey(value)) }}</option>
        </select>
        <button class="button danger" type="button" :disabled="busy" @click="onBan">
          {{ $t('admin.players.ban') }}
        </button>
      </template>
    </div>
  </article>
</template>
