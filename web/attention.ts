import { onBeforeUnmount, watch, type Ref } from "vue";

/**
 * Tells a person who switched tabs that Ponder Chat needs them: a count on the favicon and in
 * the page title. A reply that waits on them (an approval, questions, a plan) counts at
 * once. A finished reply counts only if no new one starts within 2 seconds, so a run that
 * ends and goes on (an approval answered by the server, a queued message) counts once.
 * The count clears when the tab is seen again. Adapted from T3 Code's thread notifications.
 */
const FINISH_GRACE_MS = 2_000;
const BASE_TITLE = "Ponder Chat";
/** The favicon without a badge; index.html links the same one. */
const ICON = "/favicon.png";

class Attention {
	private count = 0;
	private base?: Promise<HTMLImageElement>;
	/** Each render takes a number: a badge drawn after a newer render (the tab seen again, say) is dropped. */
	private rendering = 0;

	constructor() {
		document.addEventListener("visibilitychange", () => {
			if (!document.hidden) this.clear();
		});
	}

	/** One more thing waits for the person, if they are not looking. */
	add() {
		if (!document.hidden) return;
		this.count++;
		void this.render();
	}

	private clear() {
		if (!this.count) return;
		this.count = 0;
		void this.render();
	}

	private async render() {
		const mine = ++this.rendering;
		const label = this.count > 9 ? "9+" : String(this.count);
		document.title = this.count ? `(${label}) ${BASE_TITLE}` : BASE_TITLE;
		const icon = this.count ? await this.badged(label) : ICON;
		if (mine === this.rendering) setFavicon(icon);
	}

	/** The favicon with a red badge and the count at its top right. */
	private async badged(label: string) {
		const size = 64;
		const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
		const context = canvas.getContext("2d");
		if (!context) return ICON;
		context.drawImage(await this.baseImage(), 0, 0, size, size);
		context.fillStyle = "#e03636";
		context.beginPath();
		context.arc(size - 18, 18, 18, 0, Math.PI * 2);
		context.fill();
		context.fillStyle = "#fff";
		context.font = `700 ${label.length > 1 ? 20 : 26}px system-ui, sans-serif`;
		context.textAlign = "center";
		context.textBaseline = "middle";
		context.fillText(label, size - 18, 19);
		return canvas.toDataURL("image/png");
	}

	private baseImage() {
		this.base ??= new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = reject;
			image.src = ICON;
		});
		return this.base;
	}
}

let attention: Attention | undefined;

/** Counts this chat's replies toward the badge while the tab is hidden. Call from a chat's setup. */
export function useAttention(busy: Ref<boolean>, waiting: Ref<boolean>) {
	attention ??= new Attention();
	const counter = attention;
	let finishTimer: ReturnType<typeof setTimeout> | undefined;
	const cancelFinish = () => clearTimeout(finishTimer);

	watch(waiting, (now) => {
		if (now) counter.add();
	});
	watch(busy, (now) => {
		cancelFinish();
		if (now || waiting.value) return;
		finishTimer = setTimeout(() => {
			if (!busy.value && !waiting.value) counter.add();
		}, FINISH_GRACE_MS);
	});
	onBeforeUnmount(cancelFinish);
}

function setFavicon(href: string) {
	let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	if (!link) {
		link = Object.assign(document.createElement("link"), { rel: "icon" });
		document.head.append(link);
	}
	link.href = href;
}
