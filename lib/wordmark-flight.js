// The public header's plane (LogoFlight): a mouse entering the wordmark starts a flight, which app/globals.css plays
// while the plane's box has data-flying, and which ends once its line has faded. Entering again before that, or
// staying over the wordmark, starts nothing: the next flight takes a new entrance. CSS alone could only hold a hover
// a set time after the pointer leaves, so the next hover found the last flight still on.

// The media app/globals.css flies the plane in.
export const FLIGHT_MEDIA = "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)";
const LAST_ANIMATION = "wordmark-trail-fade";

export function startWordmarkFlights(wordmark, box, { canFly = () => matchMedia(FLIGHT_MEDIA).matches } = {}) {
	function onPointerEnter({ pointerType }) {
		if (pointerType !== "mouse" || "flying" in box.dataset || !canFly()) return;
		box.dataset.flying = "";
	}

	// A fade cut short ends the flight too, as when the media stops matching mid-flight.
	function onAnimationEnd({ animationName }) {
		if (animationName === LAST_ANIMATION) delete box.dataset.flying;
	}

	wordmark.addEventListener("pointerenter", onPointerEnter);
	box.addEventListener("animationend", onAnimationEnd);
	box.addEventListener("animationcancel", onAnimationEnd);
	return function stop() {
		wordmark.removeEventListener("pointerenter", onPointerEnter);
		box.removeEventListener("animationend", onAnimationEnd);
		box.removeEventListener("animationcancel", onAnimationEnd);
		delete box.dataset.flying;
	};
}
