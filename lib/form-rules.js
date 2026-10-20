import { ACCENT_PATTERN, DEFAULT_ACCENT, getAccent, getTextOn } from "./editor-blocks.js";

// The signup forms a newsletter puts on other sites (lib/forms.js).
export const MAX_FORMS_PER_NEWSLETTER = 20;
export const MAX_FORM_FIELDS = 5;
export const MAX_BUTTON_TEXT = 30;
export const MAX_SUCCESS_MESSAGE = 200;
export const DEFAULT_BUTTON_TEXT = "Subscribe";
export const DEFAULT_SUCCESS_MESSAGE = "You're in. The next issue lands in your inbox.";
export const COLOR_KEYS = ["button", "buttonText", "background", "text"];
export const DEFAULT_TEXT_COLOR = "#18181b";
export const FORM_ID_PATTERN = /^[a-f0-9]{24}$/i;

function isHttpsUrl(value) {
	if (value.length > 500) return false;
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

// What a form's builder or action sent, checked: the first problem in plain words, or null.
export function getFormProblem({ name, buttonText, fields, colors, successMessage, redirectUrl }) {
	if (!String(name ?? "").trim()) return "Give the form a name";
	if (String(buttonText ?? "").length > MAX_BUTTON_TEXT) return `Keep the button text under ${MAX_BUTTON_TEXT} characters`;
	if ((fields ?? []).length > MAX_FORM_FIELDS) return `A form can ask for ${MAX_FORM_FIELDS} fields at most besides the email`;
	if (new Set(fields ?? []).size !== (fields ?? []).length) return "A field is listed twice";
	for (const key of COLOR_KEYS) {
		const color = colors?.[key];
		if (color && !ACCENT_PATTERN.test(color)) return `The ${key === "buttonText" ? "button text" : key} color must be a hex color like #1f6feb`;
	}
	if (String(successMessage ?? "").length > MAX_SUCCESS_MESSAGE) return `Keep the success message under ${MAX_SUCCESS_MESSAGE} characters`;
	if (redirectUrl && !isHttpsUrl(redirectUrl)) return "The page to send people to must be an https:// link";
	return null;
}

// The colors a form is drawn with: its own, else the newsletter's accent for the button, the best-contrasting text on it,
// a transparent page and plain dark text.
export function getFormColors(form, newsletter) {
	const own = form?.colors ?? {};
	const valid = (value) => (ACCENT_PATTERN.test(value ?? "") ? value.toLowerCase() : null);
	const button = valid(own.button) ?? getAccent(newsletter) ?? DEFAULT_ACCENT;
	return {
		button,
		buttonText: valid(own.buttonText) ?? getTextOn(button),
		background: valid(own.background) ?? "transparent",
		text: valid(own.text) ?? DEFAULT_TEXT_COLOR,
	};
}

// What a visitor sees after a signup that is done: the form's words, or the usual ones. A signup that waits for its
// confirmation gets the same instruction on every form.
export function getFormMessage(form) {
	return form?.successMessage?.trim() || DEFAULT_SUCCESS_MESSAGE;
}

export function getFormButtonText(form) {
	return form?.buttonText?.trim() || DEFAULT_BUTTON_TEXT;
}

// The fixed words a form page prints for a refused signup, by code: an address from a plain form post is never printed back.
export const FORM_ERRORS = {
	invalid: "Enter a valid email address.",
	limit: "Too many signups from your network. Try again in a few minutes.",
	closed: "This newsletter is not taking signups.",
	failed: "Something went wrong. Try again.",
};

export function getErrorCode(message) {
	if (/too many/i.test(message)) return "limit";
	if (/not taking signups/i.test(message)) return "closed";
	return /email|address|inbox/i.test(message) ? "invalid" : "failed";
}
