// What a comment's text is: plain text with paragraphs, line breaks and links. Pure, so the pages, the actions and the
// emails read it the same way.
export const MAX_COMMENT_CHARS = 4000;
export const MAX_COMMENT_LINKS = 3;

const HIDDEN_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const MARKDOWN_LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)/g;
const BARE_URL = /https?:\/\/[^\s<>()[\]]{1,500}/g;
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

// A link is an http(s) address with a host and no name or password in front of it (https://bank.example@evil.test).
function readLink(value) {
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
		return url.toString();
	} catch {
		return null;
	}
}

// A link's words that look like an address would pass for another site than the link goes to: show the link itself.
function showsAddress(text) {
	return /^(?:https?:\/\/|www\.)|[a-z0-9-]\.[a-z]{2,}(?:[/:?#]|$)/i.test(text.trim());
}

function splitLinks(line) {
	const found = [];
	for (const match of line.matchAll(MARKDOWN_LINK)) {
		found.push({ start: match.index, end: match.index + match[0].length, text: match[1], href: readLink(match[2]) });
	}
	for (const match of line.matchAll(BARE_URL)) {
		if (found.some((item) => match.index >= item.start && match.index < item.end)) continue;
		const url = match[0].replace(TRAILING_PUNCTUATION, "");
		found.push({ start: match.index, end: match.index + url.length, text: url, href: readLink(url) });
	}
	const parts = [];
	let last = 0;
	for (const item of found.sort((a, b) => a.start - b.start)) {
		if (!item.href) continue;
		if (item.start > last) parts.push({ type: "text", text: line.slice(last, item.start) });
		parts.push({ type: "link", href: item.href, text: showsAddress(item.text) ? item.href : item.text.trim() });
		last = item.end;
	}
	if (last < line.length) parts.push({ type: "text", text: line.slice(last) });
	return parts;
}

// A comment's text as paragraphs of parts: text, links and line breaks. Nothing in it is HTML, so a page shows each part
// as the text it is: markup a reader typed is printed, never run.
export function parseCommentBody(body) {
	return String(body ?? "")
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean)
		.map((paragraph) => paragraph.split("\n").flatMap((line, index) => [...(index > 0 ? [{ type: "br" }] : []), ...splitLinks(line)]));
}

export function countCommentLinks(body) {
	return parseCommentBody(body)
		.flat()
		.filter((part) => part.type === "link").length;
}

// { body } as it is kept, or { problem } for the writer: no control or invisible characters (which can hide or reorder
// text), paragraphs and links as the parser reads them.
export function cleanCommentBody(value) {
	const body = String(value ?? "")
		.normalize("NFC")
		.replace(/\r\n?/g, "\n")
		.replace(HIDDEN_CHARACTERS, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (!body) return { problem: "Write a comment first." };
	if (body.length > MAX_COMMENT_CHARS) return { problem: `A comment can have up to ${MAX_COMMENT_CHARS.toLocaleString("en-US")} characters.` };
	if (countCommentLinks(body) > MAX_COMMENT_LINKS) return { problem: `A comment can have up to ${MAX_COMMENT_LINKS} links.` };
	return { body };
}

// The same words typed twice with other spacing or capitals count as one comment.
export function normalizeForCompare(body) {
	return String(body ?? "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

// One line of a comment for an email to its owner: the first words, on one line.
export function toSnippet(body, length = 140) {
	const text = String(body ?? "").replace(/\s+/g, " ").trim();
	return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}
