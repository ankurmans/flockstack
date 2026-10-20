import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { activate, anonymous, as, callApi, catchRedirect, form, platformEmails, signIn, startTestApp } from "./helpers/app.mjs";
import { sent, state } from "./stubs/ses.mjs";
import { dnsRecords } from "./stubs/dns-broker.mjs";

// FlockStack Cloud shares its own domain: the dashboard on flockstack.io, FlockStack's subdomains next to it (www, r,
// cdn...), and each newsletter's archive and shared address on <slug>.flockstack.io, the same site.
const APP_URL = "https://flockstack.io";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
let app;
let m;
let nextId = 0;

function visit(url) {
	return m.proxy(new m.NextRequest(url, { headers: { host: new URL(url).host } }));
}

// What the proxy decided: render the page asked for, render another one in its place, or answer itself.
function outcome(response) {
	const rewrite = response.headers.get("x-middleware-rewrite");
	if (rewrite) return { rewrite: new URL(rewrite).pathname };
	if (response.headers.get("x-middleware-next")) return { next: true };
	return { status: response.status };
}

async function callTool(key, name, args) {
	const request = new Request(`${APP_URL}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
			authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name, arguments: args }, id: ++nextId }),
	});
	const text = await (await anonymous(() => m.mcpRoute.POST(request))).text();
	return JSON.parse(text.split("\n").find((line) => line.startsWith("data: ")).slice(6)).result;
}

async function customer(email, slug) {
	const user = await signIn(email);
	await activate(user);
	const url = await as(user, () =>
		catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St, Paris", archiveEnabled: "on" })))
	);
	user.newsletterId = url.split("/").at(-1);
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	return user;
}

async function draft(user) {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
	const id = url.split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "This week", body: '<p>Hello <a href="https://example.org">link</a></p>' }));
	return id;
}

function hasRecordsFor(host) {
	return [...dnsRecords.values()].some(({ name }) => name === host || name.endsWith(`.${host}`));
}

function slugsOf(user) {
	return m.Newsletter.find({ accountId: user.accountId }).sort({ createdAt: 1 }).lean().then((newsletters) => newsletters.map(({ slug }) => slug));
}

before(async () => {
	app = await startTestApp({ APP_URL, SHARED_DOMAIN: "flockstack.io" });
	m = {
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		archiveHosts: await import("../lib/archive-hosts.js"),
		siteExtensions: (await import("@/lib/site-extensions")).siteExtensions,
		hostRouting: await import("../lib/host-routing.js"),
		sharedSender: await import("../lib/shared-sender.js"),
		auth: await import("../lib/auth.js"),
		authRoute: await import("../app/api/auth/[...all]/route.js"),
		uploadsRoute: await import("../app/api/uploads/route.js"),
		mcpRoute: await import("../app/mcp/route.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		welcome: await import("../app/welcome/actions.js"),
		Newsletter: (await import("../models/Newsletter.js")).default,
	};
});

after(() => app?.stop());

describe("hosts", () => {
	test("flockstack.io, www and FlockStack's other subdomains are the app; <slug>.flockstack.io is the newsletter's archive", async () => {
		const resolve = m.hostRouting.resolveArchiveHost;
		const appHosts = [
			"flockstack.io",
			"FlockStack.io:443",
			"www.flockstack.io",
			"r.flockstack.io",
			"send.r.flockstack.io",
			"cdn.flockstack.io",
			"api.flockstack.io",
			"mcp.flockstack.io",
			"admin.flockstack.io",
			"localhost:3000",
			"flockstack-git-main-marc-lou.vercel.app",
		];
		for (const host of appHosts) assert.deepEqual(await resolve(host), { isArchiveHost: false, slug: null }, host);
		assert.deepEqual(await resolve("weekly.flockstack.io"), { isArchiveHost: true, slug: "weekly" });
		assert.deepEqual(await resolve("Field-Notes.FlockStack.io:443"), { isArchiveHost: true, slug: "field-notes" });
		assert.deepEqual(await resolve("a.weekly.flockstack.io"), { isArchiveHost: true, slug: null }, "one label deep");
	});

	test("the app answers on its own hosts, and an archive host only opens the archive and its links", async () => {
		// Signed out, / is sign-in (FlockStack Cloud's worker hands it to the website before the app sees it).
		for (const url of [`${APP_URL}/`, "https://www.flockstack.io/", "https://api.flockstack.io/"]) {
			assert.deepEqual(outcome(await visit(url)), { status: 307 }, url);
		}
		assert.deepEqual(outcome(await visit(`${APP_URL}/signin`)), { next: true });

		assert.deepEqual(outcome(await visit("https://weekly.flockstack.io/")), { rewrite: "/archive/weekly" });
		assert.deepEqual(outcome(await visit("https://weekly.flockstack.io/p/first-issue")), { rewrite: "/archive/weekly/p/first-issue" });
		assert.deepEqual(outcome(await visit("https://weekly.flockstack.io/unsubscribe?token=t")), { next: true });
		for (const path of ["/api/auth/get-session", "/api/uploads", "/campaigns", "/mcp", "/api/v1/newsletters", "/website", "/website/pages/x"]) {
			assert.deepEqual(outcome(await visit(`https://weekly.flockstack.io${path}`)), { status: 404 }, path);
		}
		// Its /signin is the reader's, a page of the newsletter's site, never the dashboard's sign-in.
		assert.deepEqual(outcome(await visit("https://weekly.flockstack.io/signin")), { rewrite: "/archive/weekly/signin" });
		assert.deepEqual(outcome(await visit("https://weekly.flockstack.io/account")), { rewrite: "/archive/weekly/account" });
		assert.deepEqual(outcome(await visit("https://weekly.flockstack.io/issues")), { rewrite: "/archive/weekly/issues" });
		assert.equal(m.archiveHosts.getArchiveHostUrl("/archive/weekly/p/first-issue", ""), "https://weekly.flockstack.io/p/first-issue");
	});
});

describe("reserved slugs", () => {
	test("the dashboard, the REST API and MCP refuse a slug FlockStack keeps, on create and on update", async () => {
		const user = await customer("reserved@example.com", "reserved-news");
		const refused = (slug) => ({ code: "validation_failed", message: `${slug} is reserved for FlockStack, pick another slug` });
		const save = (fields) => as(user, () => m.newsletters.saveNewsletter(null, form({ name: "Notes", postalAddress: "1 Main St, Paris", ...fields })));

		assert.deepEqual(await save({ slug: "www" }), { error: refused("www").message });
		assert.deepEqual(await save({ id: user.newsletterId, slug: "cdn" }), { error: refused("cdn").message });

		const created = await callApi("POST", "/api/v1/newsletters", { key: user.key, body: { name: "R", slug: "r" } });
		assert.deepEqual([created.status, created.body.error], [400, refused("r")]);
		const updated = await callApi("PATCH", `/api/v1/newsletters/${user.newsletterId}`, { key: user.key, body: { slug: "api" } });
		assert.deepEqual([updated.status, updated.body.error], [400, refused("api")]);

		const viaMcp = await callTool(user.key, "update_newsletter", { id: user.newsletterId, slug: "mail" });
		assert.equal(viaMcp.isError, true);
		assert.deepEqual(JSON.parse(viaMcp.content[0].text).error, refused("mail"));

		assert.deepEqual(await slugsOf(user), ["reserved-news"]);
		for (const slug of ["www", "cdn", "r", "api", "mail"]) assert.equal(hasRecordsFor(`${slug}.flockstack.io`), false, slug);
	});

	test("a slug made from the name skips the ones FlockStack keeps", async () => {
		const user = await signIn("blog@example.com");
		assert.equal(await as(user, () => catchRedirect(m.welcome.completeOnboarding(null, form({ name: "Blog" })))), "/");
		await activate(user);
		assert.equal(await as(user, () => catchRedirect(m.newsletters.createNewsletter(null, form({ name: "Support" })))), "/newsletters");
		user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
		assert.equal((await callApi("POST", "/api/v1/newsletters", { key: user.key, body: { name: "Status" } })).status, 201);
		assert.deepEqual(await slugsOf(user), ["blog-2", "support-2", "status-2"]);
	});
});

describe("shared addresses", () => {
	test("hello@<slug>.flockstack.io, with its records from the DNS helper and its links on the newsletter's host", async () => {
		const user = await customer("weekly@example.com", "weekly");
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		assert.equal(newsletter.fromEmail, "hello@weekly.flockstack.io");
		const records = newsletter.sharedSender.dnsRecordIds.map((id) => dnsRecords.get(id));
		assert.deepEqual(
			records.map(({ slug, type, name }) => [slug, type, name]),
			[
				["weekly", "CNAME", "tok1._domainkey.weekly.flockstack.io"],
				["weekly", "CNAME", "tok2._domainkey.weekly.flockstack.io"],
				["weekly", "CNAME", "tok3._domainkey.weekly.flockstack.io"],
				["weekly", "MX", "bounce.weekly.flockstack.io"],
				["weekly", "TXT", "bounce.weekly.flockstack.io"],
				["weekly", "CNAME", "weekly.flockstack.io"],
			]
		);

		const id = await draft(user);
		assert.deepEqual(await as(user, () => m.campaigns.sendTestCampaign(id)), { ok: true });
		const email = sent.at(-1);
		assert.equal(email.from, "hello@weekly.flockstack.io");
		assert.match(email.html, /https:\/\/weekly\.flockstack\.io\/c\//);
		assert.match(email.headers["List-Unsubscribe"], /^<https:\/\/weekly\.flockstack\.io\/api\/unsubscribe\?token=/);
		assert.equal(email.headers["Feedback-ID"], `${id}:mc-${user.accountId}:test:flockstack`, "SES sends FlockStack's own as it is");
	});

	test("a slug saved before FlockStack kept it gets no sending subdomain, and the one of its old slug goes", async () => {
		const user = await customer("legacy@example.com", "legacy-news");
		const { sharedSender: old } = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { slug: "r", fromEmail: "hello@r.flockstack.io" } });
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();

		assert.equal(await m.sharedSender.syncSharedSender({ account: user.account, newsletter }), null);
		assert.equal(state.identities.has("r.flockstack.io"), false);
		assert.equal(hasRecordsFor("r.flockstack.io"), false);
		assert.equal(state.identities.has(old.domain), false);
		assert.equal(hasRecordsFor(old.domain), false);
	});

	test("when two plan starts set up the same address at once, the run that loses finds it set up and doesn't alert", async () => {
		const user = await customer("race@example.com", "race-news");
		const stored = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		const alerts = () => platformEmails.filter(({ subject }) => subject === "[FlockStack] Shared address not set up").length;
		const before = alerts();
		state.failNext = { name: "createDomainIdentity", error: new Error("500 Internal Server Error") };

		const result = await m.sharedSender.syncSharedSender({ account: user.account, newsletter: { ...stored, sharedSender: undefined } });
		assert.equal(result?.domain, stored.sharedSender.domain, "it returns the address the other run saved");
		assert.equal(alerts(), before, "no alert");
		assert.ok(state.identities.has(stored.sharedSender.domain), "the other run's domain stays at the provider");
	});

	test("a new slug whose records the DNS helper refuses leaves nothing at the provider, and a later save sets it up", async () => {
		const user = await customer("refused@example.com", "refused-old");
		const { sharedSender: old } = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		dnsRecords.set("rec_by_hand", { id: "rec_by_hand", slug: "by-hand", type: "CNAME", name: "refused-new.flockstack.io", value: "cname.vercel-dns.com" });
		const save = () =>
			as(user, () =>
				m.newsletters.saveNewsletter(null, form({ id: user.newsletterId, name: "Refused", slug: "refused-new", postalAddress: "1 Main St, Paris", archiveEnabled: "on" }))
			);

		assert.equal((await save()).ok, true, "the newsletter is saved either way");
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		assert.deepEqual([newsletter.slug, newsletter.fromEmail, newsletter.sharedSender], ["refused-new", "hello@refused-new.flockstack.io", undefined]);
		assert.equal(state.identities.has("refused-new.flockstack.io"), false, "the domain is taken back at the provider");
		assert.deepEqual([...dnsRecords.values()].filter(({ name }) => name.endsWith("refused-new.flockstack.io")).map(({ id }) => id), ["rec_by_hand"]);
		assert.equal(state.identities.has(old.domain), false);
		assert.equal(hasRecordsFor(old.domain), false);
		assert.ok(
			platformEmails.some(({ subject, text }) => subject === "[FlockStack] Shared address not set up" && text.includes("refused-new.flockstack.io")),
			"the admins hear of it"
		);

		dnsRecords.delete("rec_by_hand");
		assert.equal((await save()).ok, true);
		const { sharedSender } = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		assert.equal(sharedSender.domain, "refused-new.flockstack.io");
		assert.ok(state.identities.has("refused-new.flockstack.io"));
		assert.ok(sharedSender.dnsRecordIds.every((id) => dnsRecords.get(id)?.slug === "refused-new"));
	});
});

describe("sessions", () => {
	test("the session cookie is host-only, and Better Auth trusts flockstack.io's origin alone", async () => {
		const context = await (await m.auth.getAuth()).$context;
		const { name, attributes } = context.authCookies.sessionToken;
		assert.equal(name, "__Secure-better-auth.session_token");
		assert.deepEqual([attributes.domain, attributes.httpOnly, attributes.secure, attributes.sameSite], [undefined, true, true, "lax"]);
		assert.deepEqual(context.trustedOrigins, [APP_URL]);
		for (const origin of ["https://weekly.flockstack.io", "https://www.flockstack.io", "http://flockstack.io"]) assert.equal(context.isTrustedOrigin(origin), false, origin);
	});

	test("an archive page's requests to the app carry the cookie, and the app refuses them", async () => {
		const user = await signIn("session@example.com");
		const cookie = [...user.jar].map(([key, value]) => `${key}=${value}`).join("; ");
		const signOut = (origin) =>
			m.authRoute.POST(new Request(`${APP_URL}/api/auth/sign-out`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: "{}" }));
		const upload = (site) =>
			as(user, () =>
				m.uploadsRoute.POST(new Request(`${APP_URL}/api/uploads`, { method: "POST", headers: { "content-type": "image/png", "sec-fetch-site": site }, body: PNG }))
			);

		assert.equal((await upload("same-site")).status, 403);
		assert.equal((await upload("same-origin")).status, 200);

		// Better Auth leaves its origin check off when NODE_ENV is test; production runs it.
		const context = await (await m.auth.getAuth()).$context;
		const { error } = console;
		context.skipOriginCheck = false;
		try {
			console.error = () => {};
			assert.equal((await signOut("https://weekly.flockstack.io")).status, 403);
			console.error = error;
			const signedOut = await signOut(APP_URL);
			assert.equal(signedOut.status, 200);
			const setCookies = signedOut.headers.getSetCookie();
			assert.ok(setCookies.some((header) => header.startsWith("__Secure-better-auth.session_token=")));
			for (const header of setCookies) assert.doesNotMatch(header, /domain=/i, header);
		} finally {
			console.error = error;
			context.skipOriginCheck = true;
		}
	});
});
