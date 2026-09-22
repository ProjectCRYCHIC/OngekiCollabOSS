<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import LocaleSelect from "../shared/components/LocaleSelect.vue";
import ThemeToggle from "../shared/components/ThemeToggle.vue";
import { persistLocale } from "../shared/i18n";
import { adminApi, useAdminList, useIdentityMode } from "./admin";
import BattleItem, { type AdminBattle } from "./components/BattleItem.vue";
import PlayerItem, { type AdminPlayer } from "./components/PlayerItem.vue";

const { t, locale } = useI18n();
const mode = useIdentityMode();
const players = useAdminList("/admin/api/players");
const battles = useAdminList("/admin/api/battles");
const playerQuery = ref("");

watch(locale, (next) => persistLocale(next));
watch(locale, () => { document.title = t("admin.title"); }, { immediate: true });

mode.refresh();
void players.loadList();
void battles.loadList();

function onModeChange(event: Event) {
  void mode.save((event.target as HTMLInputElement).checked);
}

function onPlayerSearch() {
  players.search(playerQuery.value.trim());
}

function findPlayer(id: string) {
  playerQuery.value = id;
  players.search(id);
  document.getElementById("players-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function playerAction(player: AdminPlayer, action: "ban" | "unban", reason = "") {
  if (players.state.busy) return;
  const confirmed = action === "ban" ? window.confirm(t("admin.players.banConfirm")) : window.confirm(t("admin.players.unbanConfirm"));
  if (!confirmed) return;
  players.setListStatus(t(action === "ban" ? "admin.players.banning" : "admin.players.unbanning"));
  players.state.busy = true;
  try {
    await adminApi(`/admin/api/players/${encodeURIComponent(player.id)}/${action}`, "POST",
      action === "ban" && reason ? { reason } : {});
    players.state.busy = false;
    players.state.previous = [];
    const done = await players.loadList(null, t(action === "ban" ? "admin.players.banDone" : "admin.players.unbanDone"));
    if (!done) players.setListStatus(t("admin.players.refreshFailed"), "error");
  } catch (error) {
    players.setListStatus(t("admin.players.actionFailed", {
      message: error instanceof Error ? error.message : "",
    }), "error");
  } finally {
    players.state.busy = false;
  }
}

async function closeBattle(id: string) {
  if (battles.state.busy) return;
  if (!window.confirm(t("admin.battles.closeConfirm"))) return;
  battles.setListStatus(t("admin.battles.closing"));
  battles.state.busy = true;
  try {
    await adminApi(`/admin/api/battles/${encodeURIComponent(id)}/close`, "POST", {});
    battles.state.busy = false;
    battles.state.previous = [];
    const done = await battles.loadList(null, t("admin.battles.closeDone"));
    if (!done) battles.setListStatus(t("admin.players.refreshFailed"), "error");
  } catch (error) {
    battles.setListStatus(t("admin.players.actionFailed", {
      message: error instanceof Error ? error.message : "",
    }), "error");
  } finally {
    battles.state.busy = false;
  }
}
</script>

<template>
  <div class="site-shell">
    <header class="site-header">
      <a class="brand" href="/">Ongeki<span>Collab</span></a>
      <div class="header-actions">
        <LocaleSelect />
        <ThemeToggle />
        <span class="page-label">{{ $t('admin.pageLabel') }}</span>
      </div>
    </header>

    <main>
      <h1>{{ $t('admin.heading') }}</h1>

      <section class="settings-card" aria-labelledby="mode-title">
        <div class="card-heading">
          <h2 id="mode-title">{{ $t('admin.mode.title') }}</h2>
          <label class="switch">
            <input
              type="checkbox"
              role="switch"
              :checked="mode.required.value ?? false"
              :disabled="mode.busy.value || mode.required.value === null"
              aria-labelledby="mode-title"
              @change="onModeChange"
            >
            <span class="switch-track" aria-hidden="true"></span>
          </label>
        </div>
        <p class="request-status" :class="mode.status.value.tone" role="status" aria-live="polite">{{ mode.status.value.message }}</p>
      </section>

      <section class="settings-card" aria-labelledby="players-title">
        <div class="card-heading">
          <h2 id="players-title">{{ $t('admin.players.title') }}</h2>
          <button class="button" type="button" :disabled="players.state.busy" @click="players.refreshCurrent()">
            {{ $t('admin.players.refresh') }}
          </button>
        </div>
        <p class="section-note">{{ $t('admin.players.note') }}</p>
        <form class="search-form" autocomplete="off" @submit.prevent="onPlayerSearch">
          <div class="search-controls">
            <input
              v-model="playerQuery"
              type="search"
              class="text-input"
              maxlength="128"
              spellcheck="false"
              :aria-label="$t('admin.players.searchLabel')"
              :placeholder="$t('admin.players.searchPlaceholder')"
            >
            <button class="button" type="submit" :disabled="players.state.busy">{{ $t('admin.players.find') }}</button>
          </div>
        </form>
        <div class="admin-list" :aria-busy="players.state.busy ? 'true' : 'false'">
          <template v-if="players.state.items.length">
            <PlayerItem
              v-for="(player, index) in players.state.items as AdminPlayer[]"
              :key="player.id ?? index"
              :player="player"
              :busy="players.state.busy"
              @action="playerAction"
            />
          </template>
          <p v-else class="empty-state">{{ $t('admin.list.empty') }}</p>
        </div>
        <div class="list-footer">
          <span class="request-status" :class="players.status.value.tone" role="status" aria-live="polite">{{ players.status.value.message }}</span>
          <nav v-if="players.canPrevious.value || players.canNext.value" class="pagination" :aria-label="$t('admin.players.title')">
            <button class="button" type="button" :disabled="!players.canPrevious.value" @click="players.onPrevious">{{ $t('common.prevPage') }}</button>
            <button class="button" type="button" :disabled="!players.canNext.value" @click="players.onNext">{{ $t('common.nextPage') }}</button>
          </nav>
        </div>
      </section>

      <section class="settings-card" aria-labelledby="battles-title">
        <div class="card-heading">
          <h2 id="battles-title">{{ $t('admin.battles.title') }}</h2>
          <button class="button" type="button" :disabled="battles.state.busy" @click="battles.refreshCurrent()">
            {{ $t('admin.battles.refresh') }}
          </button>
        </div>
        <div class="admin-list" :aria-busy="battles.state.busy ? 'true' : 'false'">
          <template v-if="battles.state.items.length">
            <BattleItem
              v-for="(battle, index) in battles.state.items as AdminBattle[]"
              :key="battle.id ?? index"
              :battle="battle"
              :busy="battles.state.busy"
              @find="findPlayer"
              @close="closeBattle"
            />
          </template>
          <p v-else class="empty-state">{{ $t('admin.list.empty') }}</p>
        </div>
        <div class="list-footer">
          <span class="request-status" :class="battles.status.value.tone" role="status" aria-live="polite">{{ battles.status.value.message }}</span>
          <nav v-if="battles.canPrevious.value || battles.canNext.value" class="pagination" :aria-label="$t('admin.battles.title')">
            <button class="button" type="button" :disabled="!battles.canPrevious.value" @click="battles.onPrevious">{{ $t('common.prevPage') }}</button>
            <button class="button" type="button" :disabled="!battles.canNext.value" @click="battles.onNext">{{ $t('common.nextPage') }}</button>
          </nav>
        </div>
      </section>
    </main>
  </div>
</template>
