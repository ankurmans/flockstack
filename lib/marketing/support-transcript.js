// The support chat's conversation in the browser (components/marketing/PanelSupportChat.jsx): kept in the tab's
// sessionStorage only, so it is gone when the tab closes, and cleared on sign-out. The server keeps none of it.
export const STORAGE_KEY = "flockstack:support-chat";
const MAX_STORED_MESSAGES = 20;
// A mailto: link's length is limited by the mail app that opens it; the end of the conversation matters most.
const MAX_MAILTO_BODY_CHARS = 1800;

// [{ role, content, sources?, handoff? }], or [] for nothing usable. Storage can be blocked or hold anything.
export function readStoredChat(storage) {
	try {
		const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((message) => (message?.role === "user" || message?.role === "assistant") && typeof message.content === "string")
			.map(({ role, content, sources, handoff }) => ({
				role,
				content,
				sources: Array.isArray(sources) ? sources.filter((source) => typeof source?.href === "string" && source.href.startsWith("/") && typeof source.title === "string") : [],
				handoff: handoff === true,
			}))
			.slice(-MAX_STORED_MESSAGES);
	} catch {
		return [];
	}
}

export function saveChat(storage, messages) {
	try {
		if (messages.length === 0) storage?.removeItem(STORAGE_KEY);
		else storage?.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_STORED_MESSAGES)));
	} catch {
		// Blocked or full storage: the conversation lasts until the page reloads.
	}
}

export function clearChat(storage) {
	try {
		storage?.removeItem(STORAGE_KEY);
	} catch {
		// Nothing was kept.
	}
}

// What the server reads: the role and the text, nothing the page added.
export function toRequestMessages(messages) {
	return messages.slice(-MAX_STORED_MESSAGES).map(({ role, content }) => ({ role, content: content ?? "" }));
}

// The answer's [1] markers point at excerpts the panel lists as sources, so the text reads without them.
export function stripCitationMarks(text) {
	return String(text ?? "")
		.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "")
		.trim();
}

export function formatTranscript(messages) {
	return messages.map(({ role, content }) => `${role === "user" ? "Me" : "FlockStack assistant"}: ${content}`).join("\n\n");
}

// For a visitor who isn't signed in: their own mail app opens with the conversation, to send from their own address.
export function toMailtoHref({ address, messages }) {
	const transcript = formatTranscript(messages);
	const body = transcript.length > MAX_MAILTO_BODY_CHARS ? `…${transcript.slice(-MAX_MAILTO_BODY_CHARS)}` : transcript;
	return `mailto:${address}?subject=${encodeURIComponent("Question from the FlockStack help chat")}&body=${encodeURIComponent(body)}`;
}
