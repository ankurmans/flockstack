// The merge tag an issue can carry to send readers to its comments, signed in: {{comment_link}}. Markdown encodes the
// braces of a link (%7B%7B), so both spellings count. Like the referral tags (lib/referral-tags.js), it is filled in for each
// subscriber when the email is built.
export const COMMENT_LINK_TAG = "{{comment_link}}";
const LINK_PATTERN = /\{\{\s*comment_link\s*\}\}|%7B%7B\s*comment_link\s*%7D%7D/gi;
const LINK_ONLY_PATTERN = /^(?:\{\{\s*comment_link\s*\}\}|%7B%7B\s*comment_link\s*%7D%7D)$/i;

// A link's address may be the merge tag.
export function isCommentLinkTag(value) {
	return LINK_ONLY_PATTERN.test(String(value ?? "").trim());
}

export function hasCommentTags(text) {
	return /\{\{\s*comment_link\s*\}\}|%7B%7B\s*comment_link\s*%7D%7D/i.test(String(text ?? ""));
}

// link: null leaves the tag as it is.
export function fillCommentTags(text, { link = null } = {}) {
	return link === null ? String(text ?? "") : String(text ?? "").replace(LINK_PATTERN, () => link);
}
