import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Find and replace for the editor: the matches are decorations on the document, never part of it, so nothing about them
// is saved. Matches stay inside one block (a paragraph, a heading, a table cell), whatever bold or links cut it into.
export const findKey = new PluginKey("findReplace");

const EMPTY = { query: "", caseSensitive: false, matches: [], index: 0 };

export function findMatches(doc, query, { caseSensitive = false } = {}) {
	if (!query) return [];
	const matches = [];
	doc.descendants((node, pos) => {
		if (!node.isTextblock) return true;
		let text = "";
		const positions = [];
		node.forEach((child, offset) => {
			const start = pos + 1 + offset;
			if (child.isText) {
				for (let at = 0; at < child.text.length; at++) positions.push(start + at);
				text += child.text;
			} else {
				// A line break or an image: something no search matches across.
				positions.push(start);
				text += "\n";
			}
		});
		const lowered = caseSensitive ? null : text.toLowerCase();
		// A few letters change length when lowercased, which would shift every position after them.
		const isShifted = lowered !== null && lowered.length !== text.length;
		const haystack = caseSensitive || isShifted ? text : lowered;
		const needle = caseSensitive || isShifted ? query : query.toLowerCase();
		for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) {
			matches.push({ from: positions[index], to: positions[index + needle.length - 1] + 1 });
		}
		return false;
	});
	return matches;
}

export function createFindPlugin() {
	return new Plugin({
		key: findKey,
		state: {
			init: () => EMPTY,
			apply(tr, value, _before, state) {
				const meta = tr.getMeta(findKey);
				if (!meta && !tr.docChanged) return value;
				const next = { ...value, ...meta };
				const matches = findMatches(state.doc, next.query, next);
				return { ...next, matches, index: matches.length === 0 ? 0 : Math.min(next.index, matches.length - 1) };
			},
		},
		props: {
			decorations(state) {
				const { matches, index } = findKey.getState(state);
				if (matches.length === 0) return DecorationSet.empty;
				return DecorationSet.create(
					state.doc,
					matches.map(({ from, to }, at) => Decoration.inline(from, to, { class: at === index ? "find-match find-match-current" : "find-match" }))
				);
			},
		},
	});
}

// The index of the match after `index` going down (or up), wrapping round.
export function stepIndex(count, index, direction) {
	if (count === 0) return 0;
	return (index + direction + count) % count;
}

function replaceRange(tr, { from, to }, replacement) {
	if (replacement) tr.insertText(replacement, from, to);
	else tr.delete(from, to);
}

// The steps behind the commands, on a transaction: each returns false when there is nothing to do.
export function stepFind(state, tr, direction) {
	const { matches, index } = findKey.getState(state);
	if (matches.length === 0) return false;
	tr.setMeta(findKey, { index: stepIndex(matches.length, index, direction) });
	return true;
}

export function replaceCurrentMatch(state, tr, replacement) {
	const { matches, index, query, caseSensitive } = findKey.getState(state);
	const match = matches[index];
	if (!match) return false;
	replaceRange(tr, match, replacement);
	// The next match is the first past the replacement, so a replacement holding the search can't stick.
	const rest = findMatches(tr.doc, query, { caseSensitive });
	const next = rest.findIndex(({ from }) => from >= match.from + replacement.length);
	tr.setMeta(findKey, { index: next === -1 ? 0 : next });
	return true;
}

export function replaceAllMatches(state, tr, replacement) {
	const { matches } = findKey.getState(state);
	if (matches.length === 0) return false;
	for (const match of matches.toReversed()) replaceRange(tr, match, replacement);
	tr.setMeta(findKey, { index: 0 });
	return true;
}

export const FindReplace = Extension.create({
	name: "findReplace",
	addProseMirrorPlugins() {
		return [createFindPlugin()];
	},
	addCommands() {
		return {
			// { query, caseSensitive }: the search, starting at its first match.
			setFind:
				(options) =>
				({ tr, dispatch }) => {
					if (dispatch) tr.setMeta(findKey, { index: 0, ...options });
					return true;
				},
			findStep:
				(direction) =>
				({ tr, state, dispatch }) =>
					dispatch ? stepFind(state, tr, direction) : findKey.getState(state).matches.length > 0,
			replaceCurrent:
				(replacement) =>
				({ tr, state, dispatch }) =>
					dispatch ? replaceCurrentMatch(state, tr, replacement) : findKey.getState(state).matches.length > 0,
			replaceAll:
				(replacement) =>
				({ tr, state, dispatch }) =>
					dispatch ? replaceAllMatches(state, tr, replacement) : findKey.getState(state).matches.length > 0,
		};
	},
});
