import { slugify } from "./slug.js";
import { MAX_TAG_LENGTH, normalizeTag } from "./tag-rules.js";

// Tags on issues: a writer tags an issue, the website lists them as chips on the issue and gives each a page at
// /tags/<slug> that lists its issues. They are the issue's own, apart from a contact's tags (lib/tags.js), though they
// are written the same way.
export const MAX_ISSUE_TAGS = 10;
export const MAX_TAG_SLUG = 60;

export function getTagSlug(tag) {
	return slugify(tag, MAX_TAG_SLUG);
}

// The tags to store, with the slug of each for the tag page's query, or { problem } naming the first that isn't one.
// Two tags that read the same in a web address are one.
export function toIssueTags(values) {
	const tags = [];
	const tagSlugs = [];
	for (const value of values ?? []) {
		const tag = normalizeTag(value);
		const slug = tag && getTagSlug(tag);
		if (!tag || !slug) {
			return { problem: `tags: "${String(value).slice(0, 50)}" isn't a valid tag: use letters and digits, with spaces and - _ . : / + &, ${MAX_TAG_LENGTH} characters at most, and at least one letter from a to z or a digit` };
		}
		if (tagSlugs.includes(slug)) continue;
		tags.push(tag);
		tagSlugs.push(slug);
	}
	if (tags.length > MAX_ISSUE_TAGS) return { problem: `tags: an issue has up to ${MAX_ISSUE_TAGS}` };
	return { tags, tagSlugs };
}

// Every tag the issues use, most used first, then by name. issues: anything with tags and tagSlugs.
export function countIssueTags(issues) {
	const counts = new Map();
	for (const issue of issues) {
		for (const [index, name] of (issue.tags ?? []).entries()) {
			const slug = issue.tagSlugs?.[index] ?? getTagSlug(name);
			const entry = counts.get(slug) ?? { slug, name, issues: 0 };
			entry.issues += 1;
			counts.set(slug, entry);
		}
	}
	return [...counts.values()].sort((a, b) => b.issues - a.issues || a.name.localeCompare(b.name));
}
