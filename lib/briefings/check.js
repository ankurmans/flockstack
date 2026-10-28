import { markdownToHtml } from "../markdown.js";
import { mapLimited } from "./fetch.js";
import { FILLER_PHRASES, QUOTE_WORDS, checkPrompt, claimTypeSafe } from "./prompts.js";
import { looseText, numbersIn, quotesIn, wordCount } from "./text.js";
import { draftParagraphs, groundsOf } from "./write.js";

// Check (docs/BRIEFINGS-DESIGN.md, The run, 7). Code first, then the check model (which must not be the writer) on each
// claim against the records it cites. Each check is pass, warning or blocker; a blocker is something a reader must not get
// as is, a warning something the owner should look at.
export const LENGTH = { minWords: 60, wordsPerStory: 220, wordsPerBrief: 45, extraWords: 120 };
export const NOUL = { blockerBelow: 0.3, warningBelow: 0.7 };

function plural(count, one, many = `${one}s`) {
	return `${count} ${count === 1 ? one : many}`;
}

function claimNumbers(text) {
	return numbersIn(
		String(text)
			.replace(/\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g, " ")
			.replace(/\]\([^)]*\)/g, "]")
			.replace(/^\s*\d+[.)]\s/gm, " ")
	);
}

// Every address the issue's HTML would open, href and src alike, from the same renderer the issue is sent with.
export function renderedLinks(markdown) {
	const html = markdownToHtml(String(markdown ?? ""));
	const found = [...html.matchAll(/\s(?:href|src|srcset|action|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map((match) => (match[1] ?? match[2] ?? match[3]).replaceAll("&amp;", "&"));
	return [...new Set(found)];
}

export const LINK_CONCURRENCY = 4;

// The draft's links, LINK_CONCURRENCY at a time, into states (url -> { state, reason }) while hasTime(): the check stage saves
// states and goes on at the next pass when time runs out. { done } when every link has an answer.
export async function checkLinks({ links, fetcher, states, hasTime }) {
	const pending = links.filter((url) => !states[url]);
	while (pending.length) {
		if (!hasTime()) return { done: false };
		const batch = pending.splice(0, LINK_CONCURRENCY);
		const results = await mapLimited(batch, LINK_CONCURRENCY, (url) => fetcher.checkLink(url));
		results.forEach((result, index) => {
			states[batch[index]] = { state: result.state, reason: result.reason ?? null };
		});
	}
	return { done: true };
}

// Title Case rather than sentence case: most of the longer words after the first start with a capital. Names are capitalised in
// sentence case too, so it takes three such words and more than 60 percent of them.
export function isTitleCase(subject) {
	const words = String(subject ?? "")
		.split(/\s+/)
		.slice(1)
		.map((word) => word.replace(/[^\p{L}]/gu, ""))
		.filter((word) => word.length >= 4 && word !== word.toUpperCase());
	const capitalised = words.filter((word) => /^\p{Lu}/u.test(word)).length;
	return capitalised >= 3 && capitalised / words.length > 0.6;
}

// The checks code can make. resolved: what this run already learned about addresses (url -> "ok" or a problem).
export async function codeChecks({ draft, linkedMarkdown, records, fetcher, resolved, linkStates = {} }) {
	const checks = [];
	const byNumber = new Map(records.map((record) => [record.n, record]));
	const paragraphs = draftParagraphs(draft.markdown);

	const uncited = paragraphs.filter((paragraph) => !paragraph.cites.length && !(paragraph.analysis && groundsOf(paragraph, paragraphs).length));
	const unknown = [...new Set(paragraphs.flatMap((paragraph) => paragraph.cites).filter((n) => !byNumber.has(n)))];
	if (unknown.length) checks.push({ id: "citations", status: "blocker", message: `The draft cites ${unknown.map((n) => `[${n}]`).join(", ")}, which no record has` });
	else if (uncited.length) checks.push({ id: "citations", status: "warning", message: `${plural(uncited.length, "paragraph")} cite no source` });
	else checks.push({ id: "citations", status: "pass", message: "Every paragraph cites its source" });

	const missing = [];
	for (const paragraph of paragraphs) {
		const allowed = new Set(groundsOf(paragraph, paragraphs).flatMap((n) => byNumber.get(n)?.pageNumbers ?? []));
		for (const number of claimNumbers(paragraph.text)) if (!allowed.has(number)) missing.push(number);
	}
	const headings = String(draft.markdown).split("\n").filter((line) => /^#{1,6}\s/.test(line));
	const anywhere = new Set(records.flatMap((record) => record.pageNumbers ?? []));
	for (const number of [...headings, draft.subject, draft.previewText].flatMap((line) => claimNumbers(line ?? ""))) if (!anywhere.has(number)) missing.push(number);
	if (missing.length) checks.push({ id: "numbers", status: "blocker", message: `Not found in the pages cited: ${[...new Set(missing)].slice(0, 10).join(", ")}` });
	else checks.push({ id: "numbers", status: "pass", message: "Every number is on a page it cites" });

	const unlinked = records.filter((record) => !linkedMarkdown.includes(`](${record.url})`));
	if (unlinked.length) checks.push({ id: "originals", status: "blocker", message: `No link to the original of ${unlinked.map((record) => `"${record.title}"`).join(", ")}` });
	else checks.push({ id: "originals", status: "pass", message: "Every story links to its original" });

	const unread = records.filter((record) => record.kind !== "brief" && !record.readOriginal);
	if (unread.length) checks.push({ id: "originals_read", status: "warning", message: `Written from the feed's summary, as the page couldn't be read: ${unread.map((record) => `"${record.title}"`).join(", ")}` });

	const known = new Set(records.flatMap((record) => [record.url, record.primaryUrl, ...(record.coverage ?? []).map(({ url }) => url), ...(record.sources ?? []).map(({ url }) => url)]).filter(Boolean));
	const links = renderedLinks(linkedMarkdown);
	const foreign = links.filter((url) => !known.has(url));
	if (foreign.length) checks.push({ id: "links_from_sources", status: "warning", message: `${plural(foreign.length, "link")} no source gave: ${foreign.slice(0, 3).join(", ")}` });
	const broken = [];
	const unsure = [];
	for (const url of links) {
		// A page robots.txt keeps FlockStack out of isn't opened again just to check it.
		const result = resolved[url] === "ok" ? { state: "ok" } : /robots\.txt/.test(resolved[url] ?? "") ? { state: "unsure", reason: "robots.txt asks FlockStack not to open it" } : (linkStates[url] ?? (await fetcher.checkLink(url)));
		resolved[url] = result.state === "ok" ? "ok" : result.reason;
		if (result.state === "broken") broken.push(`${url} (${result.reason})`);
		else if (result.state === "unsure") unsure.push(`${url} (${result.reason})`);
	}
	if (broken.length) checks.push({ id: "links", status: "blocker", message: `Broken: ${broken.slice(0, 5).join("; ")}` });
	else if (unsure.length) checks.push({ id: "links", status: "warning", message: `Couldn't be confirmed: ${unsure.slice(0, 5).join("; ")}` });
	else checks.push({ id: "links", status: "pass", message: `${plural(links.length, "link")} open` });

	const quotes = quotesIn(draft.markdown);
	const long = quotes.filter((quote) => wordCount(quote) > QUOTE_WORDS);
	const recordQuotes = records.flatMap((record) => (record.quotes ?? []).map(({ text }) => looseText(text)));
	const loose = quotes.filter((quote) => wordCount(quote) >= 4 && !recordQuotes.some((text) => text.includes(looseText(quote))));
	if (long.length) checks.push({ id: "quotes", status: "blocker", message: `${plural(long.length, "quote")} over ${QUOTE_WORDS} words` });
	else if (loose.length) checks.push({ id: "quotes", status: "warning", message: `${plural(loose.length, "quote")} not word for word from a source` });
	else checks.push({ id: "quotes", status: "pass", message: `Quotes are ${QUOTE_WORDS} words at most` });

	const lower = String(draft.markdown).toLowerCase();
	const filler = FILLER_PHRASES.filter((phrase) => lower.includes(phrase));
	if (filler.length) checks.push({ id: "filler", status: "warning", message: `Filler to rewrite: ${filler.map((phrase) => `"${phrase}"`).join(", ")}` });

	if (isTitleCase(draft.subject)) checks.push({ id: "subject_case", status: "warning", message: `The subject reads as title case, where sentence case was asked for: "${draft.subject}"` });

	const words = wordCount(draft.markdown);
	const full = records.filter((record) => record.kind !== "brief").length;
	const most = LENGTH.wordsPerStory * full + LENGTH.wordsPerBrief * (records.length - full) + LENGTH.extraWords;
	if (words < LENGTH.minWords || words > most) checks.push({ id: "length", status: "warning", message: `${words} words, where ${LENGTH.minWords} to ${most} was expected` });
	else checks.push({ id: "length", status: "pass", message: `${words} words` });
	return checks;
}

// The check model on each cited paragraph. TypeSafe: one Noul per claim. Others: one JSON call for every claim.
export async function claimChecks({ draft, records, key, model, models }) {
	const claims = draftParagraphs(draft.markdown).filter((paragraph) => paragraph.cites.length && !paragraph.analysis);
	if (!claims.length) return [{ id: "claims", status: "warning", message: "No cited claim to check" }];
	const byNumber = new Map(records.map((record) => [record.n, record]));
	const failures = [];
	if (key.provider === "typesafe") {
		for (const claim of claims) {
			const cited = claim.cites.map((n) => byNumber.get(n)).filter(Boolean);
			const { state, questions } = claimTypeSafe({ claim, records: cited });
			const { answers } = await models.typesafe({ key, model, step: "check", state, questions });
			const noul = Number(answers?.supported?.noul);
			const shown = claim.text.slice(0, 80);
			if (!Number.isFinite(noul) || noul < NOUL.blockerBelow) failures.push({ id: `claim:${claim.id}`, status: "blocker", message: `Not supported by its source: "${shown}"` });
			else if (noul < NOUL.warningBelow) failures.push({ id: `claim:${claim.id}`, status: "warning", message: `Only partly supported by its source: "${shown}"` });
		}
	} else {
		const { system, user, maxTokens } = checkPrompt({ claims, records });
		const { json } = await models.text({ key, model, step: "check", system, user, json: true, maxTokens, temperature: 0 });
		const verdicts = new Map((Array.isArray(json?.claims) ? json.claims : []).map((entry) => [String(entry?.id), entry]));
		for (const claim of claims) {
			const verdict = verdicts.get(claim.id)?.verdict;
			const shown = claim.text.slice(0, 80);
			if (verdict === "supported") continue;
			if (verdict === "contradicted") failures.push({ id: `claim:${claim.id}`, status: "blocker", message: `Contradicted by its source: "${shown}"` });
			else failures.push({ id: `claim:${claim.id}`, status: "warning", message: verdict === "unsupported" ? `Not found in its source: "${shown}"` : `The check gave no verdict on: "${shown}"` });
		}
	}
	return failures.length ? failures : [{ id: "claims", status: "pass", message: `${plural(claims.length, "claim")} match their sources` }];
}

