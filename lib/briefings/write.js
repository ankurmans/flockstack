import { writePrompt } from "./prompts.js";

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
	const { system, user, maxTokens } = writePrompt({ briefing, records, language: briefing.languages?.[0] ? languageName(briefing.languages[0]) : "English" });
	const { text } = await models.text({ key, model, step: "write", system, user, maxTokens, temperature: 0.4 });
	const draft = parseDraft(text);
	if (!draft.markdown) throw new Error("The write step gave an empty draft");
	return { ...draft, subject: draft.subject || records[0]?.title?.slice(0, 120) || briefing.name };
}

function languageName(code) {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
	} catch {
		return code;
	}
}

// The paragraphs of a draft that make a claim (not headings, not blank), each with the records it cites.
export function draftParagraphs(markdown) {
	return String(markdown ?? "")
		.split(/\n\s*\n/)
		.map((block) => block.trim())
		.filter((block) => block && !/^#{1,6}\s/.test(block) && !/^(?:-{3,}|\*{3,})$/.test(block))
		.map((text, index) => ({ id: `c${index + 1}`, text, cites: citesOf(text) }));
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
