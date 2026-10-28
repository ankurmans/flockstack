import { labelSource, rankSources } from "./labels.js";
import { cosine, titleWords, wordOverlap } from "./rank.js";
import { hostOf } from "./urls.js";

// Cluster (docs/BRIEFINGS-DESIGN.md, The run, 3): the candidates about one event become one story with several sources, so
// syndicated copies and the press release behind them count once. With the Workers AI binding the title and snippet of each are
// embedded with a multilingual model and candidates closer than SIMILARITY join; without it, ones sharing most title words do.
// Each source is labelled; the story's primary source is independent reporting when it has any, else the original document.
export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const SIMILARITY = 0.86;
export const WORD_OVERLAP = 0.5;
// The same gateway settings as lib/ai.js (which the engine's Worker doesn't load): logs and cache off.
export const GATEWAY = { id: "default", skipCache: true, collectLog: false };
const EMBED_BATCH = 50;

export function embeddingText(item) {
	return `${item.title}. ${String(item.excerpt ?? item.snippet ?? "").split(/(?<=[.!?])\s/)[0]}`.slice(0, 1000);
}

export async function embedTexts(ai, texts) {
	const vectors = [];
	for (let start = 0; start < texts.length; start += EMBED_BATCH) {
		const text = texts.slice(start, start + EMBED_BATCH);
		const result = await ai.run(EMBEDDING_MODEL, { text }, { gateway: GATEWAY });
		const data = result?.data ?? result?.response;
		if (!Array.isArray(data) || data.length !== text.length) throw new Error("The embedding model gave no vectors");
		vectors.push(...data);
	}
	return vectors;
}

function sourceOf(item) {
	const foundBy = [].concat(item.foundBy ?? []).filter(Boolean);
	return {
		url: item.url,
		title: item.title,
		host: hostOf(item.url),
		publisher: item.publisher || hostOf(item.url),
		sourceKind: labelSource(item.url),
		urlHash: item.urlHash,
		foundBy,
		publishedAt: item.publishedAt,
		excerpt: item.excerpt,
	};
}

// Stories from items: each item joins the first story whose first item is close enough, else starts one. vectors: one per item,
// or null.
export function clusterItems(items, vectors, { trustedOutlets = [] } = {}) {
	const groups = [];
	items.forEach((item, index) => {
		const words = titleWords(item.title);
		const home = groups.find((group) => (vectors ? cosine(vectors[group.lead], vectors[index]) > SIMILARITY : wordOverlap(group.words, words) >= WORD_OVERLAP));
		if (home) home.members.push({ item, index });
		else groups.push({ lead: index, words, members: [{ item, index }] });
	});
	return groups.map(({ members }, position) => {
		const sources = rankSources(members.map(({ item }) => sourceOf(item)), { trustedOutlets });
		const primary = sources[0];
		const dates = members.map(({ item }) => item.publishedAt).filter(Boolean).sort();
		return {
			id: `s${position + 1}`,
			key: primary.urlHash,
			title: primary.title,
			url: primary.url,
			snippet: sources.map(({ excerpt }) => excerpt).find(Boolean) ?? "",
			publishedAt: dates.at(-1) ?? null,
			sourceKind: primary.sourceKind,
			sources,
			foundBy: [...new Set(members.flatMap(({ item }) => [].concat(item.foundBy ?? [])).filter(Boolean))],
			vectorIndex: members[0].index,
		};
	});
}
