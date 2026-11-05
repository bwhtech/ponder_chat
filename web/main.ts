import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

// The open thread lives in the URL (?t=<id>); App loads it.
createApp(App).mount("#app");
