import { definePlugin } from "nitro";
import { startup } from "../startup.ts";

// Runs once when the Nitro server starts (nitro.config.ts registers it).
export default definePlugin(async () => {
	await startup();
});
