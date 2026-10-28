import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp, withEnv } from "./helpers/app.mjs";
import { SHARED_DOMAIN, callApi, createPublisher, importModels } from "./helpers/community.mjs";
import { readCookieOptions, runWithRequest } from "./stubs/next-headers.mjs";

// Subfolder hosting end to end (docs/MOUNT-PATH-DESIGN.md): the actions, proxy.js with and without the token for both shapes of
// upstream, the check through a stand-in for the owner's proxy, the redirect, email links and the reader's cookies. The owner's
// site is example.com, answered by the fetch stub below; nothing reaches the network.
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		...(await importModels()),
		proxy: (await import("../proxy.js")).proxy,
		mountCheck: await import("../app/api/mount-check/route.js"),
		archiveHosts: await import("../lib/archive-hosts.js"),
		mountRouting: await import("../lib/mount-routing.js"),
		archiveSeo: await import("../lib/archive-seo.js"),
	};
});

after(() => app?.stop());

const api = (user, method, path, body) => callApi(method, `/api/v1/newsletters/${user.slug}${path}`, { key: user.key, body });

function visit(url, headers = {}, init = {}) {
	const target = new URL(url);
	return m.proxy(new m.NextRequest(target, { ...init, headers: { host: target.host, ...headers } }));
}

// The request headers proxy.js hands the app, as Next.js passes them on.
function passedHeaders(response) {
	const names = response.headers.get("x-middleware-override-headers")?.split(",").filter(Boolean) ?? [];
	return new Headers(names.map((name) => [name, response.headers.get(`x-middleware-request-${name}`)]));
}

function rewrittenPath(response) {
	const rewrite = response.headers.get("x-middleware-rewrite");
	return rewrite ? new URL(rewrite).pathname : null;
}

// The app as a request reaches it: proxy.js, then the check's route when that is where it rewrote to.
async function throughApp(request) {
	const response = await m.proxy(request);
	const rewrite = response.headers.get("x-middleware-rewrite");
	if (rewrite && new URL(rewrite).pathname === "/api/mount-check") {
		return runWithRequest({}, () => m.mountCheck.GET(new m.NextRequest(new URL(rewrite), { headers: passedHeaders(response) })));
	}
	return response;
}

// The owner's reverse proxy on example.com: strips the prefix and forwards the rest to the upstream with the token, or does
// something else wrong on purpose.
function ownerSite({ prefix, upstream, token, answer }) {
	const asked = [];
	const fetchImpl = async (input, init = {}) => {
		const url = new URL(String(input?.url ?? input));
		asked.push(url.href);
		if (answer) return answer(url);
		if (url.host !== "example.com" || (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) return new Response("<p>Not found</p>", { status: 404, headers: { "content-type": "text/html" } });
		const target = new URL(`${upstream}${url.pathname.slice(prefix.length)}${url.search}`);
		const headers = new Headers(init.headers);
		headers.set("host", target.host);
		headers.set("x-forwarded-host", url.host);
		if (token) headers.set("x-flockstack-mount", token);
		return throughApp(new m.NextRequest(target, { headers }));
	};
	return { asked, fetchImpl };
}

async function withSite(site, run) {
	const previous = globalThis.fetch;
	globalThis.fetch = site.fetchImpl;
	try {
		return await run();
	} finally {
		globalThis.fetch = previous;
	}
}

async function mountedPublisher(name, { prefix = `/newsletter/${name}` } = {}) {
	const user = await createPublisher(m, `${name}@example.com`);
	const set = await api(user, "POST", "/mount", { url: `https://example.com${prefix}` });
	assert.equal(set.status, 200, JSON.stringify(set.body));
	return { user, prefix, token: set.body.token, set: set.body };
}

async function verify(user, prefix, token, upstream) {
	const site = ownerSite({ prefix, upstream: upstream ?? `https://${user.slug}.${SHARED_DOMAIN}`, token });
	const checked = await withSite(site, () => api(user, "POST", "/mount/check"));
	assert.equal(checked.status, 200, JSON.stringify(checked.body));
	return { checked: checked.body, site };
}

describe("set_newsletter_mount", () => {
	test("returns the token once, keeps only its hash, and leaves the website where it was until a check", async () => {
		const { user, token, set } = await mountedPublisher("mount-set");
		assert.match(token, /^fsm_[A-Za-z0-9_-]{43}$/);
		assert.deepEqual(set.mount, {
			url: "https://example.com/newsletter/mount-set",
			path: "/newsletter/mount-set",
			upstream: `https://mount-set.${SHARED_DOMAIN}`,
			verified: false,
			verifiedAt: null,
			previousTokenUntil: null,
		});
		const stored = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		assert.equal(stored.mount.url, "https://example.com/newsletter/mount-set");
		assert.notEqual(stored.mount.tokenHash, token);
		assert.ok(!JSON.stringify(stored).includes(token), "the token itself is never stored");
		const got = await callApi("GET", `/api/v1/newsletters/${user.slug}`, { key: user.key });
		assert.equal(got.body.mount.verified, false);
		assert.ok(!JSON.stringify(got.body).includes(stored.mount.tokenHash), "nor shown again");
		assert.equal(got.body.archiveUrl, `https://mount-set.${SHARED_DOMAIN}/`);
	});

	test("refuses an address that isn't https, public, on a path, or FlockStack's own, and a newsletter with its own subdomain", async () => {
		const user = await createPublisher(m, "mount-refuse@example.com");
		for (const url of ["http://example.com/news", "https://10.0.0.8/news", "https://localhost/news", "https://intranet.local/news", "https://example.com", "https://example.com/a?b=c", `https://www.${SHARED_DOMAIN}/news`]) {
			const answer = await api(user, "POST", "/mount", { url });
			assert.equal(answer.status, 400, `${url}: ${JSON.stringify(answer.body)}`);
			assert.equal(answer.body.error.code, "validation_failed");
		}
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { archiveHost: "news.example.org" } });
		const conflict = await api(user, "POST", "/mount", { url: "https://example.com/news" });
		assert.equal(conflict.status, 409);
		assert.match(conflict.body.error.message, /subdomain or a subfolder, not both/);
	});
});

describe("proxy.js, with the shared host as the upstream", () => {
	test("before the check: no redirect, and a request with the token is mounted with the app's headers set", async () => {
		const { user, token, prefix } = await mountedPublisher("mount-proxy");
		const host = `https://${user.slug}.${SHARED_DOMAIN}`;
		const plain = await visit(`${host}/p/${user.issue.archiveSlug}`);
		assert.equal(rewrittenPath(plain), `/archive/${user.slug}/p/${user.issue.archiveSlug}`);
		assert.equal(plain.headers.get("x-flockstack-mounted"), null);

		const mounted = await visit(`${host}/p/${user.issue.archiveSlug}`, { "x-flockstack-mount": token });
		assert.equal(rewrittenPath(mounted), `/archive/${user.slug}/p/${user.issue.archiveSlug}`);
		assert.equal(mounted.headers.get("x-flockstack-mounted"), prefix);
		assert.equal(mounted.headers.get("x-flockstack-mounted-slug"), user.slug);
		const passed = passedHeaders(mounted);
		assert.equal(passed.get("x-flockstack-mount-path"), prefix);
		assert.equal(passed.get("x-flockstack-mount-slug"), user.slug);
		assert.equal(passed.get("x-flockstack-mount-match"), "current");
		assert.equal(passed.get("x-flockstack-mount"), null, "the token goes no further");

		const unsubscribe = await visit(`${host}/unsubscribe?token=x`, { "x-flockstack-mount": token });
		assert.ok(unsubscribe.headers.get("x-middleware-next"));
		assert.equal(passedHeaders(unsubscribe).get("x-flockstack-mount-path"), prefix);
	});

	test("a wrong token is refused, and so is a request that brings the app's own headers", async () => {
		const { user } = await mountedPublisher("mount-wrong");
		const host = `https://${user.slug}.${SHARED_DOMAIN}`;
		const wrong = await visit(`${host}/`, { "x-flockstack-mount": `fsm_${"a".repeat(43)}` });
		assert.equal(wrong.status, 403);
		const check = await visit(`${host}/.well-known/flockstack-mount`, { "x-flockstack-mount": "nonsense" });
		assert.equal(check.status, 403);
		assert.deepEqual(await check.json(), { mounted: false, reason: "wrong_token" });
		const forged = await visit(`${host}/`, { "x-flockstack-mount-path": "/elsewhere" });
		assert.equal(forged.status, 400);
		const direct = await visit(`${host}/.well-known/flockstack-mount`);
		assert.deepEqual(await direct.json(), { mounted: false, reason: "missing_token" });
	});
});

describe("check_newsletter_mount", () => {
	test("gets FlockStack's signed answer through the owner's site, and then the pages, canonical links and feeds move there", async () => {
		const { user, token, prefix } = await mountedPublisher("mount-check");
		const answer = await throughApp(new m.NextRequest(`https://${user.slug}.${SHARED_DOMAIN}/.well-known/flockstack-mount?challenge=${"c".repeat(24)}`, { headers: { host: `${user.slug}.${SHARED_DOMAIN}`, "x-flockstack-mount": token } }));
		const body = await answer.json();
		assert.equal(answer.headers.get("cache-control"), "no-store");
		assert.deepEqual({ ...body, signature: typeof body.signature }, { mounted: true, newsletter: user.slug, path: prefix, token: "current", challenge: "c".repeat(24), signature: "string" });

		const { checked, site } = await verify(user, prefix, token);
		assert.equal(checked.verified, true);
		assert.equal(checked.token, "current");
		assert.equal(checked.problem, null);
		assert.equal(checked.mount.verified, true);
		assert.match(site.asked[0], new RegExp(`^https://example\\.com${prefix}/\\.well-known/flockstack-mount\\?challenge=[A-Za-z0-9_-]{24}$`));

		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const urls = m.archiveHosts.getArchiveUrls(newsletter);
		assert.equal(urls.siteIndex, `https://example.com${prefix}/`);
		assert.equal(urls.absolutePost("first"), `https://example.com${prefix}/p/first`);
		assert.equal(urls.feed, `https://example.com${prefix}/feed.xml`);
		const got = await callApi("GET", `/api/v1/newsletters/${user.slug}`, { key: user.key });
		assert.equal(got.body.archiveUrl, `https://example.com${prefix}/`);
		assert.equal(got.body.seoUrls.sitemap, `https://example.com${prefix}/sitemap.xml`);
		const { metadata } = m.archiveSeo.getIssueSeo(newsletter, { ...user.issue, archiveSlug: "first" });
		assert.equal(metadata.alternates.canonical, `https://example.com${prefix}/p/first`);
		assert.equal(metadata.openGraph.url, `https://example.com${prefix}/p/first`);
	});

	test("says what to fix: no header, a wrong token, a site that doesn't forward, and a redirect into a private network", async () => {
		const { user, prefix } = await mountedPublisher("mount-fix");
		const upstream = `https://${user.slug}.${SHARED_DOMAIN}`;
		const cases = [
			[ownerSite({ prefix, upstream }), /without the X-FlockStack-Mount header/],
			[ownerSite({ prefix, upstream, token: `fsm_${"b".repeat(43)}` }), /doesn't match/],
			[ownerSite({ prefix: "/elsewhere", upstream }), /answered 404 .* not FlockStack: forward/],
		];
		for (const [site, problem] of cases) {
			const checked = await withSite(site, () => api(user, "POST", "/mount/check"));
			assert.equal(checked.status, 200);
			assert.equal(checked.body.verified, false);
			assert.match(checked.body.problem, problem);
		}
		const redirecting = ownerSite({ answer: () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/admin" } }) });
		const refused = await withSite(redirecting, () => api(user, "POST", "/mount/check"));
		assert.match(refused.body.problem, /redirects to an address FlockStack can't ask/);
		assert.equal(redirecting.asked.length, 1, "the private address is never asked");
		const forged = ownerSite({ answer: (url) => Response.json({ mounted: true, newsletter: user.slug, path: prefix, token: "current", challenge: url.searchParams.get("challenge"), signature: "x".repeat(43) }) });
		assert.match((await withSite(forged, () => api(user, "POST", "/mount/check"))).body.problem, /another newsletter or another path/);
		const stored = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		assert.equal(stored.mount.verifiedAt, undefined);
	});
});

describe("once the subfolder is verified", () => {
	let user;
	let token;
	let prefix;
	let host;
	before(async () => {
		({ user, token, prefix } = await mountedPublisher("mount-live"));
		await verify(user, prefix, token);
		host = `https://${user.slug}.${SHARED_DOMAIN}`;
	});

	test("a page asked for at the upstream without the token is sent to the same page in the subfolder", async () => {
		for (const [path, location] of [
			["/", `https://example.com${prefix}/`],
			[`/p/${user.issue.archiveSlug}?ref=x`, `https://example.com${prefix}/p/${user.issue.archiveSlug}?ref=x`],
			["/issues", `https://example.com${prefix}/issues`],
			["/signin", `https://example.com${prefix}/signin`],
		]) {
			const response = await visit(`${host}${path}`);
			assert.equal(response.status, 301, path);
			assert.equal(response.headers.get("location"), location, path);
		}
		const head = await visit(`${host}/`, {}, { method: "HEAD" });
		assert.equal(head.status, 301);
		const looped = await visit(`${host}/`, { "x-forwarded-host": "example.com" });
		assert.equal(looped.status, 403, "the owner's proxy without its header gets no redirect back to itself");
	});

	test("with the token nothing is redirected", async () => {
		const response = await visit(`${host}/p/${user.issue.archiveSlug}`, { "x-flockstack-mount": token });
		assert.equal(response.status, 200);
		assert.equal(rewrittenPath(response), `/archive/${user.slug}/p/${user.issue.archiveSlug}`);
	});

	test("the links in emails, /api, /embed.js, the files and the check are never redirected", async () => {
		for (const path of ["/unsubscribe?token=x", "/confirm?token=x", "/o/abc", "/c/abc", "/reader/in?token=x", "/reader/signin?token=x", "/preferences?token=x", "/api/visit", "/api/views", "/embed.js", "/feed.xml", "/sitemap.xml", "/robots.txt", "/llms.txt", `/p/${user.issue.archiveSlug}.md`, "/.well-known/flockstack-mount"]) {
			const response = await visit(`${host}${path}`);
			assert.notEqual(response.status, 301, path);
		}
		const post = await visit(`${host}/p/${user.issue.archiveSlug}`, {}, { method: "POST" });
		assert.notEqual(post.status, 301, "only reads are redirected");
	});

	test("the links in emails stay on FlockStack's host: tracking, unsubscribe, comments and the web link's redirect", async () => {
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		assert.equal(m.archiveHosts.getLinkBaseUrl(newsletter), host);
		const campaign = { _id: user.issue._id, format: "html", subject: "Hello", html: '<html><body><p><a href="https://example.org/a">A link</a></p></body></html>', archiveSlug: user.issue.archiveSlug, status: "sent" };
		const contact = { _id: "6650f1c2e9b1d4a0123456ff", email: "reader@example.com", status: "active" };
		const { html, headers } = m.sendingRules.buildRecipientEmail({ campaign, newsletter, contact, messageId: "6650f1c2e9b1d4a0123456aa" });
		const links = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(([, url]) => url.replaceAll("&amp;", "&"));
		const ownLinks = links.filter((url) => /\/(unsubscribe|o|c|reader|preferences)\b/.test(new URL(url).pathname));
		assert.ok(ownLinks.length >= 2, links.join("\n"));
		for (const url of ownLinks) assert.equal(new URL(url).host, `${user.slug}.${SHARED_DOMAIN}`, url);
		assert.ok(links.every((url) => !url.startsWith("https://example.com/")), "nothing in the email points at the owner's proxy directly");
		for (const value of Object.values(headers ?? {})) assert.ok(!String(value).includes("example.com/newsletter"), String(value));
		const comment = m.links.getEmailCommentUrl({ contactId: contact._id, newsletterId: user.newsletterId }, newsletter, { issueSlug: user.issue.archiveSlug });
		assert.equal(new URL(comment).host, `${user.slug}.${SHARED_DOMAIN}`);
	});

	test("a reader's email link goes on to the subfolder, and the session's cookies are set under its path there", async () => {
		const reader = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "mounted-reader@example.org", status: "active" });
		const url = m.links.getEmailCommentUrl({ contactId: reader._id, newsletterId: user.newsletterId }, user.newsletter, { issueSlug: user.issue.archiveSlug });
		const jar = new Map();
		const handoff = await runWithRequest({ jar }, () => m.readerIn.GET(new m.NextRequest(url)));
		assert.equal(handoff.status, 303);
		assert.equal(handoff.headers.get("location"), `https://example.com${prefix}/reader/in${new URL(url).search}`);
		assert.equal(jar.size, 0, "no session on FlockStack's host, where the pages aren't");

		const signedIn = await runWithRequest({ jar, headers: { "x-flockstack-mount-path": prefix } }, () => m.readerIn.GET(new m.NextRequest(url)));
		assert.equal(signedIn.status, 303);
		assert.equal(new URL(signedIn.headers.get("location")).origin, "https://example.com");
		const name = `fs_reader_${user.slug}`;
		assert.ok(jar.has(name));
		const options = readCookieOptions(jar, name);
		assert.equal(options.path, prefix);
		assert.equal(options.domain, undefined, "host-only");
		assert.equal(options.sameSite, "lax");
		assert.equal(readCookieOptions(jar, `${name}_on`).path, prefix);
	});

	test("without a mount the reader's cookies stay at the root of the newsletter's host", async () => {
		const plain = await createPublisher(m, "mount-none@example.com");
		const reader = await m.Contact.create({ accountId: plain.accountId, newsletterId: plain.newsletterId, email: "plain-reader@example.org", status: "active" });
		const url = m.links.getEmailCommentUrl({ contactId: reader._id, newsletterId: plain.newsletterId }, plain.newsletter, { issueSlug: plain.issue.archiveSlug });
		const jar = new Map();
		const response = await runWithRequest({ jar }, () => m.readerIn.GET(new m.NextRequest(url)));
		assert.match(response.headers.get("location"), /#comments$/);
		assert.equal(readCookieOptions(jar, `fs_reader_${plain.slug}`).path, "/");
	});
});

describe("APP_URL/archive/<slug> as the upstream, on a server without a shared domain", () => {
	test("the mount works the same way: token, host-shaped paths, the check, the redirect and the URLs", async () => {
		const user = await createPublisher(m, "mount-app@example.com");
		await withEnv({ SHARED_DOMAIN: "" }, async () => {
			const prefix = "/newsletter/mount-app";
			const { body: set } = await api(user, "POST", "/mount", { url: `https://example.com${prefix}` });
			const { token } = set;
			const upstream = `http://localhost:3000/archive/${user.slug}`;
			assert.equal(set.mount.upstream, upstream);
			const base = `http://localhost:3000/archive/${user.slug}`;
			// worker-entry.mjs has dropped the trailing slash of /archive/<slug>/ by the time proxy.js sees it.
			const mounted = (path) => visit(path === "/" ? base : `${base}${path}`, { "x-flockstack-mount": token });

			assert.equal(rewrittenPath(await mounted("/")), `/archive/${user.slug}`);
			assert.equal(rewrittenPath(await mounted(`/p/${user.issue.archiveSlug}`)), `/archive/${user.slug}/p/${user.issue.archiveSlug}`);
			assert.equal(rewrittenPath(await mounted("/feed.xml")), `/archive/${user.slug}/feed`);
			assert.equal(rewrittenPath(await mounted("/sitemap.xml")), `/archive/${user.slug}/sitemap`);
			assert.equal(rewrittenPath(await mounted("/api/visit")), "/api/visit");
			assert.equal(rewrittenPath(await mounted("/unsubscribe")), "/unsubscribe");
			assert.equal(rewrittenPath(await mounted("/embed.js")), "/api/embed-script");
			const marked = await mounted("/issues");
			assert.equal(marked.headers.get("x-flockstack-mounted"), prefix);
			assert.equal(passedHeaders(marked).get("x-flockstack-mount-path"), prefix);
			assert.equal((await visit(base, { "x-flockstack-mount": `fsm_${"z".repeat(43)}` })).status, 403);
			assert.deepEqual(await (await visit(`${base}/.well-known/flockstack-mount`)).json(), { mounted: false, reason: "missing_token" });

			const before = await visit(`${base}/p/${user.issue.archiveSlug}`);
			assert.notEqual(before.status, 301, "nothing moves before the check");

			const { checked } = await verify(user, prefix, token, upstream);
			assert.equal(checked.verified, true, checked.problem);

			const page = await visit(`${base}/p/${user.issue.archiveSlug}`);
			assert.equal(page.status, 301);
			assert.equal(page.headers.get("location"), `https://example.com${prefix}/p/${user.issue.archiveSlug}`);
			assert.equal((await visit(base)).headers.get("location"), `https://example.com${prefix}/`);
			for (const path of ["/feed", "/sitemap", "/og"]) assert.notEqual((await visit(`${base}${path}`)).status, 301, path);
			assert.notEqual((await visit("http://localhost:3000/unsubscribe?token=x")).status, 301);

			const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
			const urls = m.archiveHosts.getArchiveUrls(newsletter);
			assert.equal(urls.feed, `https://example.com${prefix}/feed.xml`);
			assert.equal(urls.absoluteMarkdown("one"), `https://example.com${prefix}/p/one.md`);
			assert.equal(m.archiveHosts.getLinkBaseUrl(newsletter), "http://localhost:3000", "emails stay on the app's address");
		});
	});
});

describe("rotate_newsletter_mount_token and remove_newsletter_mount", () => {
	test("a new token works at once and the previous one for 24 hours, and the check says which one the proxy sends", async () => {
		const { user, token: first, prefix } = await mountedPublisher("mount-rotate");
		await verify(user, prefix, first);
		const rotated = await api(user, "POST", "/mount/rotate-token");
		assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
		const second = rotated.body.token;
		assert.notEqual(second, first);
		const until = Date.parse(rotated.body.previousTokenUntil);
		assert.ok(Math.abs(until - (Date.now() + 24 * 3_600_000)) < 60_000);
		assert.equal(rotated.body.mount.previousTokenUntil, rotated.body.previousTokenUntil);
		assert.equal(rotated.body.mount.verified, true, "the website stays where it is");

		const host = `https://${user.slug}.${SHARED_DOMAIN}`;
		assert.equal((await visit(`${host}/`, { "x-flockstack-mount": second })).status, 200);
		const old = await visit(`${host}/`, { "x-flockstack-mount": first });
		assert.equal(old.status, 200);
		assert.equal(passedHeaders(old).get("x-flockstack-mount-match"), "previous");
		const { checked } = await verify(user, prefix, first);
		assert.equal(checked.token, "previous");
		assert.match(checked.problem, /previous token/);

		// The day passing, here and in the minute each instance keeps a mount for.
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { "mount.previousUntil": new Date(Date.now() - 1000) } });
		m.mountRouting.forgetMount(user.slug);
		assert.equal((await visit(`${host}/`, { "x-flockstack-mount": first })).status, 403, "past its day the previous token is refused");
		assert.equal((await visit(`${host}/`, { "x-flockstack-mount": second })).status, 200);
	});

	test("removing puts the website back on the newsletter's own address and refuses the token", async () => {
		const { user, token, prefix } = await mountedPublisher("mount-remove");
		await verify(user, prefix, token);
		const removed = await api(user, "DELETE", "/mount");
		assert.equal(removed.status, 200);
		assert.deepEqual(removed.body, { removed: true });
		const host = `https://${user.slug}.${SHARED_DOMAIN}`;
		assert.equal((await visit(`${host}/`)).status, 200, "no redirect any more");
		assert.equal((await visit(`${host}/`, { "x-flockstack-mount": token })).status, 403);
		const got = await callApi("GET", `/api/v1/newsletters/${user.slug}`, { key: user.key });
		assert.equal(got.body.mount, null);
		assert.equal(got.body.archiveUrl, `${host}/`);
		assert.deepEqual((await api(user, "DELETE", "/mount")).body, { removed: false });
		assert.equal((await api(user, "POST", "/mount/check")).status, 404);
	});
});
