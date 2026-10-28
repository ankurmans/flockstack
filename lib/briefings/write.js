import { translatePrompt, writePrompt } from "./prompts.js";

// Write (docs/BRIEFINGS-DESIGN.md, The run, 6): one call from the records alone. The model cites records as [n]; code, not the
// model, turns each citation into a link to the record's original page, so every link in the issue is one a source gave.
const CITATION = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\()/g;

// What a model wrote, with nothing in it that could link or load anything: raw HTML (tags, <autolinks>), Markdown links and
// images, reference-style links and their definitions, and bare addresses a renderer would turn into links. The only links in an
// issue are the ones code makes from citations.
export function sanitizeModelMarkdown(text) {
	return String(text ?? "")
		.replace(/^[ \t]*\[[^\]\n]+\]:[ \t]*\S+.*$/gm, "")
		.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
		.replace(/\[(?!\s*\d{1,2}(?:\s*,\s*\d{1,2})*\s*\])([^\]\n]+)\]\[[^\]\n]*\]/g, "$1")
		.replace(/<[^>\n]*>?/g, "")
		.replace(/\bhttps?:\/\/[^\s)\]]+/gi, "")
		.replace(/\bwww\.[^\s)\]]+/gi, "")
		.trim();
}

export function parseDraft(text) {
	const lines = String(text ?? "")
		.replace(/<think>[\s\S]*?<\/think>/g, "")
		.replace(/^```(?:markdown|md)?\s*$/gim, "")
		.trim()
		.split("\n");
	let subject = "";
	let previewText = "";
	while (lines.length && /^(subject|preview)\s*:/i.test(lines[0].trim())) {
		const [label, ...rest] = lines.shift().split(":");
		const value = rest.join(":").trim().replace(/^["*]+|["*]+$/g, "");
		if (/^subject/i.test(label.trim())) subject = value;
		else previewText = value;
	}
	// A subject and preview carry no en or em dashes, whatever the model wrote.
	const plain = (value) => sanitizeModelMarkdown(value).replace(/\s+/g, " ").replace(/\s*[\u2013\u2014]\s*/g, ", ").replace(/^, |, $/g, "");
	return { subject: plain(subject).slice(0, 200), previewText: plain(previewText).slice(0, 300), markdown: sanitizeModelMarkdown(lines.join("\n")) };
}

export async function writeDraft({ briefing, records, key, model, models }) {
	const { system, user, maxTokens } = writePrompt({ briefing, records, language: languageName(briefing.languages?.[0] ?? "en") });
	const { text } = await models.text({ key, model, step: "write", system, user, maxTokens, temperature: 0.4 });
	const draft = parseDraft(text);
	if (!draft.markdown) throw new Error("The write step gave an empty draft");
	return { ...draft, markdown: labelOrigins(draft.markdown, records), subject: draft.subject || records[0]?.title?.slice(0, 120) || briefing.name };
}

export function languageName(code) {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
	} catch {
		return code;
	}
}

// The paragraphs of a draft, each with the records it cites and the section (the heading) it sits under: not headings, rules or
// the origin labels code adds, and each bullet of a list on its own (the brief items). A heading on the line straight above its
// paragraph, with no blank line between, is split off rather than taking the paragraph with it. analysis: a "Why it matters" line,
// the writer's reading of the facts rather than a claim of its own.
const ANALYSIS = /^\W*why it matters\b/i;

export function draftParagraphs(markdown) {
	const paragraphs = [];
	let section = 0;
	for (const block of String(markdown ?? "").split(/\n\s*\n/)) {
		let rest = [];
		const flush = () => {
			const text = rest.join("\n").trim();
			rest = [];
			if (!text) return;
			for (const part of /^\s*[-*] /.test(text) ? text.split(/\n(?=\s*[-*] )/) : [text]) {
				const piece = part.trim();
				if (!piece || /^(?:-{3,}|\*{3,})$/.test(piece) || /^\*[^*\n]+\*$/.test(piece)) continue;
				paragraphs.push({ id: `c${paragraphs.length + 1}`, text: piece, cites: citesOf(piece), section, analysis: ANALYSIS.test(piece) });
			}
		};
		for (const line of block.split("\n")) {
			if (/^#{1,6}\s/.test(line.trim())) {
				flush();
				section += 1;
			} else rest.push(line);
		}
		flush();
	}
	return paragraphs;
}

// The records a paragraph rests on: its own citations, and for an analysis line those of the facts in its section.
export function groundsOf(paragraph, paragraphs) {
	if (paragraph.cites.length || !paragraph.analysis) return paragraph.cites;
	return [...new Set(paragraphs.filter((other) => other.section === paragraph.section && !other.analysis).flatMap((other) => other.cites))];
}

// A story whose every source is the original document says so in the issue, in code rather than by the model: "*Press release*"
// under a full story's heading, "*Announced by Acme:*" at the start of a brief item's line.
export function labelOrigins(markdown, records) {
	const lines = String(markdown ?? "").split("\n");
	const labelled = new Set();
	for (const record of records) {
		if (!record.origin) continue;
		const cites = (line) => citesOf(line).includes(record.n);
		if (record.kind === "brief") {
			const index = lines.findIndex((line) => /^\s*[-*] /.test(line) && cites(line));
			if (index !== -1) lines[index] = lines[index].replace(/^(\s*[-*] )/, `$1*${record.origin}:* `);
			continue;
		}
		const first = lines.findIndex((line) => !/^#{1,6}\s/.test(line) && cites(line));
		if (first === -1) continue;
		let heading = first;
		while (heading >= 0 && !/^#{1,6}\s/.test(lines[heading])) heading -= 1;
		if (heading < 0 || labelled.has(heading)) continue;
		labelled.add(heading);
		lines.splice(heading + 1, 0, "", `*${record.origin}*`);
	}
	return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function citesOf(text) {
	return [...new Set([...String(text).matchAll(CITATION)].flatMap((match) => match[1].split(",").map((value) => Number(value.trim()))))];
}

// [n] and [n, m] become links named after each record's site; a number with no record is dropped.
export function linkCitations(markdown, records) {
	const byNumber = new Map(records.map((record) => [record.n, record]));
	return String(markdown ?? "").replace(CITATION, (_, list) =>
		list
			.split(",")
			.map((value) => byNumber.get(Number(value.trim())))
			.filter(Boolean)
			.map((record) => `([${record.label || "source"}](${record.url}))`)
			.join(" ")
	);
}

// The section of the draft about one record: the paragraphs that cite it, under its heading when there is one.
export function sectionFor(markdown, record) {
	const paragraphs = draftParagraphs(markdown);
	return paragraphs
		.filter((paragraph) => groundsOf(paragraph, paragraphs).includes(record.n))
		.map((paragraph) => paragraph.text)
		.join("\n\n");
}

// Translate (docs/BRIEFINGS-DESIGN.md, The run, 8; beta): one call per extra language from the checked draft. The citations stay
// as [n] through the translation, so code links them the same way. One that comes back empty or cut off at its cap (a reasoning
// model can think through most of it and write only the subject) is asked again with twice the room, held to the translate
// step's share like any call; one that is still empty or cut off fails, as a translation with half an issue isn't one.
const TRANSLATE_TRIES = 2;

export async function translateDraft({ draft, records, language, key, model, models }) {
	const name = languageName(language);
	const prompt = translatePrompt({ markdown: draft.markdown, subject: draft.subject, previewText: draft.previewText, language: name });
	let room = prompt.maxTokens;
	for (let tries = 1; ; tries += 1) {
		const answer = await models.text({ key, model, step: "translate", system: prompt.system, user: prompt.user, maxTokens: room, temperature: 0.2 });
		const translated = parseDraft(answer.text);
		const cutOff = answer.finishReason === "length";
		if (translated.markdown && !cutOff) {
			return { language, subject: translated.subject || draft.subject, previewText: translated.previewText || draft.previewText, markdown: linkCitations(translated.markdown, records), beta: true };
		}
		room = Math.max(room, answer.maxTokens ?? room);
		if (tries >= TRANSLATE_TRIES) {
			if (!translated.markdown && cutOff) throw new Error(`The translation into ${name} came back empty ${tries} times: the model used all ${room} tokens it had before writing the issue`);
			if (cutOff) throw new Error(`The translation into ${name} was cut off at the model's ${room}-token limit ${tries} times`);
			throw new Error(`The translation into ${name} came back empty ${tries} times`);
		}
		room *= 2;
	}
}
