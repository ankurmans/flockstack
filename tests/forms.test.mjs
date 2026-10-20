import assert from "node:assert/strict";
import vm from "node:vm";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import nextConfig from "../next.config.mjs";
import { EMBED_SCRIPT } from "../lib/embed-script.js";
import { api, assertError, creator, findContact, nextIp, visit, visitAndFlush } from "./helpers/growth.mjs";
import { as, jsonRequest, startTestApp } from "./helpers/app.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

// Signup forms for other sites: the builder's actions, the hosted page and its views, the address a form posts to (CORS,
// honeypot, limits, confirmation), the script that frames it and the headers that let it be framed.
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		embedPage: await import("../app/embed/[id]/page.js"),
		postRoute: await import("../app/f/[id]/route.js"),
		scriptRoute: await import("../app/api/embed-script/route.js"),
		listPage: await import("../app/(app)/forms/page.js"),
		formPage: await import("../app/(app)/forms/[id]/page.js"),
		newPage: await import("../app/(app)/forms/new/page.js"),
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		Form: (await import("../models/Form.js")).default,
		FormDay: (await import("../models/FormDay.js")).default,
	};
});

after(() => app?.stop());

async function makeForm(user, body = {}) {
	const created = await api(user.key, "POST", "/forms", { newsletter: user.slug, name: "Homepage", ...body });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	return created.body;
}

function post(form, { body, type = "json", ip = nextIp(), headers = {} } = {}) {
	const payload = type === "json" ? JSON.stringify(body) : new URLSearchParams(body).toString();
	const request = new Request(`https://example.test/f/${form.id}`, {
		method: "POST",
		headers: { "content-type": type === "json" ? "application/json" : "application/x-www-form-urlencoded", accept: type === "json" ? "application/json" : "text/html", "x-forwarded-for": ip, ...headers },
		body: payload,
	});
	return visitAndFlush(ip, () => m.postRoute.POST(request, { params: Promise.resolve({ id: form.id }) }));
}

function openEmbed(form, query = {}, { ip = nextIp(), userAgent = FIREFOX } = {}) {
	return visitAndFlush(ip, async () => renderToStaticMarkup(await m.embedPage.default({ params: Promise.resolve({ id: form.id }), searchParams: Promise.resolve(query) })), { "user-agent": userAgent });
}

describe("the builder's actions", () => {
	test("make a form with its embed code, and list, change and delete it", async () => {
		const user = await creator("forms-crud");
		const form = await makeForm(user, { buttonText: "Join free", successMessage: "Welcome aboard." });
		assert.equal(form.buttonText, "Join free");
		assert.equal(form.views + form.signups, 0);
		assert.equal(form.conversion, null);
		assert.equal(form.embed.url, `https://forms-crud.flockstackmail.com/embed/${form.id}`);
		assert.equal(form.embed.script, `<script async src="https://forms-crud.flockstackmail.com/embed.js" data-flockstack-form="${form.id}"></script>`);
		assert.match(form.embed.html, new RegExp(`<form action="https://forms-crud.flockstackmail.com/f/${form.id}" method="post">`));
		assert.match(form.embed.html, /name="website" tabindex="-1"/);
		assert.match(form.embed.html, />Join free<\/button>/);
		assert.match(form.embed.iframe, /<iframe src="https:\/\/forms-crud\.flockstackmail\.com\/embed\//);

		assert.equal((await api(user.key, "GET", `/forms?newsletter=${user.slug}`)).body.forms.length, 1);
		const changed = await api(user.key, "PATCH", `/forms/${form.id}`, { buttonText: "", colors: { button: "#E11D48" }, name: "Footer" });
		assert.equal(changed.status, 200, JSON.stringify(changed.body));
		assert.deepEqual({ name: changed.body.name, buttonText: changed.body.buttonText, button: changed.body.colors.button }, { name: "Footer", buttonText: "", button: "#e11d48" });
		const kept = await api(user.key, "PATCH", `/forms/${form.id}`, { colors: { text: "#111111" } });
		assert.equal(kept.body.colors.button, "#e11d48", "colors keeps what a change leaves out");

		const removed = await api(user.key, "DELETE", `/forms/${form.id}`);
		assert.deepEqual(removed.body, { id: form.id, deleted: true });
		assertError(await api(user.key, "GET", `/forms/${form.id}`), 404, "not_found");
	});

	test("check colors, the redirect, custom fields and the number of forms", async () => {
		const user = await creator("forms-checks");
		assert.match(assertError(await api(user.key, "POST", "/forms", { name: "A", colors: { button: "red" } }), 400, "validation_failed"), /hex color/);
		assert.match(assertError(await api(user.key, "POST", "/forms", { name: "A", redirectUrl: "http://example.com/x" }), 400, "validation_failed"), /https/);
		assert.match(assertError(await api(user.key, "POST", "/forms", { name: "A", fields: ["nope"] }), 400, "validation_failed"), /no custom field nope/);
		await api(user.key, "POST", "/custom-fields", { label: "First name", type: "text" });
		const ok = await api(user.key, "POST", "/forms", { name: "A", fields: ["first_name", "first_name"] });
		assert.deepEqual(ok.body.fields, ["first_name"], "a field is asked once");
		for (let index = 1; index < 20; index += 1) assert.equal((await api(user.key, "POST", "/forms", { name: `F${index}` })).status, 201);
		assert.match(assertError(await api(user.key, "POST", "/forms", { name: "One too many" }), 409, "conflict"), /up to 20 forms/);
	});

	test("keep one account's forms from another", async () => {
		const first = await creator("forms-owner");
		const second = await creator("forms-other");
		const form = await makeForm(first);
		assertError(await api(second.key, "GET", `/forms/${form.id}`), 404, "not_found");
		assertError(await api(second.key, "DELETE", `/forms/${form.id}`), 404, "not_found");
		assert.equal((await api(second.key, "GET", `/forms?newsletter=${second.slug}`)).body.forms.length, 0);
	});
});

describe("the hosted form", () => {
	test("renders in the form's colors with its button and counts a view on the server, per day", async () => {
		const user = await creator("forms-view");
		const form = await makeForm(user, { buttonText: "Join free", colors: { button: "#e11d48", background: "#ffffff" } });
		const markup = await openEmbed(form);
		assert.match(markup, />Join free</);
		assert.match(markup, /background:#e11d48/i);
		assert.match(markup, /type="email"/);
		assert.match(markup, /name="website"/);
		const shown = await api(user.key, "GET", `/forms/${form.id}`);
		assert.equal(shown.body.views, 1);
		const today = shown.body.days.at(-1);
		assert.equal(today.views, 1);
		assert.equal(await m.FormDay.countDocuments({ accountId: user.accountId, formId: form.id }), 1);
		await openEmbed(form);
		assert.equal(await m.FormDay.countDocuments({ accountId: user.accountId, formId: form.id }), 1, "a day is one row however many views");
		assert.equal((await api(user.key, "GET", `/forms/${form.id}`)).body.days.at(-1).views, 2);
	});

	test("leaves out crawlers and counts a visitor who loads it over and over only so far", async () => {
		const user = await creator("forms-bots");
		const form = await makeForm(user);
		await openEmbed(form, {}, { userAgent: "Googlebot/2.1" });
		await openEmbed(form, {}, { userAgent: "curl/8" });
		assert.equal((await api(user.key, "GET", `/forms/${form.id}`)).body.views, 0);
		const ip = nextIp();
		for (let index = 0; index < 70; index += 1) await openEmbed(form, {}, { ip });
		assert.equal((await api(user.key, "GET", `/forms/${form.id}`)).body.views, 60);
	});

	test("shows the fields it asks for, says what a plain post's result was, and 404s for a form that is gone", async () => {
		const user = await creator("forms-fields");
		await api(user.key, "POST", "/custom-fields", { label: "Plan", type: "list", options: ["Free", "Pro"] });
		await api(user.key, "POST", "/custom-fields", { label: "Name", type: "text" });
		const form = await makeForm(user, { fields: ["name", "plan"] });
		const markup = await openEmbed(form);
		assert.ok(markup.indexOf('name="field_name"') < markup.indexOf('name="field_plan"'), "in the order chosen");
		assert.match(markup, /<option>Pro<\/option>/);
		assert.match(await openEmbed(form, { done: "pending" }), /Click the link we just emailed/);
		assert.match(await openEmbed(form, { done: "1" }), /You(&#x27;|')re in/);
		assert.match(await openEmbed(form, { error: "limit" }), /Too many signups/);
		assert.doesNotMatch(await openEmbed(form, { error: "<script>" }), /script>/);
		await api(user.key, "DELETE", `/forms/${form.id}`);
		await assert.rejects(openEmbed(form), (error) => error.name === "NotFoundError" || /NEXT_NOT_FOUND|not found/i.test(String(error.message ?? error.digest)));
	});
});

describe("posting to a form", () => {
	test("signs the visitor up from the frame (JSON), counts it, and records the form as the source", async () => {
		const user = await creator("forms-post", { confirm: false });
		const form = await makeForm(user, { successMessage: "Welcome aboard." });
		const response = await post(form, { body: { email: "Jane@Example.com", utm_source: "Friends-Letter", utm_medium: "email", page: "https://www.blog.example" } });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("access-control-allow-origin"), "*");
		assert.equal(response.headers.get("access-control-allow-credentials"), null, "no credentials: it reads no cookie");
		assert.deepEqual(await response.json(), { ok: true, message: "Welcome aboard." });
		const contact = await findContact(user, "jane@example.com");
		assert.equal(contact.source, `form:${form.id}`);
		assert.deepEqual(contact.acquisition, { channel: "email", utm: { source: "friends-letter", medium: "email" }, referrer: "blog.example" });
		const shown = (await api(user.key, "GET", `/forms/${form.id}`)).body;
		assert.deepEqual({ signups: shown.signups, today: shown.days.at(-1).signups }, { signups: 1, today: 1 });

		await post(form, { body: { email: "jane@example.com" } });
		assert.equal((await api(user.key, "GET", `/forms/${form.id}`)).body.signups, 1, "the same address is not a new signup");
	});

	test("with confirmed opt-in, the visitor is pending and the confirmation email goes out", async () => {
		const user = await creator("forms-confirm");
		const form = await makeForm(user);
		const response = await post(form, { body: { email: "kim@example.com" } });
		assert.deepEqual(await response.json(), { ok: true, pending: true, message: "You're in. The next issue lands in your inbox." });
		assert.equal((await findContact(user, "kim@example.com")).status, "pending");
		assert.ok(sesEmails.some((email) => JSON.stringify(email).includes("kim@example.com")), "a confirmation email was sent");
	});

	test("asks only for the fields the form has, and the redirect is told to the frame", async () => {
		const user = await creator("forms-post-fields", { confirm: false });
		await api(user.key, "POST", "/custom-fields", { label: "Name", type: "text", onSignupForm: true });
		await api(user.key, "POST", "/custom-fields", { label: "Company", type: "text" });
		const form = await makeForm(user, { fields: ["company"], redirectUrl: "https://example.com/thanks" });
		const response = await post(form, { body: { email: "lee@example.com", field_name: "Lee", field_company: "Acme", acq: '{"u":{"source":"injected"}}', ref: "A".repeat(27), rec: "someone" } });
		assert.equal((await response.json()).redirectUrl, "https://example.com/thanks");
		const contact = await findContact(user, "lee@example.com");
		assert.deepEqual(contact.fields, { company: "Acme" }, "the website form's fields are not this form's");
		assert.equal(contact.acquisition.channel, "direct");
		assert.equal(contact.acquisition.utm, undefined, "a post can't set the website form's hidden fields");
	});

	test("answers a plain HTML form with a redirect to the form's page, or to the page the owner chose", async () => {
		const user = await creator("forms-plain", { confirm: false });
		const plain = await makeForm(user);
		const done = await post(plain, { type: "form", body: { email: "sam@example.com", website: "" } });
		assert.equal(done.status, 303);
		assert.equal(done.headers.get("location"), `https://example.test/embed/${plain.id}?done=1`);
		const bad = await post(plain, { type: "form", body: { email: "not-an-email" } });
		assert.equal(bad.headers.get("location"), `https://example.test/embed/${plain.id}?error=invalid`);
		const own = await makeForm(user, { redirectUrl: "https://example.com/thanks" });
		const away = await post(own, { type: "form", body: { email: "pat@example.com" } });
		assert.equal(away.headers.get("location"), "https://example.com/thanks");
		const opened = await visitAndFlush(nextIp(), () => m.postRoute.GET(new Request(`https://example.test/f/${plain.id}`), { params: Promise.resolve({ id: plain.id }) }));
		assert.equal(opened.headers.get("location"), `https://example.test/embed/${plain.id}`);
	});

	test("has a CORS preflight for every origin, and answers refusals with the reason", async () => {
		const preflight = m.postRoute.OPTIONS();
		assert.equal(preflight.status, 204);
		assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
		assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
		assert.match(preflight.headers.get("access-control-allow-headers"), /Content-Type/);
		const user = await creator("forms-refuse", { confirm: false });
		const form = await makeForm(user);
		const bad = await post(form, { body: { email: "nope" } });
		assert.equal(bad.status, 400);
		assert.equal(bad.headers.get("access-control-allow-origin"), "*");
		assert.match((await bad.json()).error, /valid email/);
		const gone = await post({ id: "6650f1c2e9b1d4a012345678" }, { body: { email: "x@example.com" } });
		assert.equal(gone.status, 404);
		assert.equal(gone.headers.get("access-control-allow-origin"), "*");
	});

	test("takes the honeypot and the limit of 5 signups per visitor like the website form", async () => {
		const user = await creator("forms-limits", { confirm: false });
		const form = await makeForm(user);
		const trap = await post(form, { body: { email: "bot@example.com", website: "https://spam.example" } });
		assert.deepEqual(await trap.json(), { ok: true, message: "You're in. The next issue lands in your inbox." }, "the bot is told it worked");
		assert.equal(await findContact(user, "bot@example.com"), null);
		const ip = nextIp();
		const statuses = [];
		for (let index = 0; index < 7; index += 1) statuses.push((await post(form, { body: { email: `visitor${index}@example.com` }, ip })).status);
		assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
		assert.equal(await findContact(user, "visitor5@example.com"), null);
	});

	test("refuses a body that is too big, and a canceled account falls back to Free, which still takes signups", async () => {
		const user = await creator("forms-noplan", { confirm: false });
		const form = await makeForm(user);
		const huge = await visitAndFlush(nextIp(), () =>
			m.postRoute.POST(new Request("https://example.test/f/x", { method: "POST", headers: { "content-type": "application/json", "content-length": "50000" }, body: "{}" }), { params: Promise.resolve({ id: form.id }) })
		);
		assert.equal(huge.status, 413);
		const Account = (await import("../models/Account.js")).default;
		await Account.updateOne({ _id: user.accountId }, { $set: { subscriptionStatus: "canceled" } });
		assert.equal((await post(form, { body: { email: "late@example.com" } })).status, 200);
		assert.ok(await findContact(user, "late@example.com"));
		await flushAfter();
	});
});

describe("the script and the headers", () => {
	// A browser's worth of document, location and window for the script to run in.
	function run({ src = "https://news.flockstackmail.com/embed.js", id = "6650f1c2e9b1d4a012345678", search = "?utm_source=Friends&utm_medium=email&other=1&utm_campaign=" + "x".repeat(150) } = {}) {
		const frames = [];
		const listeners = [];
		const parent = { insertBefore: (node) => frames.push(node) };
		const script = {
			src,
			parentNode: parent,
			nextSibling: null,
			attrs: { "data-flockstack-form": id },
			getAttribute(name) {
				return this.attrs[name] ?? null;
			},
			setAttribute(name, value) {
				this.attrs[name] = value;
			},
		};
		const location = { origin: "https://blog.example", search, href: "https://blog.example/post" };
		const document = {
			currentScript: script,
			getElementsByTagName: () => [script],
			createElement: () => ({ style: {}, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }, contentWindow: { name: "framed" } }),
		};
		const window = { addEventListener: (type, listener) => listeners.push({ type, listener }) };
		vm.runInNewContext(EMBED_SCRIPT, { document, location, window, URL, URLSearchParams, encodeURIComponent, Number, Math });
		const send = (event) => listeners.filter(({ type }) => type === "message").forEach(({ listener }) => listener(event));
		return { frames, location, script, send };
	}

	test("the script puts a frame after itself, with the page's origin and its UTM parameters", () => {
		const { frames, script } = run();
		assert.equal(frames.length, 1);
		const url = new URL(frames[0].src);
		assert.equal(url.origin, "https://news.flockstackmail.com");
		assert.equal(url.pathname, "/embed/6650f1c2e9b1d4a012345678");
		assert.equal(url.searchParams.get("parent"), "https://blog.example");
		assert.equal(url.searchParams.get("utm_source"), "Friends");
		assert.equal(url.searchParams.get("utm_campaign").length, 100);
		assert.equal(url.searchParams.get("other"), null);
		assert.equal(script.getAttribute("data-flockstack-ready"), "1");
		assert.match(frames[0].style.cssText, /height:120px/);
		const twice = run({ id: "not-an-id" });
		assert.equal(twice.frames.length, 0, "a script without a form id does nothing");
	});

	test("resizes on a message from the form's origin and frame only, and redirects only to https", () => {
		const { frames, send, location } = run();
		const [frame] = frames;
		const message = (data, overrides = {}) => ({ origin: "https://news.flockstackmail.com", source: frame.contentWindow, data: { source: "flockstack-form", form: "6650f1c2e9b1d4a012345678", ...data }, ...overrides });
		send(message({ type: "resize", height: 181.2 }));
		assert.match(frame.style.cssText, /height:120px/, "the first height is the starting one; the script sets the style property");
		assert.equal(frame.style.height, "182px");
		send(message({ type: "resize", height: 500 }, { origin: "https://evil.example" }));
		send(message({ type: "resize", height: 500 }, { source: { name: "another frame" } }));
		send(message({ type: "resize", height: 500, form: "other" }));
		send(message({ type: "resize", height: -4 }));
		send(message({ type: "resize", height: "tall" }));
		assert.equal(frame.style.height, "182px", "none of those moved it");
		send(message({ type: "resize", height: 99999 }));
		assert.equal(frame.style.height, "2000px");
		send(message({ type: "redirect", url: "javascript:alert(1)" }));
		send(message({ type: "redirect", url: "http://example.com/" }, { origin: "https://evil.example" }));
		assert.equal(location.href, "https://blog.example/post");
		send(message({ type: "redirect", url: "https://example.com/thanks" }));
		assert.equal(location.href, "https://example.com/thanks");
	});

	test("the script is served to any site and the embed page alone may be framed", async () => {
		const response = m.scriptRoute.GET();
		assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
		assert.equal(response.headers.get("access-control-allow-origin"), "*");
		assert.equal(await response.text(), EMBED_SCRIPT);

		const rules = await nextConfig.headers();
		const effective = (path) => {
			const headers = new Headers();
			for (const rule of rules) {
				const pattern = new RegExp(`^${rule.source.replace(":path*", ".*").replace(":id", "[^/]+")}$`);
				if (pattern.test(path)) for (const { key, value } of rule.headers) headers.set(key, value);
			}
			return headers;
		};
		assert.match(effective("/embed/6650f1c2e9b1d4a012345678").get("content-security-policy"), /frame-ancestors \*/);
		assert.match(effective("/archive/x").get("content-security-policy"), /frame-ancestors 'none'/);
		assert.equal(effective("/archive/x").get("x-frame-options"), "DENY");
		assert.equal(effective("/embed/6650f1c2e9b1d4a012345678").get("strict-transport-security"), "max-age=63072000; includeSubDomains");
		assert.equal(effective("/embed/6650f1c2e9b1d4a012345678").get("x-content-type-options"), "nosniff");
	});

	test("a newsletter's host serves the form, its post address and the script, and still nothing else", async () => {
		const user = await creator("forms-host");
		const form = await makeForm(user);
		const visitHost = (path, method = "GET") => {
			const url = `https://forms-host.flockstackmail.com${path}`;
			return m.proxy(new m.NextRequest(url, { method, headers: { host: new URL(url).host } }));
		};
		for (const path of [`/embed/${form.id}`, `/f/${form.id}`]) {
			const response = await visitHost(path);
			assert.equal(response.status, 200, path);
			assert.equal(response.headers.get("x-middleware-next"), "1", path);
		}
		const script = await visitHost("/embed.js");
		assert.equal(script.headers.get("x-middleware-rewrite"), "https://forms-host.flockstackmail.com/api/embed-script");
		assert.equal((await m.proxy(new m.NextRequest("http://localhost:3000/embed.js", { headers: { host: "localhost:3000" } }))).headers.get("x-middleware-rewrite"), "http://localhost:3000/api/embed-script");
		assert.equal((await visitHost("/embed/not-an-id")).status, 404);
		assert.equal((await visitHost("/f/xyz")).status, 404);
	});
});

describe("the dashboard", () => {
	test("lists the forms with their numbers, edits one and shows its code", async () => {
		const user = await creator("forms-dashboard", { confirm: false });
		const render = async (element) => renderToStaticMarkup(createElement(m.TooltipProvider, null, await element));
		assert.match(await as(user, () => render(m.listPage.default())), /No forms yet/);
		const form = await makeForm(user, { name: "Sidebar" });
		await post(form, { body: { email: "dash@example.com" } });
		const list = await as(user, () => render(m.listPage.default()));
		assert.match(list, /Sidebar/);
		assert.match(list, /href="\/forms\/[a-f0-9]{24}"/);
		const page = await as(user, () => render(m.formPage.default({ params: Promise.resolve({ id: form.id }) })));
		assert.match(page, /One line \(recommended\)/);
		assert.ok(page.includes("data-flockstack-form="), "the script is shown to copy");
		assert.match(await as(user, () => render(m.newPage.default())), /Preview/);
	});
});
