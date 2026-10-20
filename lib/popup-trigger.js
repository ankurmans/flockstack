import { readerMarkerName } from "./reader-cookies.js";
import { readStoredNumber, subscribeSnoozedKey, subscribedKey } from "./storage.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Exit intent counts only once the reader has been on the page a moment: a mouse that starts outside the window isn't leaving.
export const EXIT_ARM_MS = 3000;

// Waits for the moment the newsletter chose (lib/popup-rules.js) and calls open(source) once: after some seconds, once the reader
// is some way down the page, or when the mouse leaves through the top of the window on a desktop. It never opens for someone
// who signed up in this browser or signed in with an emailed link, nor within frequencyDays of the reader closing it: both are
// flags in the browser's own storage, and nothing is sent anywhere. Returns what undoes it, or nothing when it won't open.
export function armPopup({ slug, trigger, seconds, scrollPercent, frequencyDays, open }, { window: win = window, document: doc = document, now = Date.now } = {}) {
	// A reader who signed in to comment with a link from an email is a subscriber already.
	const isSignedIn = () => doc.cookie.split("; ").includes(`${readerMarkerName(slug)}=1`);
	const isSubscribed = () => readStoredNumber(subscribedKey(slug)) > 0 || isSignedIn();
	const isSnoozed = () => now() - readStoredNumber(subscribeSnoozedKey(slug)) < frequencyDays * DAY_MS;
	if (isSubscribed() || isSnoozed()) return undefined;
	const show = (source) => {
		if (!isSubscribed() && !isSnoozed()) open(source);
	};

	if (trigger === "time") {
		const timer = setTimeout(() => show("time"), seconds * 1000);
		return () => clearTimeout(timer);
	}

	if (trigger === "exit") {
		if (!win.matchMedia("(hover: hover) and (pointer: fine)").matches) return undefined;
		const onLeave = (event) => {
			if (event.relatedTarget === null && event.clientY <= 0) show("exit");
		};
		const timer = setTimeout(() => doc.addEventListener("mouseout", onLeave), EXIT_ARM_MS);
		return () => {
			clearTimeout(timer);
			doc.removeEventListener("mouseout", onLeave);
		};
	}

	function onScroll() {
		const { scrollTop, scrollHeight, clientHeight } = doc.documentElement;
		if ((scrollTop + clientHeight) / scrollHeight < scrollPercent / 100) return;
		win.removeEventListener("scroll", onScroll);
		show("scroll");
	}
	win.addEventListener("scroll", onScroll, { passive: true });
	return () => win.removeEventListener("scroll", onScroll);
}
