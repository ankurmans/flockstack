import { hostOf } from "./urls.js";

// Group (docs/BRIEFINGS-DESIGN.md, The run, 3): the items about one event become one story. With the Workers AI binding the
// title and first sentence of each item are embedded with a multilingual model and items closer than SIMILARITY join; without
// it, items that share most of their title's words do.
export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const SIMILARITY = 0.86;
export const WORD_OVERLAP = 0.5;
export const MAX_STORIES_FOR_TRIAGE = 60;
// The same gateway settings as lib/ai.js (which the engine's Worker doesn't load): logs and cache off.
export const GATEWAY = { id: "default", skipCache: true, collectLog: false };
const EMBED_BATCH = 50;
const STOP_WORDS = new Set("the a an and or of to in on for with at by from is are was were be has have had its it this that as after over new into about than will says said".split(" "));

function firstSentence(text) {
	return String(text ?? "").split(/(?<=[.!?])\s/)[0].slice(0, 300);
}

function publisherOf(item) {
	return item.publisher || hostOf(item.url);
}

export async function embedItems(ai, items) {
	const vectors = [];
	for (let start = 0; start < items.length; start += EMBED_BATCH) {
		const text = items.slice(start, start + EMBED_BATCH).map((item) => `${item.title}. ${firstSentence(item.excerpt)}`.slice(0, 1000));
		const result = await ai.run(EMBEDDING_MODEL, { text }, { gateway: GATEWAY });
		const data = result?.data ?? result?.response;
		if (!Array.isArray(data) || data.length !== text.length) throw new Error("The embedding model gave no vectors");
		vectors.push(...data);
	}
	return vectors;
}

export function cosine(a, b) {
	let dot = 0;
	let left = 0;
	let right = 0;
	for (let index = 0; index < a.length; index++) {
		dot += a[index] * b[index];
		left += a[index] * a[index];
		right += b[index] * b[index];
	}
	return left && right ? dot / Math.sqrt(left * right) : 0;
}

function titleWords(title) {
	return new Set(
		String(title ?? "")
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((word) => word.length > 2 && !STOP_WORDS.has(word))
	);
}

export function wordOverlap(a, b) {
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const word of a) if (b.has(word)) shared += 1;
	return shared / Math.min(a.size, b.size);
}

// Stories from items: each item joins the first story whose first item is close enough, else starts one. A story's address
// is its first item's, the one with the highest weight. sources: the publishers that carry it.
export function groupItems(items, vectors) {
	const ordered = items.map((item, index) => ({ item, index })).sort((a, b) => b.item.weight - a.item.weight);
	const groups = [];
	for (const entry of ordered) {
		const words = titleWords(entry.item.title);
		const home = groups.find((group) => (vectors ? cosine(vectors[group.lead.index], vectors[entry.index]) > SIMILARITY : wordOverlap(group.words, words) >= WORD_OVERLAP));
		if (home) home.members.push(entry.item);
		else groups.push({ lead: entry, words, members: [entry.item] });
	}
	return groups
		.map(({ members }, position) => {
			const lead = members[0];
			return {
				id: `s${position + 1}`,
				key: lead.urlHash,
				title: lead.title,
				url: lead.url,
				excerpt: lead.excerpt,
				publishedAt: lead.publishedAt,
				sourceCount: new Set(members.map(publisherOf)).size,
				sources: [...new Set(members.map(publisherOf))],
				items: members.map((member) => ({ title: member.title, url: member.url, publisher: publisherOf(member), urlHash: member.urlHash })),
				weight: members.reduce((total, member) => total + member.weight, 0),
			};
		})
		.sort((a, b) => b.weight - a.weight || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
		.slice(0, MAX_STORIES_FOR_TRIAGE)
		.map((story, position) => ({ ...story, id: `s${position + 1}` }));
}
