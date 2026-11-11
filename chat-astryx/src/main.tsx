// First: styles.css declares the cascade layer order, which every theme's CSS must follow.
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

// The open thread lives in the URL (?t=<id>); App loads it.
createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
