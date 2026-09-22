import { createApp } from "vue";
import "../shared/base.css";
import { i18n } from "../shared/i18n";
import "./admin.css";
import AdminApp from "./AdminApp.vue";

createApp(AdminApp).use(i18n).mount("#app");
