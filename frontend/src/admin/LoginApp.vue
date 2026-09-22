<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import LocaleSelect from "../shared/components/LocaleSelect.vue";
import ThemeToggle from "../shared/components/ThemeToggle.vue";
import { persistLocale } from "../shared/i18n";

const { t, locale } = useI18n();
const password = ref("");
const busy = ref(false);
const error = ref("");
const message = ref("");

watch(locale, (next) => persistLocale(next));
watch(locale, () => { document.title = t("admin.login.title"); }, { immediate: true });

onMounted(async () => {
  message.value = t("admin.login.checking");
  try {
    const response = await fetch("/admin/api/session", { credentials: "same-origin", cache: "no-store" });
    if (response.ok && (await response.json() as { authenticated?: boolean }).authenticated) {
      message.value = t("admin.login.already");
      window.location.assign("/admin");
      return;
    }
  } catch { /* Fall through to the sign-in form. */ }
  message.value = "";
});

async function submit() {
  if (busy.value || !password.value) return;
  busy.value = true;
  error.value = "";
  message.value = t("admin.login.submitting");
  try {
    const response = await fetch("/admin/api/login", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password.value }),
    });
    if (response.ok) {
      message.value = "";
      window.location.assign("/admin");
      return;
    }
    const detail = await response.json().catch(() => null) as { error?: unknown } | null;
    const text = detail && typeof detail.error === "string" ? detail.error : `HTTP ${response.status}`;
    error.value = t("admin.login.failed", { message: text });
    message.value = "";
  } catch (cause) {
    error.value = t("admin.login.failed", { message: cause instanceof Error ? cause.message : "" });
    message.value = "";
  } finally {
    busy.value = false;
    password.value = "";
  }
}
</script>

<template>
  <main class="login-shell">
    <header class="login-top">
      <LocaleSelect />
      <ThemeToggle />
    </header>
    <form class="login-card" @submit.prevent="submit">
      <h1 class="login-heading">{{ t("admin.login.heading") }}</h1>
      <label class="login-field">
        <span class="login-label">{{ t("admin.login.password") }}</span>
        <input v-model="password" type="password" autocomplete="current-password"
          :disabled="busy" required autocomplete-data-lpignore="true" />
      </label>
      <button class="login-submit" type="submit" :disabled="busy || !password">
        {{ busy ? t("admin.login.submitting") : t("admin.login.submit") }}
      </button>
      <p v-if="message" class="login-message">{{ message }}</p>
      <p v-if="error" class="login-error" role="alert">{{ error }}</p>
    </form>
  </main>
</template>
