import { createApp } from "vue";
import "../shared/base.css";
import { i18n } from "../shared/i18n";
import "./login.css";
import LoginApp from "./LoginApp.vue";

createApp(LoginApp).use(i18n).mount("#app");
