import { SOURCE_KINDS } from "../briefing-rules.js";
import { labelSource, originLabel } from "./labels.js";
import { QUOTE_WORDS, extractPrompt, oneLinerExtractPrompt } from "./prompts.js";
import { ProviderError } from "./providers.js";
import { readablePage } from "./readable.js";
import { looseText, numbersIn, wordCount } from "./text.js";
import { canonicalUrl, hostOf } from "./urls.js";

// Extract (docs/BRIEFINGS-DESIGN.md, The run, 5). For each full story the first of its sources that a public fetch can read
// (independent reporting first), plus at most one original document that page links to, become one record. A source that
// refuses us (401, 403, 429, robots.txt, a blocked host) is never tried another way: the next source of the cluster may be read
// instead (another outlet's report, a wire or newsroom copy of a release), and a story none of whose sources can be read is
// dropped. Only the record and the pages' numbers are kept for the steps after, never a page.
export const MIN_READABLE_CHARS = 400;
const PRIMARY_HINT = /(?:^|\.)(?:sec\.gov|europa\.eu|gov\.uk|arxiv\.org|doi\.org|prnewswire\.com|businesswire\.com|globenewswire\.com)$|\.gov$|^(?:investors?|ir|newsroom|press)\./i;
const PRIMARY_PATH = /press[-_]?release|\/newsroom\/|\/filings?\/|\.pdf$|\/investor/i;

// The first link on the page to another site that looks like a filing, a release, a paper or an official page.
export function findPrimaryLink(page, originalUrl, isBlocked = () => false) {
	const home = hostOf(originalUrl);
	for (const link of page.links ?? []) {
		const host = hostOf(link.url);
		if (!host || host === home || isBlocked(link.url)) continue;
		let pathname = "";
		try {
			pathname = new URL(link.url).pathname;
		} catch {
			continue;
		}
		if (PRIMARY_HINT.test(host) || PRIMARY_PATH.test(pathname)) return canonicalUrl(link.url);
	}
	return null;
}

// A company's name as the issue prints it ("Announced by …"): words only, nothing Markdown or HTML could read as markup or a link.
export function cleanCompany(value) {
	return String(value ?? "")
		.replace(/<[^>]*>?/g, " ")
		.replace(/\([^)]*\)/g, " ")
		.replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, " ")
		.replace(/[[\]*_`~#|<>!\\(){}]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 60);
}

function cleanList(value, limit = 12) {
	return (Array.isArray(value) ? value : [])
		.map((entry) => (typeof entry === "string" ? entry.trim() : entry))
		.filter(Boolean)
		.slice(0, limit);
}

// A record as the model wrote it, held to the pages: a number that isn't on a page, or a quote that isn't word for word on one or
// is longer than the cap, is left out.
export function cleanRecord(raw, { pagesText }) {
	const pageNumbers = new Set(numbersIn(pagesText));
	const page = looseText(pagesText);
	const numbers = cleanList(raw?.numbers, 20)
		.map((entry) => ({ value: String(entry?.value ?? "").slice(0, 60), sentence: String(entry?.sentence ?? "").slice(0, 400) }))
		.filter(({ value }) => value && numbersIn(value).length && numbersIn(value).every((number) => pageNumbers.has(number)));
	const quotes = cleanList(raw?.quotes, 6)
		.map((entry) => ({ text: String(entry?.text ?? "").replace(/^["“]|["”]$/g, "").trim(), speaker: String(entry?.speaker ?? "").slice(0, 120) }))
		.filter(({ text }) => text && wordCount(text) <= QUOTE_WORDS && page.includes(looseText(text)));
	return {
		what: String(raw?.what ?? "").slice(0, 600),
		who: cleanList(raw?.who, 10).map((entry) => String(entry).slice(0, 120)),
		when: String(raw?.when ?? "").slice(0, 60),
		facts: cleanList(raw?.facts, 12).map((entry) => String(entry).slice(0, 300)),
		numbers,
		quotes,
		modelKind: SOURCE_KINDS.includes(raw?.sourceKind) ? raw.sourceKind : null,
		company: cleanCompany(raw?.company),
	};
}

// The first source of the story that can be read as text: { source, page } or { problems } when none can.
// providerFetch(url) -> { text, title, links, finalUrl } | null: the search provider's fetch, for a page our own fetch got but
// couldn't read as text (a script-built page). It is never asked for a page that refused us.
export async function readStory({ story, fetcher, providerFetch, resolved }) {
	const problems = [];
	for (const source of story.sources) {
		if (source.sourceKind === "community" && story.sources.some(({ sourceKind }) => sourceKind !== "community")) continue;
		try {
			const fetched = await fetcher.get(source.url);
			let page = readablePage(fetched.text, fetched.url);
			resolved[source.url] = "ok";
			if (page.text.length < MIN_READABLE_CHARS && providerFetch) {
				const copy = await providerFetch(source.url);
				if (copy?.text && copy.text.length > page.text.length) page = { ...page, text: copy.text.slice(0, 20_000), links: copy.links?.length ? copy.links.map((url) => ({ url, text: "" })) : page.links };
			}
			if (page.text.length >= 80) return { source, page };
			problems.push(`${source.url}: no readable text`);
		} catch (error) {
			resolved[source.url] = `could not be read: ${String(error?.message ?? error).slice(0, 120)}`;
			problems.push(`${source.url}: ${String(error?.message ?? error).slice(0, 120)}`);
		}
	}
	return { problems };
}

// One full story's record, or null when none of its sources can be read.
// since: the start of the lookback; a page whose own date is before it is old news, whatever discovery said.
export async function extractStory({ briefing, story, n, since, fetcher, providerFetch, key, model, models, resolved, sectionId }) {
	const read = await readStory({ story, fetcher, providerFetch, resolved });
	if (!read.source) return { dropped: { storyKey: story.key, title: story.title, problems: read.problems } };
	const { source, page } = read;
	if (since && page.publishedAt && new Date(page.publishedAt) < new Date(since)) return { stale: { storyKey: story.key, title: story.title, publishedAt: page.publishedAt } };
	const pages = [{ url: source.url, text: page.text }];
	const primaryUrl = findPrimaryLink(page, source.url, fetcher.isBlocked);
	if (primaryUrl) {
		try {
			const fetched = await fetcher.get(primaryUrl);
			pages.push({ url: primaryUrl, text: readablePage(fetched.text, fetched.url).text });
			resolved[primaryUrl] = "ok";
		} catch {
			// An original document that won't open is only a missed bonus.
		}
	}
	const { system, user, maxTokens } = extractPrompt({ briefing, story, pages });
	const { json } = await models.text({ key, model, step: "extract", sectionId, system, user, json: true, maxTokens, temperature: 0 });
	if (!json || typeof json !== "object" || Array.isArray(json) || typeof json.what !== "string" || !json.what.trim()) {
		throw new ProviderError(`${key.provider}'s extract answer couldn't be read as a record`, { provider: key.provider, code: "unreadable" });
	}
	const pagesText = pages.map(({ text }) => text).join("\n");
	const { modelKind, company, ...record } = cleanRecord(json, { pagesText });
	const sourceKind = source.sourceKind ?? modelKind ?? "reporting";
	const sources = story.sources.map((each) => (each.url === source.url ? { ...each, sourceKind } : each));
	return {
		record: {
			n,
			kind: "full",
			storyKey: story.key,
			urlHash: source.urlHash ?? story.key,
			title: story.title,
			url: source.url,
			label: hostOf(source.url),
			primaryUrl: pages.length > 1 ? primaryUrl : null,
			primaryKind: pages.length > 1 ? labelSource(primaryUrl) : null,
			sourceKind,
			company,
			origin: originLabel(sources, company),
			sources: sources.map(({ url, publisher, sourceKind: kind }) => ({ url, publisher, sourceKind: kind })),
			readOriginal: true,
			coverage: sources.filter(({ url }) => url !== source.url).map(({ url, title }) => ({ url, title })),
			...record,
			pageNumbers: [...new Set(numbersIn(pagesText))].slice(0, 2000),
		},
		// Beside the record, not in it: the record is what the issue is written from.
		previewImage: page.image ?? null,
	};
}

// A brief item's record: a line from the title and the snippet discovery gave, with its link. No page is read for it.
export function briefRecord(story, n) {
	const what = story.snippet || story.title;
	return {
		n,
		kind: "brief",
		storyKey: story.key,
		urlHash: story.key,
		title: story.title,
		url: story.url,
		label: hostOf(story.url),
		primaryUrl: null,
		sourceKind: story.sourceKind ?? "other",
		origin: originLabel(story.sources, ""),
		sources: story.sources.map(({ url, publisher, sourceKind }) => ({ url, publisher, sourceKind })),
		readOriginal: false,
		coverage: story.sources.filter(({ url }) => url !== story.url).map(({ url, title }) => ({ url, title })),
		what,
		who: [],
		when: "",
		facts: [],
		numbers: [],
		quotes: [],
		pageNumbers: [...new Set(numbersIn(`${story.title}\n${what}`))],
	};
}

// A one-line item's record (a sectioned briefing's one-liners section): the page read as for a full story, then a short record
// of its names, what happened and its figure. The figure must be on the page, as a full story's numbers must.
export async function extractOneLiner({ story, n, since, fetcher, providerFetch, key, model, models, resolved, sectionId }) {
	const read = await readStory({ story, fetcher, providerFetch, resolved });
	if (!read.source) return { dropped: { storyKey: story.key, title: story.title, problems: read.problems } };
	const { source, page } = read;
	if (since && page.publishedAt && new Date(page.publishedAt) < new Date(since)) return { stale: { storyKey: story.key, title: story.title, publishedAt: page.publishedAt } };
	const { system, user, maxTokens } = oneLinerExtractPrompt({ story, page: { url: source.url, text: page.text } });
	const { json } = await models.text({ key, model, step: "extract", sectionId, system, user, json: true, maxTokens, temperature: 0 });
	if (!json || typeof json !== "object" || Array.isArray(json) || typeof json.what !== "string" || !json.what.trim()) {
		throw new ProviderError(`${key.provider}'s extract answer couldn't be read as a record`, { provider: key.provider, code: "unreadable" });
	}
	const pageNumbers = new Set(numbersIn(page.text));
	const figure = json.figure && typeof json.figure === "object" ? { value: String(json.figure.value ?? "").slice(0, 60), sentence: String(json.figure.sentence ?? "").slice(0, 400) } : null;
	const numbers = figure?.value && numbersIn(figure.value).length && numbersIn(figure.value).every((number) => pageNumbers.has(number)) ? [figure] : [];
	const entities = cleanList(json.entities, 4).map(cleanCompany).filter(Boolean);
	const sourceKind = source.sourceKind ?? "reporting";
	const sources = story.sources.map((each) => (each.url === source.url ? { ...each, sourceKind } : each));
	return {
		record: {
			n,
			kind: "brief",
			format: "one-liners",
			storyKey: story.key,
			urlHash: source.urlHash ?? story.key,
			title: story.title,
			url: source.url,
			label: hostOf(source.url),
			primaryUrl: null,
			sourceKind,
			company: entities[0] ?? "",
			origin: originLabel(sources, entities[0] ?? ""),
			sources: sources.map(({ url, publisher, sourceKind: kind }) => ({ url, publisher, sourceKind: kind })),
			readOriginal: true,
			coverage: sources.filter(({ url }) => url !== source.url).map(({ url, title }) => ({ url, title })),
			entities,
			what: String(json.what).slice(0, 300),
			who: entities,
			when: String(json.date ?? "").slice(0, 60),
			facts: [],
			numbers,
			quotes: [],
			pageNumbers: [...pageNumbers].slice(0, 2000),
		},
		previewImage: page.image ?? null,
	};
}
