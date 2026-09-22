import { createApp } from "vue";
import "../shared/base.css";
import { i18n } from "../shared/i18n";
import "./board.css";
import App from "./App.vue";

createApp(App).use(i18n).mount("#app");
