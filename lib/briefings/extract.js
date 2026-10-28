import { QUOTE_WORDS, extractPrompt } from "./prompts.js";
import { readablePage } from "./readable.js";
import { looseText, numbersIn, wordCount } from "./text.js";
import { canonicalUrl, hostOf } from "./urls.js";

// Extract (docs/BRIEFINGS-DESIGN.md, The run, 5): for each picked story the original page and at most one primary source it
// links to, reduced to readable text, become one record. Only the record and the page's numbers are kept for the steps after,
// never the page: the numbers are what the check compares the draft with.
const PRIMARY_HINT = /(?:^|\.)(?:sec\.gov|europa\.eu|gov\.uk|arxiv\.org|doi\.org|prnewswire\.com|businesswire\.com|globenewswire\.com)$|\.gov$|^(?:investors?|ir|newsroom|press)\./i;
const PRIMARY_PATH = /press[-_]?release|\/newsroom\/|\/filings?\/|\.pdf$|\/investor/i;

// The first link on the page to another site that looks like a filing, a release, a paper or an official page.
export function findPrimaryLink(page, originalUrl) {
	const home = hostOf(originalUrl);
	for (const link of page.links ?? []) {
		const host = hostOf(link.url);
		if (!host || host === home) continue;
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

function cleanList(value, limit = 12) {
	return (Array.isArray(value) ? value : [])
		.map((entry) => (typeof entry === "string" ? entry.trim() : entry))
		.filter(Boolean)
		.slice(0, limit);
}

// A record as the model wrote it, held to the pages: a number that isn't on a page, or a quote that isn't word for word on
// one or is longer than the cap, is left out.
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
	};
}

// One story's record. pages read here count against the run's fetches; a page that can't be read leaves the feed's summary.
export async function extractStory({ briefing, story, n, fetcher, key, model, models, resolved }) {
	const pages = [];
	let original;
	try {
		const page = await fetcher.get(story.url);
		original = readablePage(page.text, page.url);
		resolved[story.url] = "ok";
		pages.push({ url: story.url, text: original.text || story.excerpt });
	} catch (error) {
		pages.push({ url: story.url, text: story.excerpt || story.title });
		original = null;
		resolved[story.url] = `could not be read: ${String(error?.message ?? error).slice(0, 120)}`;
	}
	const primaryUrl = original ? findPrimaryLink(original, story.url) : null;
	if (primaryUrl) {
		try {
			const page = await fetcher.get(primaryUrl);
			pages.push({ url: primaryUrl, text: readablePage(page.text, page.url).text });
			resolved[primaryUrl] = "ok";
		} catch {
			// A primary source that won't open is only a missed bonus.
		}
	}
	const { system, user, maxTokens } = extractPrompt({ briefing, story, pages });
	const { json } = await models.text({ key, model, step: "extract", system, user, json: true, maxTokens, temperature: 0 });
	const pagesText = pages.map(({ text }) => text).join("\n");
	return {
		n,
		storyKey: story.key,
		urlHash: story.key,
		title: story.title,
		url: story.url,
		label: hostOf(story.url),
		primaryUrl: pages.length > 1 ? primaryUrl : null,
		readOriginal: Boolean(original),
		coverage: story.items.filter((item) => item.url !== story.url).map(({ url, title }) => ({ url, title })),
		...cleanRecord(json, { pagesText }),
		pageNumbers: [...new Set(numbersIn(pagesText))].slice(0, 2000),
	};
}
