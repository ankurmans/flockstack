import { translatePrompt, writePrompt } from "./prompts.js";

// Write (docs/BRIEFINGS-DESIGN.md, The run, 6): one call from the records alone. The model cites records as [n]; code, not the
// model, turns each citation into a link to the record's original page, so every link in the issue is one a source gave.
const CITATION = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?!\()/g;

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
	return { subject: subject.slice(0, 200), previewText: previewText.slice(0, 300), markdown: lines.join("\n").trim() };
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

// The paragraphs of a draft that make a claim, each with the records it cites: not headings, rules or the origin labels code
// adds, and each bullet of a list on its own (the brief items).
export function draftParagraphs(markdown) {
	return String(markdown ?? "")
		.split(/\n\s*\n/)
		.flatMap((block) => (/^\s*[-*] /.test(block) ? block.split(/\n(?=\s*[-*] )/) : [block]))
		.map((block) => block.trim())
		.filter((block) => block && !/^#{1,6}\s/.test(block) && !/^(?:-{3,}|\*{3,})$/.test(block) && !/^\*[^*\n]+\*$/.test(block))
		.map((text, index) => ({ id: `c${index + 1}`, text, cites: citesOf(text) }));
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
	return draftParagraphs(markdown)
		.filter((paragraph) => paragraph.cites.includes(record.n))
		.map((paragraph) => paragraph.text)
		.join("\n\n");
}

// Translate (docs/BRIEFINGS-DESIGN.md, The run, 8; beta): one call per extra language from the checked draft. The citations stay
// as [n] through the translation, so code links them the same way.
export async function translateDraft({ draft, records, language, key, model, models }) {
	const { system, user, maxTokens } = translatePrompt({ markdown: draft.markdown, subject: draft.subject, previewText: draft.previewText, language: languageName(language) });
	const { text } = await models.text({ key, model, step: "translate", system, user, maxTokens, temperature: 0.2 });
	const translated = parseDraft(text);
	if (!translated.markdown) throw new Error(`The translation into ${languageName(language)} came back empty`);
	return { language, subject: translated.subject || draft.subject, previewText: translated.previewText || draft.previewText, markdown: linkCitations(translated.markdown, records), beta: true };
}
