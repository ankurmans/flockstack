// The undo window of a send from the dashboard (lib/send-hold.js): how long it waits, and what the bar counts down.
// Free of server modules: the dashboard's bar reads it too.

export const UNDO_SECONDS = [0, 10, 30, 60];
export const DEFAULT_UNDO_SECONDS = 30;

// A hold nobody released after this long is released by the hourly sweep: the job that should have done it was lost.
export const HOLD_STALE_MS = 3 * 60 * 1000;

// The window event the Send button raises when a send is held, so the bar shows it before the page has looked.
export const SEND_HELD_EVENT = "flockstack:send-held";

// And when a send went out at once (the newsletter has no undo window), so the bar can say so.
export const SEND_STARTED_EVENT = "flockstack:send-started";

export const UNDO_LABELS = { 0: "Off", 10: "10 seconds", 30: "30 seconds", 60: "60 seconds" };

// The seconds a newsletter holds a send for. A newsletter that never chose has the default.
export function getUndoSeconds(newsletter) {
	const seconds = newsletter?.sendUndoSeconds;
	return UNDO_SECONDS.includes(seconds) ? seconds : DEFAULT_UNDO_SECONDS;
}

export function getUndoProblem(seconds) {
	return seconds === undefined || seconds === null || UNDO_SECONDS.includes(seconds) ? null : `Undo send is ${UNDO_SECONDS.join(", ")} seconds`;
}

// Whole seconds left, never below 0. offsetMs: the server's clock minus the browser's, so a wrong clock doesn't change the count.
export function getSecondsLeft(sendAfter, now = Date.now(), offsetMs = 0) {
	return Math.max(0, Math.ceil((new Date(sendAfter).getTime() - (now + offsetMs)) / 1000));
}
