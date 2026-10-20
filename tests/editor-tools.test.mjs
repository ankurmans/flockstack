import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { createFindPlugin, findKey, findMatches, replaceAllMatches, replaceCurrentMatch, stepFind, stepIndex } from "../lib/editor-find.js";
import { WORDS_PER_MINUTE, countWords, formatReadTime, getReadMinutes, textFromHtml } from "../lib/read-time.js";

// The editor's word count and read time, and find and replace on a ProseMirror document (the plugin the editor loads).
const schema = new Schema({
	nodes: {
		doc: { content: "block+" },
		paragraph: { content: "inline*", group: "block" },
		heading: { content: "inline*", group: "block" },
		text: { group: "inline" },
		hardBreak: { inline: true, group: "inline" },
	},
	marks: { bold: {} },
});

function paragraph(...parts) {
	return schema.node(
		"paragraph",
		null,
		parts.map((part) => (typeof part === "string" ? schema.text(part) : schema.text(part.bold, [schema.mark("bold")])))
	);
}

function makeState(...blocks) {
	return EditorState.create({ schema, doc: schema.node("doc", null, blocks), plugins: [createFindPlugin()] });
}

function search(state, query, options = {}) {
	return state.apply(state.tr.setMeta(findKey, { index: 0, query, ...options }));
}

const text = (state) => state.doc.textBetween(0, state.doc.content.size, "|", "\n");

describe("word count and read time", () => {
	test("counts words the way a person does", () => {
		assert.equal(countWords("Hello, world! It's a well-known fact: 42 things."), 8);
		assert.equal(countWords("  \n "), 0);
		assert.equal(countWords("Café déjà vu"), 3);
		assert.equal(countWords("日本語 text"), 2);
		assert.equal(countWords(null), 0);
	});

	test("reads at 238 words a minute, one minute at least, nothing for no words", () => {
		assert.equal(getReadMinutes(0), 0);
		assert.equal(getReadMinutes(5), 1);
		assert.equal(getReadMinutes(WORDS_PER_MINUTE * 3), 3);
		assert.equal(formatReadTime(WORDS_PER_MINUTE * 3), "3 min read");
		assert.equal(formatReadTime(0), "");
	});

	test("reads an HTML email's words, not its head or tags", () => {
		const html = "<html><head><style>p { color: red }</style><title>Ignored</title></head><body><p>One &amp; two</p><script>var x = 1;</script><p>three&nbsp;four</p></body></html>";
		assert.equal(textFromHtml(html), "One & two three four");
		assert.equal(countWords(textFromHtml(html)), 4);
	});
});

describe("find", () => {
	test("finds every match in every block, ignoring case unless asked", () => {
		const state = makeState(paragraph("The cat sat. The CAT slept."), paragraph("A cat."));
		assert.equal(findMatches(state.doc, "cat").length, 3);
		assert.equal(findMatches(state.doc, "cat", { caseSensitive: true }).length, 2);
		assert.equal(findMatches(state.doc, "").length, 0);
		assert.equal(findMatches(state.doc, "dog").length, 0);
		for (const { from, to } of findMatches(state.doc, "cat")) assert.equal(state.doc.textBetween(from, to).toLowerCase(), "cat");
	});

	test("finds text a mark cuts in two, and doesn't match across blocks or line breaks", () => {
		const state = makeState(paragraph("ab", { bold: "cd" }, "ef"), paragraph("xx"), paragraph("yy"));
		const [match] = findMatches(state.doc, "bcde");
		assert.equal(state.doc.textBetween(match.from, match.to), "bcde");
		assert.equal(findMatches(state.doc, "xxyy").length, 0);
		const withBreak = EditorState.create({ schema, doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("one"), schema.node("hardBreak"), schema.text("two")])]) });
		assert.equal(findMatches(withBreak.doc, "onetwo").length, 0);
		assert.equal(findMatches(withBreak.doc, "two").length, 1);
	});

	test("doesn't overlap matches and keeps its place when the document changes", () => {
		const state = search(makeState(paragraph("aaaa")), "aa");
		assert.equal(findKey.getState(state).matches.length, 2);
		const edited = state.apply(state.tr.insertText("b", 1));
		assert.equal(findKey.getState(edited).matches.length, 2, "recounted against the new text");
	});

	test("steps through the matches and wraps round", () => {
		assert.equal(stepIndex(3, 2, 1), 0);
		assert.equal(stepIndex(3, 0, -1), 2);
		assert.equal(stepIndex(0, 0, 1), 0);
		let state = search(makeState(paragraph("a b a b a")), "a");
		assert.equal(findKey.getState(state).index, 0);
		const tr = state.tr;
		assert.equal(stepFind(state, tr, 1), true);
		state = state.apply(tr);
		assert.equal(findKey.getState(state).index, 1);
		const empty = search(makeState(paragraph("x")), "nothing");
		assert.equal(stepFind(empty, empty.tr, 1), false);
	});
});

describe("replace", () => {
	test("replaces the current match, then the next is current", () => {
		let state = search(makeState(paragraph("one two one two")), "one");
		const tr = state.tr;
		assert.equal(replaceCurrentMatch(state, tr, "1"), true);
		state = state.apply(tr);
		assert.equal(text(state), "1 two one two");
		assert.equal(findKey.getState(state).matches.length, 1);
		assert.equal(findKey.getState(state).index, 0);
	});

	test("moves past a replacement that holds the search, so it can't stick", () => {
		let state = search(makeState(paragraph("a a")), "a");
		let tr = state.tr;
		replaceCurrentMatch(state, tr, "aa");
		state = state.apply(tr);
		assert.equal(text(state), "aa a");
		const { matches, index } = findKey.getState(state);
		assert.equal(matches.length, 3);
		assert.equal(state.doc.textBetween(matches[index].from, matches[index].to), "a");
		assert.equal(matches[index].from, 4, "the original second a, not the first of the replacement");
		tr = state.tr;
		replaceCurrentMatch(state, tr, "aa");
		assert.equal(text(state.apply(tr)), "aa aa");
	});

	test("replaces all of them across blocks in one step, keeping the text's marks", () => {
		let state = search(makeState(paragraph("cat and ", { bold: "cat" }), paragraph("Cat")), "cat");
		const tr = state.tr;
		assert.equal(replaceAllMatches(state, tr, "dog"), true);
		state = state.apply(tr);
		assert.equal(text(state), "dog and dog|dog");
		assert.equal(findKey.getState(state).matches.length, 0);
		assert.equal(state.doc.firstChild.lastChild.marks.length, 1, "the bold text is still bold");
	});

	test("deletes matches when the replacement is empty, and does nothing without matches", () => {
		let state = search(makeState(paragraph("a-b-c")), "-");
		const tr = state.tr;
		replaceAllMatches(state, tr, "");
		state = state.apply(tr);
		assert.equal(text(state), "abc");
		assert.equal(replaceAllMatches(state, state.tr, "x"), false);
		assert.equal(replaceCurrentMatch(state, state.tr, "x"), false);
	});
});
