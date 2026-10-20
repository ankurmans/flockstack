import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AUDIO_CHUNK_CHARS } from "../lib/audio-config.js";
import { chunkParagraphs, estimateMinutes, planAudio, prepareAudioText } from "../lib/audio-text.js";

// An issue as a voice should read it: what is read, what is left out, and the parts it is cut into.

const issue = (html, extra = {}) => ({ format: "rich", subject: "Issue 12: the long weekend", html, ...extra });

describe("preparing the text", () => {
	test("reads the title first, headings and list items as sentences, and a link as its words", () => {
		const { paragraphs } = prepareAudioText(
			issue(
				`<h2>Three things</h2><p>Read <a href="https://example.com/post">this post</a>, then call me</p><ul><li>First thing</li><li>Second thing.</li></ul><blockquote><p>A quote</p></blockquote>`
			)
		);
		assert.deepEqual(paragraphs, ["Issue 12: the long weekend.", "Three things.", "Read this post, then call me.", "First thing.", "Second thing.", "A quote."]);
	});

	test("says a web address as its site, and leaves out merge tags and emoji", () => {
		const { paragraphs } = prepareAudioText(
			issue(`<p>Go to https://www.example.com/a/b?x=1. Hi {{first_name|there}} \u{1F600} fish &amp; chips &mdash; 50% off, $1,200 total</p>`)
		);
		assert.equal(paragraphs[1], "Go to example.com. Hi fish and chips — 50% off, $1,200 total.");
	});

	test("puts footnotes at the end, under Notes", () => {
		const { paragraphs, footnotes } = prepareAudioText(
			issue(`<p>A claim<sup data-footnote="">Source: the 2025 survey</sup> and another<sup data-footnote="">Second note</sup>.</p><p>Closing words.</p>`)
		);
		assert.equal(footnotes, 2);
		assert.deepEqual(paragraphs.slice(1), ["A claim and another.", "Closing words.", "Notes.", "Note 1. Source: the 2025 survey.", "Note 2. Second note."]);
	});

	test("drops pictures silently, and tables, code, embeds, polls and files with a note about the web version", () => {
		const plain = prepareAudioText(issue(`<p>Hello.</p><img src="https://example.com/a.png" alt="A chart"><figure><img src="https://example.com/b.png"><figcaption>Caption words</figcaption></figure>`));
		assert.deepEqual(plain.paragraphs, ["Issue 12: the long weekend.", "Hello.", "Caption words."]);
		assert.deepEqual(plain.omitted, []);

		const heavy = prepareAudioText(
			issue(
				`<p>Before.</p><table><tr><td>cell one</td><td>cell two</td></tr></table><pre>npm install thing</pre><div data-embed="https://www.youtube.com/watch?v=dQw4w9WgXcQ"></div><div data-file="" data-size="10"><a href="https://example.com/f.pdf">report.pdf</a></div><div data-button=""><a href="https://example.com">Click here</a></div><p>After.</p>`
			)
		);
		const text = heavy.paragraphs.join(" ");
		assert.doesNotMatch(text, /cell one|npm install|report\.pdf|Click here/);
		assert.deepEqual(heavy.paragraphs.slice(1, 3), ["Before.", "After."]);
		assert.deepEqual(heavy.omitted.sort(), ["code", "embed", "file", "table"]);
		assert.equal(heavy.paragraphs.at(-1), "Some parts of this issue, like tables and embedded content, are only in the web version.");
	});

	test("reads columns in order and keeps inline code as words", () => {
		const { paragraphs } = prepareAudioText(issue(`<div data-columns=""><div data-column=""><p>Left side</p></div><div data-column=""><p>Run <code>npm test</code> now</p></div></div>`));
		assert.deepEqual(paragraphs.slice(1), ["Left side.", "Run npm test now."]);
	});

	test("excludes what follows a paywall break from the audio everyone hears, and says so", () => {
		const html = `<p>Free part.</p><div data-paywall=""></div><p>Secret paid part.</p>`;
		const free = prepareAudioText(issue(html));
		assert.equal(free.paywallCut, true);
		assert.doesNotMatch(free.paragraphs.join(" "), /Secret/);
		assert.equal(free.paragraphs.at(-1), "The rest of this issue is for paid subscribers.");

		const paid = prepareAudioText(issue(html), { includePaid: true });
		assert.equal(paid.paywallCut, false);
		assert.deepEqual(paid.paragraphs.slice(1), ["Free part.", "Secret paid part."]);
	});

	test("reads Markdown issues, and the text of an HTML issue's layout tables, not its styles", () => {
		const markdown = prepareAudioText({ format: "markdown", subject: "MD", markdown: "# Heading\n\nSome *words* with a [link](https://example.com).\n\n- one\n- two" });
		assert.deepEqual(markdown.paragraphs, ["MD.", "Heading.", "Some words with a link.", "one.", "two."]);

		const html = prepareAudioText({
			format: "html",
			subject: "Designed",
			html: `<html><head><style>p{color:red}</style><title>Ignore me</title></head><body><table><tr><td><h1>Welcome</h1><p>Body text here.</p></td></tr></table><script>alert(1)</script></body></html>`,
		});
		assert.deepEqual(html.paragraphs, ["Designed.", "Welcome.", "Body text here."]);
	});

	test("an issue with no text has no body to read", () => {
		const plan = planAudio(issue(`<img src="https://example.com/a.png">`));
		assert.equal(plan.hasBody, false);
	});
});

describe("cutting the text into parts", () => {
	test("never cuts inside a sentence: each part ends where a sentence does, and none is over the limit", () => {
		const sentence = "This is a sentence of a fair length that goes on for a while.";
		const paragraph = Array.from({ length: 120 }, (_, index) => `${sentence} ${index}.`).join(" ");
		const chunks = chunkParagraphs(["Title.", paragraph], 500);
		assert.ok(chunks.length > 10);
		for (const chunk of chunks) {
			assert.ok(chunk.length <= 500, `${chunk.length}`);
			assert.match(chunk, /[.!?]$/);
			assert.match(chunk, /^(Title\.|This is a sentence)/);
		}
		assert.equal(chunks.join(" ").replace(/\s+/g, " "), `Title. ${paragraph}`);
	});

	test("packs whole paragraphs together, separated by a blank line", () => {
		assert.deepEqual(chunkParagraphs(["One.", "Two.", "Three."], 100), ["One.\n\nTwo.\n\nThree."]);
		assert.deepEqual(chunkParagraphs(["Aaaa.", "Bbbb.", "Cccc."], 12), ["Aaaa.\n\nBbbb.", "Cccc."]);
	});

	test("cuts a sentence longer than a part at a comma, then at a space", () => {
		const long = `${"word, ".repeat(50)}end.`;
		const chunks = chunkParagraphs([long], 60);
		assert.ok(chunks.every((chunk) => chunk.length <= 60));
		assert.ok(chunks.slice(0, -1).every((chunk) => chunk.endsWith(",")));
		const noSpaces = chunkParagraphs([`${"x".repeat(150)}.`], 60);
		assert.ok(noSpaces.every((chunk) => chunk.length <= 60));
		assert.equal(noSpaces.join(""), `${"x".repeat(150)}.`);
	});

	test("does not split on an abbreviation's period", () => {
		const chunks = chunkParagraphs([`Mr. Smith went to Washington, D.C. on Tuesday. ${"Another sentence follows here. ".repeat(4)}`.trim()], 70);
		assert.ok(chunks[0].startsWith("Mr. Smith went"), chunks[0]);
		assert.ok(chunks.every((chunk) => chunk.length <= 70));
	});

	test("the plan counts the characters of the parts, which is what the voice is asked to read", () => {
		const plan = planAudio(issue(`${"<p>A sentence in a paragraph of this issue.</p>".repeat(200)}`));
		assert.ok(plan.chunks.length > 1);
		assert.ok(plan.chunks.every((chunk) => chunk.length <= AUDIO_CHUNK_CHARS));
		assert.equal(plan.characters, plan.chunks.reduce((total, chunk) => total + chunk.length, 0));
		assert.equal(estimateMinutes(plan.characters), Math.max(1, Math.round(plan.characters / 825)));
	});
});
