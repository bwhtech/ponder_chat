import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

// The width of a thin scrollbar, which the transcript reserves on both sides (style.css, .scroll-gutter-match).
const probe = Object.assign(document.createElement("div"), { className: "scrollbar-thin" });
// Measured as a reserved gutter, the way the transcript reserves it: Chrome reports 0 for a plain overflow: scroll box.
probe.style.cssText = "position:absolute;visibility:hidden;overflow:auto;scrollbar-gutter:stable;width:100px;height:100px";
document.body.append(probe);
document.documentElement.style.setProperty("--scroll-gutter", `${probe.offsetWidth - probe.clientWidth}px`);
probe.remove();

// The open thread lives in the URL (?t=<id>); App loads it.
createApp(App).mount("#app");
