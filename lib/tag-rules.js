// What a tag is, with nothing that touches the database, so the CSV import in the browser reads tags the same way.

export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS_PER_CONTACT = 30;
export const MAX_TAGS_PER_NEWSLETTER = 200;
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.:/+&-]*$/u;

// Tags are compared as written in lowercase with single spaces: "VIP  customers" is "vip customers".
export function normalizeTag(value) {
	if (typeof value !== "string") return null;
	const tag = value.trim().replace(/\s+/g, " ").toLowerCase();
	return tag && tag.length <= MAX_TAG_LENGTH && TAG_PATTERN.test(tag) ? tag : null;
}

// A CSV cell or a form field: tags separated by commas, semicolons or bars. Invalid ones are left out.
export function parseTagList(text) {
	const tags = [];
	for (const part of String(text ?? "").split(/[,;|]/)) {
		const tag = normalizeTag(part);
		if (tag && !tags.includes(tag)) tags.push(tag);
	}
	return tags;
}
