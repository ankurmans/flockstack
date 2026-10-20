import { AUDIO_CHUNK_CHARS } from "./audio-config.js";
import { cleanRichHtml } from "./clean-html.js";
import { decodeEntities, splitAtPaywall } from "./editor-blocks.js";
import { markdownToHtml } from "./markdown.js";

// An issue as a voice should read it. The text is made once, when the audio version is created, and kept: the chunks sent
// to the voice are the ones counted against the quota.

const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+|<)/g;
const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link", "col", "wbr", "source", "area", "base", "embed", "param", "track"]);
const BLOCK_TAGS = new Set([
	"p", "div", "section", "article", "header", "footer", "aside", "main", "nav", "ul", "ol", "li", "dl", "dt", "dd", "blockquote",
	"figure", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th", "table", "thead", "tbody", "hr", "br", "details", "summary", "address",
]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
// Dropped with everything inside them, and what they were: silent ones leave no trace; the rest earn the "web version" note.
const DROPPED_TAGS = {
	script: null, style: null, head: null, noscript: null, template: null, svg: null, canvas: null, picture: null, button: null, select: null, form: null,
	iframe: "embed", video: "embed", audio: "embed", object: "embed", pre: "code",
};
const DROPPED_BLOCKS = [
	[/\sdata-embed\b/i, "embed"],
	[/\sdata-poll\b/i, "poll"],
	[/\sdata-file\b/i, "file"],
	[/\sdata-rss\b/i, "embed"],
	[/\sdata-button\b/i, null],
	[/\sdata-paywall\b/i, null],
	[/\sdata-preheader\b/i, null],
	[/\sdata-footnotes\b/i, null],
	[/\sdata-footnote-ref\b/i, null],
	[/\sstyle\s*=\s*["'][^"']*display\s*:\s*none/i, null],
];
const WEB_VERSION_NOTE = "Some parts of this issue, like tables and embedded content, are only in the web version.";
const PAYWALL_NOTE = "The rest of this issue is for paid subscribers.";
const SENTENCE_END = /[.!?…:;]["'”’)\]]*$/;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const MERGE_TAG = /\{\{[^}]*\}\}/g;
const SYMBOLS = /[\p{Extended_Pictographic}‍️←-⇿⬀-⯿]/gu;

const NAMED_ENTITIES = {
	mdash: " — ", ndash: "–", hellip: "…", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', bull: " ", middot: " ", copy: "©", reg: "®", trade: "", euro: "€",
	pound: "£", yen: "¥", cent: "¢", times: "×", rarr: " ", larr: " ", laquo: '"', raquo: '"', shy: "", thinsp: " ", ensp: " ", emsp: " ", zwnj: "", zwj: "",
};

function decodeNamed(text) {
	return text.replace(/&([a-z]{2,8});/gi, (all, name) => NAMED_ENTITIES[name.toLowerCase()] ?? all);
}

function dropRule(name, attributes, readTables) {
	if (name === "table" && !readTables) return { reason: "table" };
	if (Object.hasOwn(DROPPED_TAGS, name)) return { reason: DROPPED_TAGS[name] };
	for (const [pattern, reason] of DROPPED_BLOCKS) if (pattern.test(` ${attributes}`)) return { reason };
	return null;
}

// A link read aloud is the site it goes to: "example.com", not "h t t p s colon slash slash".
function speakUrls(text) {
	return text.replace(URL_PATTERN, (match) => {
		const trailing = /[.,;:!?)\]]+$/.exec(match)?.[0] ?? "";
		const address = trailing ? match.slice(0, -trailing.length) : match;
		try {
			return `${new URL(address).hostname.replace(/^www\./i, "")}${trailing}`;
		} catch {
			return trailing;
		}
	});
}

// What is left of a run of text once the voice's trouble spots are out: links, merge tags, pictures made of characters.
function speakable(raw) {
	const text = speakUrls(decodeEntities(decodeNamed(raw)).replaceAll(" ", " "))
		.replace(MERGE_TAG, " ")
		.replace(SYMBOLS, " ")
		.replace(/\s&\s/g, " and ")
		.replace(/[*_`#]{2,}/g, " ")
		.replace(/([!?.])\1{2,}/g, "$1")
		.replace(/\s+([,.;:!?])/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

function endSentence(text) {
	return SENTENCE_END.test(text) ? text : `${text}.`;
}

function toHtml(campaign) {
	if (campaign.format === "markdown") return { html: cleanRichHtml(markdownToHtml(campaign.markdown ?? "")), readTables: false };
	if (campaign.format === "html") return { html: String(campaign.html ?? ""), readTables: true };
	return { html: cleanRichHtml(campaign.html ?? ""), readTables: false };
}

// Walks the issue's HTML into paragraphs: headings and list items become sentences of their own, links read as their text,
// pictures, embeds, tables and code are left out, footnotes wait for the end. For the issue's web page everyone sees, pass
// includePaid false: what follows the writer's paywall break is cut, and a sentence says so.
export function prepareAudioText(campaign, { includePaid = false, title = campaign.subject } = {}) {
	const { html: source, readTables } = toHtml(campaign);
	const { before, after, hasBreak } = splitAtPaywall(source);
	const html = includePaid ? before + after : before;
	const paragraphs = [];
	const footnotes = [];
	const omitted = new Set();
	let current = "";
	let heading = false;
	let skip = null;
	let capture = null;

	function flush() {
		const text = speakable(current);
		if (text) paragraphs.push(endSentence(text));
		current = "";
		heading = false;
	}

	for (const match of html.matchAll(TOKEN)) {
		const [, slash, rawName, attributes = "", text] = match;
		if (text !== undefined) {
			if (skip) continue;
			if (capture) capture.text += text;
			else current += text;
			continue;
		}
		if (!rawName) continue;
		const name = rawName.toLowerCase();
		const isVoid = VOID_TAGS.has(name) || /\/\s*$/.test(attributes);
		if (skip) {
			if (isVoid) continue;
			skip.depth += slash ? -1 : 1;
			if (skip.depth === 0) skip = null;
			continue;
		}
		if (capture) {
			if (name === "sup") capture.depth += slash ? -1 : 1;
			if (capture.depth === 0) {
				const note = speakable(capture.text);
				if (note) footnotes.push(endSentence(note));
				capture = null;
			} else if (!slash || name !== "sup") capture.text += " ";
			continue;
		}
		if (slash) {
			if (HEADINGS.has(name)) heading = true;
			if (BLOCK_TAGS.has(name)) flush();
			continue;
		}
		if (name === "img") continue;
		const drop = dropRule(name, attributes, readTables);
		if (drop && !isVoid) {
			flush();
			if (drop.reason) omitted.add(drop.reason);
			skip = { depth: 1 };
			continue;
		}
		if (name === "sup" && /\sdata-footnote\b/i.test(` ${attributes}`) && !isVoid) {
			capture = { depth: 1, text: "" };
			continue;
		}
		if (name === "br") {
			flush();
			continue;
		}
		if (BLOCK_TAGS.has(name)) flush();
	}
	flush();

	const body = [];
	if (title) {
		const spoken = speakable(title);
		if (spoken) body.push(endSentence(spoken));
	}
	body.push(...paragraphs);
	if (footnotes.length > 0) body.push("Notes.", ...footnotes.map((note, index) => `Note ${index + 1}. ${note}`));
	const wasCut = hasBreak && !includePaid;
	if (wasCut) body.push(PAYWALL_NOTE);
	if (omitted.size > 0) body.push(WEB_VERSION_NOTE);
	return { paragraphs: body, omitted: [...omitted], footnotes: footnotes.length, paywallCut: wasCut, hasBody: paragraphs.length > 0 };
}

function splitClauses(sentence, max) {
	const parts = [];
	let current = "";
	for (const clause of sentence.split(/(?<=[,;:])\s+/)) {
		for (const piece of splitWords(clause, max)) {
			if (current && current.length + 1 + piece.length > max) {
				parts.push(current);
				current = piece;
			} else {
				current = current ? `${current} ${piece}` : piece;
			}
		}
	}
	if (current) parts.push(current);
	return parts;
}

function splitWords(text, max) {
	if (text.length <= max) return [text];
	const parts = [];
	let current = "";
	for (const word of text.split(" ")) {
		if (current && current.length + 1 + word.length > max) {
			parts.push(current);
			current = "";
		}
		// A word longer than a chunk is cut where it must be.
		for (let start = 0; start < word.length; start += max) {
			const piece = word.slice(start, start + max);
			current = current ? `${current} ${piece}` : piece;
			if (current.length >= max) {
				parts.push(current);
				current = "";
			}
		}
	}
	if (current) parts.push(current);
	return parts;
}

let segmenter;

// A paragraph longer than a chunk, as pieces that each end where a sentence does (or, for a sentence longer than a chunk,
// at a comma or a space).
function splitParagraph(paragraph, max) {
	segmenter ??= new Intl.Segmenter("en", { granularity: "sentence" });
	const pieces = [];
	let current = "";
	for (const { segment } of segmenter.segment(paragraph)) {
		const sentence = segment.trim();
		if (!sentence) continue;
		for (const part of sentence.length > max ? splitClauses(sentence, max) : [sentence]) {
			if (current && current.length + 1 + part.length > max) {
				pieces.push(current);
				current = part;
			} else {
				current = current ? `${current} ${part}` : part;
			}
		}
	}
	if (current) pieces.push(current);
	return pieces;
}

// The text in requests of up to `max` characters, cut only between paragraphs and sentences: a voice that is asked for a
// piece starting mid-sentence starts mid-sentence. Paragraphs in a chunk are separated by a blank line.
export function chunkParagraphs(paragraphs, max = AUDIO_CHUNK_CHARS) {
	const chunks = [];
	let current = "";
	for (const paragraph of paragraphs) {
		for (const piece of paragraph.length <= max ? [paragraph] : splitParagraph(paragraph, max)) {
			if (current && current.length + 2 + piece.length > max) {
				chunks.push(current);
				current = piece;
			} else {
				current = current ? `${current}\n\n${piece}` : piece;
			}
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

// What creating an audio version of this issue would do: the chunks the voice would read and the characters they count.
export function planAudio(campaign, { includePaid = false, maxChunk = AUDIO_CHUNK_CHARS } = {}) {
	const prepared = prepareAudioText(campaign, { includePaid });
	const chunks = chunkParagraphs(prepared.paragraphs, maxChunk);
	return { ...prepared, chunks, characters: chunks.reduce((total, chunk) => total + chunk.length, 0) };
}

// A voice reads about 150 words a minute, and a word with its space is about 5.5 characters.
const CHARS_PER_MINUTE = 825;

export function estimateMinutes(characters) {
	return Math.max(1, Math.round(characters / CHARS_PER_MINUTE));
}
