import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { form, startTestApp } from "./helpers/app.mjs";
import { addIssue, addReader, createPublisher, importModels, inBrowser, signInReader } from "./helpers/community.mjs";
import { revalidatedPaths } from "./stubs/next-cache.mjs";

let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		...(await importModels()),
		issuePage: (await import("../app/archive/[slug]/p/[post]/page.js")).default,
		proxy: (await import("../proxy.js")).proxy,
		Comment: (await import("../models/Comment.js")).default,
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
	};
});

after(() => app?.stop());

async function render(user, issue = user.issue) {
	const element = await m.issuePage({ params: Promise.resolve({ slug: user.slug, post: issue.archiveSlug }) });
	const pitch = { name: user.slug, slug: user.slug, signupFields: [] };
	return renderToStaticMarkup(createElement(m.ProviderSubscribe, { newsletter: pitch, readers: 0 }, element));
}

function post(user, visitor, fields, issue = user.issue) {
	return inBrowser(visitor, () => m.commentActions.submitComment(null, form({ newsletter: user.slug, p: issue.archiveSlug, ...fields })));
}

describe("the comments on an issue's page", () => {
	test("show an empty state and the email sign-in to a visitor, with a hidden field and labels", async () => {
		const user = await createPublisher(m, "page-empty@example.com");
		const html = await render(user);
		assert.match(html, /<section id="comments" aria-labelledby="comments-title"/);
		assert.match(html, /<h2 id="comments-title"[^>]*>Comments<\/h2>/);
		assert.match(html, /No comments yet\./);
		assert.match(html, /Join the discussion/);
		assert.match(html, /<label[^>]*>Your email<\/label>/);
		assert.match(html, /Email me a sign-in link/);
		assert.match(html, /tabindex="-1"[^>]*name="website"/, "the honeypot");
		assert.doesNotMatch(html, /type="password"/, "no password anywhere");
		assert.doesNotMatch(html, /<script[^>]*src=/, "no third-party scripts");
	});

	test("list the published comments with their authors' names, escaped, and never an email", async () => {
		const user = await createPublisher(m, "page-list-owner@example.com");
		const visitor = await signInReader(m, user, await addReader(m, user, "dana.reyes@example.org"));
		const posted = await post(user, visitor, { body: "<script>alert(1)</script> and <img src=x onerror=alert(2)>\nSee https://example.com/a and [a page](https://example.net/p) or [click](javascript:alert(3))", name: "Dana R" });
		assert.equal(posted.ok, true, JSON.stringify(posted));
		await post(user, visitor, { body: "A reply.", parent: posted.id });

		const html = await render(user);
		assert.match(html, /1 comment|2 comments/);
		assert.match(html, /Dana R/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "markup prints as text");
		assert.doesNotMatch(html, /<script>alert|<img src=x/);
		assert.match(html, /<a href="https:\/\/example\.com\/a" rel="nofollow ugc noopener noreferrer" target="_blank"/);
		assert.match(html, /<a href="https:\/\/example\.net\/p"[^>]*>a page<\/a>/);
		assert.doesNotMatch(html, /href="javascript:/);
		assert.match(html, /\[click\]\(javascript:alert\(3\)\)/, "a javascript link stays text");
		assert.match(html, /id="comment-[a-f0-9]{24}"/);
		assert.match(html, /<time dateTime="[^"]+/);
		assert.doesNotMatch(html, /example\.org|dana\.reyes|Dana Reyes/, "no email, and not the part before the @ either once a name was chosen");
		assert.match(html, /A reply\./);
	});

	test("leave out what isn't published, and its reason", async () => {
		const user = await createPublisher(m, "page-hidden-owner@example.com");
		const visitor = await signInReader(m, user, await addReader(m, user, "reader@example.org"));
		const bea = await signInReader(m, user, await addReader(m, user, "bea@example.org"));
		const shown = await post(user, visitor, { body: "Shown comment." });
		const hidden = await post(user, bea, { body: "Hidden comment." });
		await m.Comment.updateOne({ accountId: user.accountId, _id: hidden.id }, { $set: { status: "hidden", reason: "Private reason for the author" } });
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { "comments.moderation": "hold_all" } });
		await post(user, visitor, { body: "Held comment." });
		const html = await render(user);
		assert.match(html, /Shown comment\./);
		assert.doesNotMatch(html, /Hidden comment|Held comment|Private reason|reviews every comment/);
		assert.ok(shown.ok);
	});

	test("are absent when comments are off, for a closed issue, and on a teaser page", async () => {
		const off = await createPublisher(m, "page-off@example.com", { comments: { enabled: false } });
		assert.doesNotMatch(await render(off), /id="comments"/);
		const on = await createPublisher(m, "page-issue-off@example.com");
		const closed = await addIssue(m, on, { subject: "Closed", comments: "off" });
		assert.doesNotMatch(await render(on, closed), /id="comments"/);
		assert.match(await render(on), /id="comments"/);
		const paid = await addIssue(m, on, { subject: "For payers", audience: "paid", comments: "on" });
		const html = await render(on, paid);
		assert.doesNotMatch(html, /id="comments"|Join the discussion/);
		assert.match(html, /This issue is for paid subscribers/);
	});

	test("say when only paid subscribers can comment", async () => {
		const user = await createPublisher(m, "page-paid@example.com", { comments: { enabled: true, who: "paid" } });
		assert.match(await render(user), /only paid subscribers can comment/);
	});

	test("renew the cached page when a comment shows or goes", async () => {
		const user = await createPublisher(m, "page-renew@example.com");
		const visitor = await signInReader(m, user, await addReader(m, user, "reader@example.org"));
		const before = revalidatedPaths.length;
		const posted = await post(user, visitor, { body: "Hello." });
		assert.ok(revalidatedPaths.slice(before).some(([path]) => path === `/archive/${user.slug}/p/${user.issue.archiveSlug}`));
		const mid = revalidatedPaths.length;
		await inBrowser(visitor, () => m.commentActions.submitDelete(null, form({ newsletter: user.slug, p: user.issue.archiveSlug, comment: posted.id })));
		assert.ok(revalidatedPaths.slice(mid).some(([path]) => path === `/archive/${user.slug}/p/${user.issue.archiveSlug}`));
	});
});

describe("the reader's links on a newsletter's own host", () => {
	function visit(path, host) {
		return m.proxy(new m.NextRequest(new URL(path, `http://${host}`), { headers: { host } }));
	}

	test("open on the shared host, a verified host and the app's host without a session", async () => {
		const user = await createPublisher(m, "page-host@example.com");
		for (const path of ["/reader/in?token=x", "/reader/signin?token=x", "/reader/replies?token=x"]) {
			const shared = await visit(path, `${user.slug}.flockstackmail.com`);
			assert.ok(shared.headers.get("x-middleware-next"), `${path} on the newsletter's host`);
			const app = await visit(path, "localhost:3000");
			assert.ok(app.headers.get("x-middleware-next"), `${path} on the app's host`);
		}
		const other = await visit("/reader/else", `${user.slug}.flockstackmail.com`);
		assert.equal(other.status, 404);
	});
});
