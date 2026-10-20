// How long a text takes to read: words counted the way a person counts them, at a reader's usual pace.
export const WORDS_PER_MINUTE = 238;

export function countWords(text) {
	return String(text ?? "").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}

// Whole minutes, at least one for any text at all.
export function getReadMinutes(words) {
	return words > 0 ? Math.max(1, Math.round(words / WORDS_PER_MINUTE)) : 0;
}

export function formatReadTime(words) {
	const minutes = getReadMinutes(words);
	return minutes === 0 ? "" : `${minutes} min read`;
}

// The words of an HTML document: its head, styles and scripts are not the issue.
export function textFromHtml(html) {
	return String(html ?? "")
		.replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}
