// What the editor does with the AI writing tools' answers (lib/ai-writing.js made them on the server), kept apart from the
// components so tests can read it.

// The text as the editor's content: one paragraph per blank-line-separated block.
export function textToContent(text) {
	return String(text ?? "")
		.split(/\n{2,}/)
		.map((block) => block.replace(/\n/g, " ").trim())
		.filter(Boolean)
		.map((block) => ({ type: "paragraph", content: [{ type: "text", text: block }] }));
}

// The text a selection holds, blocks apart by a blank line: what is sent, and what a suggestion replaces.
export function readSelection(doc, from, to) {
	return doc.textBetween(from, to, "\n\n", " ").trim();
}

// A suggestion replaces the selection only while the text under it is still what it was asked about.
export function canReplace(doc, { from, to, text }) {
	return to <= doc.content.size && readSelection(doc, from, to) === text;
}

// The subject line test card (components/CardAbTest.jsx) listens for subjects the writer sends it from a suggestion.
export const AB_SUBJECT_EVENT = "flockstack:ab-subject";

export function sendToAbTest(subject) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(AB_SUBJECT_EVENT, { detail: { subject } }));
}

// The test's subjects after adding one: the first empty place, else a new one, up to the test's limit. Null when it is full
// or the subject is already there.
export function addAbSubject(subjects, subject, maxSubjects) {
	const text = String(subject ?? "").trim();
	if (!text || subjects.some((variant) => variant.subject.trim().toLowerCase() === text.toLowerCase())) return null;
	const empty = subjects.findIndex((variant) => !variant.subject.trim());
	if (empty >= 0) return subjects.map((variant, index) => (index === empty ? { ...variant, subject: text } : variant));
	if (subjects.length >= maxSubjects) return null;
	return [...subjects, { subject: text, previewText: "" }];
}
