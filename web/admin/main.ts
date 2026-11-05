import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import { routes } from "./router";
import "./style.css";

// The admin pages: their own app, with routes under /admin/ (server/app.ts serves admin.html for all of them).
const router = createRouter({ history: createWebHistory("/admin/"), routes });
createApp(App).use(router).mount("#app");
