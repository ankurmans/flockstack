// The signup pop-up on a newsletter's website, and the option to gate issues behind subscribing. A newsletter that never
// saved any of it behaves as it always did: a pop-up on issue pages once the reader is 45% down, snoozed for two weeks
// when closed.
export const POPUP_TRIGGERS = ["scroll", "time", "exit"];
export const POPUP_PAGES = ["issues", "home", "all"];
export const POPUP_LIMITS = {
	seconds: { min: 3, max: 300 },
	scrollPercent: { min: 10, max: 90 },
	frequencyDays: { min: 1, max: 365 },
	previewPercent: { min: 10, max: 80 },
	freeLatest: { min: 0, max: 10 },
};
export const POPUP_DEFAULTS = Object.freeze({
	enabled: true,
	trigger: "scroll",
	seconds: 15,
	scrollPercent: 45,
	frequencyDays: 14,
	pages: "issues",
	gate: Object.freeze({ enabled: false, previewPercent: 30, freeLatest: 1 }),
});

// The settings as saved, over the defaults.
export function getPopupSettings(newsletter) {
	const saved = newsletter?.popup ?? {};
	const gate = saved.gate ?? {};
	const pick = (value, fallback) => (value === undefined || value === null ? fallback : value);
	return {
		enabled: pick(saved.enabled, POPUP_DEFAULTS.enabled),
		trigger: pick(saved.trigger, POPUP_DEFAULTS.trigger),
		seconds: pick(saved.seconds, POPUP_DEFAULTS.seconds),
		scrollPercent: pick(saved.scrollPercent, POPUP_DEFAULTS.scrollPercent),
		frequencyDays: pick(saved.frequencyDays, POPUP_DEFAULTS.frequencyDays),
		pages: pick(saved.pages, POPUP_DEFAULTS.pages),
		gate: {
			enabled: pick(gate.enabled, POPUP_DEFAULTS.gate.enabled),
			previewPercent: pick(gate.previewPercent, POPUP_DEFAULTS.gate.previewPercent),
			freeLatest: pick(gate.freeLatest, POPUP_DEFAULTS.gate.freeLatest),
		},
	};
}

function isWithin(value, { min, max }) {
	return Number.isInteger(value) && value >= min && value <= max;
}

// The first problem in settings, in plain words, or null.
export function getPopupProblem(settings) {
	if (!POPUP_TRIGGERS.includes(settings.trigger)) return `trigger: use ${POPUP_TRIGGERS.join(", ")}`;
	if (!POPUP_PAGES.includes(settings.pages)) return `pages: use ${POPUP_PAGES.join(", ")}`;
	const { seconds, scrollPercent, frequencyDays } = POPUP_LIMITS;
	if (!isWithin(settings.seconds, seconds)) return `seconds: a whole number from ${seconds.min} to ${seconds.max}`;
	if (!isWithin(settings.scrollPercent, scrollPercent)) return `scrollPercent: a whole number from ${scrollPercent.min} to ${scrollPercent.max}`;
	if (!isWithin(settings.frequencyDays, frequencyDays)) return `frequencyDays: a whole number from ${frequencyDays.min} to ${frequencyDays.max}`;
	const { previewPercent, freeLatest } = POPUP_LIMITS;
	if (!isWithin(settings.gate.previewPercent, previewPercent)) return `gate.previewPercent: a whole number from ${previewPercent.min} to ${previewPercent.max}`;
	if (!isWithin(settings.gate.freeLatest, freeLatest)) return `gate.freeLatest: a whole number from ${freeLatest.min} to ${freeLatest.max}`;
	return null;
}

// place: "home", "issue" or "other" (the pages that aren't an issue or the front page, like an author's).
export function isPopupOn(popup, place) {
	if (!popup.enabled) return false;
	if (popup.pages === "all") return true;
	return popup.pages === "issues" ? place === "issue" : place === "home";
}

// Whether an issue shows only its beginning to someone who isn't signed in. newestIds: the IDs of the newsletter's newest
// listed issues, as many as the gate keeps free. A paid issue has its own teaser and isn't this gate's.
export function isGatedIssue(popup, issue, newestIds = []) {
	if (!popup.gate.enabled || issue.audience === "paid") return false;
	return !newestIds.map(String).includes(String(issue._id));
}

// What makeTeaser (lib/paywall.js) takes for a gate's preview: the share the owner chose, never more, in plain text.
export function getGateTeaserOptions(popup) {
	const share = popup.gate.previewPercent / 100;
	return { share, maxShare: share, maxChars: 4000, maxParagraphs: 12 };
}

// What the page hands the component that opens the pop-up.
export function getTriggerProps(popup) {
	const { trigger, seconds, scrollPercent, frequencyDays } = popup;
	return { trigger, seconds, scrollPercent, frequencyDays };
}
