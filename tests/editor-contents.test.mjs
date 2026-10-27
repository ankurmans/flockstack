import assert from "node:assert/strict";
import { test } from "node:test";
import { renderEmail } from "../lib/render-email.js";
import { renderIssueBody, getIssueContentHtml } from "../lib/archive-content.js";
import { cleanRichHtml } from "../lib/clean-html.js";
const html = '<div data-toc=""></div><h2>A &amp; B</h2><p>Visible.</p><div data-paywall=""></div><h2>PRIVATE_HEADING</h2><p>Paid.</p>';
const issue = { format: "rich", subject: "Issue", html };
test("contents use only visible headings, preserve escaped text and link to stable heading IDs", () => {
	const free = renderIssueBody(issue); assert.match(free.html, /href="#issue-heading-1"/); assert.match(free.html, /id="issue-heading-1"/); assert.doesNotMatch(free.html, /PRIVATE_HEADING/);
	const paid = renderIssueBody(issue, { isUnlocked: true }); assert.match(paid.html, /href="#issue-heading-2"/); assert.match(paid.html, /id="issue-heading-2"/); assert.match(paid.html, /A &amp; B/);
	const exported = getIssueContentHtml(issue, { isUnlocked: true }); assert.match(exported, /id="issue-heading-2"/);
});
test("email contents link all headings the selected reader receives and code remains literal text", () => {
	const email = (readerTier) => renderEmail({ ...issue, newsletter: { name: "Example" }, readerTier }).html;
	assert.doesNotMatch(email("free"), /PRIVATE_HEADING/); assert.match(email("paid"), /href="#issue-heading-2"/);
	const code = '<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>';
	assert.match(cleanRichHtml(code), /&lt;script&gt;/); assert.doesNotMatch(renderIssueBody({ ...issue, html: code }).html, /<script>/);
});
