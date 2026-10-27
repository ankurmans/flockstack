import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanRichHtml } from "../lib/clean-html.js";
import { renderEmail, hasContent } from "../lib/render-email.js";
import { renderIssueBody } from "../lib/archive-content.js";
import { expandHtmlSnippets, readHtmlSnippet } from "../lib/html-snippets.js";
const snippet = (source) => `<div data-html="${encodeURIComponent(source)}"></div>`;
test("HTML snippets preserve rich markup, remain source while editing and render safely in email and web", () => {
	const source = '<table><tr><td><strong>Snippet text</strong></td></tr></table><a href="https://example.com">Link</a><img src="https://example.com/image.png" alt="Picture">';
	const saved = snippet(source); assert.equal(cleanRichHtml(saved), saved); assert.equal(hasContent(saved), true);
	const issue = { format: "rich", html: `<p>Before</p>${saved}<p>After</p>` };
	const web = renderIssueBody(issue); const email = renderEmail(issue);
	for (const html of [web.html, email.html]) { assert.match(html, /<table/); assert.match(html, /Snippet text/); assert.match(html, /https:\/\/example.com/); assert.doesNotMatch(html, /data-html|%3C/); }
});
test("unsafe and nested snippet content cannot execute or create embedded editor access markers", () => {
	const source = '<script>alert(1)</script><form>FORM_SECRET</form><iframe src="https://example.com"></iframe><p onclick="alert(2)" style="position:fixed">Safe</p><a href="javascript:alert(3)">Click</a><img src="javascript:alert(4)" onerror="alert(5)"><div data-paywall></div>'+snippet('<p>NESTED_SECRET</p>');
	const expanded = expandHtmlSnippets(snippet(source)); assert.match(expanded, /Safe/); assert.doesNotMatch(expanded, /script|FORM_SECRET|iframe|onclick|style=|javascript|onerror|data-paywall|data-html|NESTED_SECRET/);
	const html = renderIssueBody({ format: "rich", html: snippet(source) }).html; assert.doesNotMatch(html, /alert\(|javascript|onclick|onerror|data-html/);
	for (const malformed of ['%', '%E0%A4%A', 'a'.repeat(20001)]) assert.equal(readHtmlSnippet(malformed), "");
});
test("a snippet below a paywall stays out of free emails, public pages and their contents list", () => {
	const issue = { format: "rich", html: '<div data-toc=""></div><h2>Public</h2><div data-paywall=""></div>'+snippet('<h2>SNIPPET_PRIVATE_HEADING</h2><p>SNIPPET_PRIVATE_TEXT</p>') };
	assert.doesNotMatch(renderEmail({ ...issue, readerTier: "free" }).html, /SNIPPET_PRIVATE/);
	assert.doesNotMatch(renderIssueBody(issue).html, /SNIPPET_PRIVATE/);
	assert.match(renderEmail({ ...issue, readerTier: "paid" }).html, /SNIPPET_PRIVATE_TEXT/);
	assert.match(renderIssueBody(issue, { isUnlocked: true }).html, /SNIPPET_PRIVATE_TEXT/);
});
