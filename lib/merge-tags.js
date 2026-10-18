// Merge tags in an email's subject, preview text and content: {{email}}, or {{first_name}} for a custom field of the
// newsletter, with the words to print when the contact has none after a bar: {{first_name|there}}. The tags that
// stand for the email itself ({{subject}}, {{unsubscribe_url}}...) are filled in elsewhere (lib/render-email.js).

const MERGE_TAG = /\{\{([a-z][a-z0-9_]{0,29})(?:\|([^{}|]{0,100}))?\}\}/g;
// The Markdown parser percent-encodes the braces and the bar of a tag written in a link's address.
const ENCODED_MERGE_TAG = /%7[Bb]%7[Bb]([a-z][a-z0-9_]{0,29})(?:%7[Cc]((?:(?!%7[Dd]).){0,300}))?%7[Dd]%7[Dd]/g;
// Also the tags filled in elsewhere: the billing link (lib/sending-rules.js), the referral program's (lib/referral-tags.js),
// the recommendations block (lib/recommendation-tags.js) and the comment link (lib/comment-tags.js).
export const RESERVED_TAGS = new Set([
	"subject",
	"preview_text",
	"unsubscribe_url",
	"confirm_url",
	"keep_url",
	"manage_billing_url",
	"referral_link",
	"referral_count",
	"recommendations",
	"comment_link",
]);

function readValue(contact, name) {
	if (name === "email") return contact?.email;
	return contact?.fields?.[name];
}

// contact: a stored contact (email, fields), or nothing for a page that has no reader: every tag prints its words.
// escape: how a value is written into the text around it (escapeHtml for HTML).
export function fillMergeTags(text, contact, { escape = (value) => value } = {}) {
	if (!text || (!text.includes("{{") && !/%7[Bb]%7[Bb]/.test(text))) return text ?? "";
	const read = (name, fallback) => {
		const value = readValue(contact, name);
		const isEmpty = value === undefined || value === null || String(value).trim() === "";
		return isEmpty ? (fallback ?? "").trim() : String(value);
	};
	return text
		.replace(MERGE_TAG, (match, name, fallback) => (RESERVED_TAGS.has(name) ? match : escape(read(name, fallback))))
		.replace(ENCODED_MERGE_TAG, (match, name, fallback) =>
			RESERVED_TAGS.has(name) ? match : encodeURIComponent(read(name, safeDecode(fallback)))
		);
}

function safeDecode(value) {
	try {
		return decodeURIComponent(value ?? "");
	} catch {
		return value ?? "";
	}
}

// The merge tags a text uses, once each, by name.
export function findMergeTags(text) {
	const names = new Set();
	for (const [, name] of String(text ?? "").matchAll(MERGE_TAG)) if (!RESERVED_TAGS.has(name)) names.add(name);
	return [...names];
}

export const BUILT_IN_MERGE_TAGS = ["email"];
