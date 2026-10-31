import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { as, callApi, form, jsonRequest, startTestApp } from "./helpers/app.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, setupSender } from "./helpers/sending.mjs";
import { published } from "./stubs/qstash.mjs";
import { CLAIM_CHECK, buildClaimReport, figuresIn, isOnPage, issueUnits, pageValues, planChecks } from "../lib/claim-check-rules.js";
import { buildReadyCheck } from "../lib/ready-check.js";

// The claim check (docs/CLAIM-CHECK.md): dead links, figures not on the pages they link to and figures with no source, on any
// issue. Every request in these tests is answered by a stub fetch and a stub resolver: nothing reaches the network.
const PUBLIC = async (host) => (host.startsWith("inside.") ? ["10.1.2.3"] : ["93.184.216.34"]);

function respond(routes, log = []) {
	return async (input, init = {}) => {
		const url = String(input?.url ?? input);
		log.push({ url, method: init.method ?? "GET", headers: init.headers ?? {} });
		if (url.endsWith("/robots.txt") && !routes[url]) return new Response("", { status: 404 });
		const route = routes[`${init.method ?? "GET"} ${url}`] ?? routes[url];
		if (!route) return new Response("Not found", { status: 404 });
		if (route.throws) throw Object.assign(new Error("boom"), { name: route.throws });
		// A new answer each time: a cloned one could never be cancelled, as its twin is never read.
		return typeof route === "string" ? new Response(route, { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response(route.body ?? null, { status: route.status ?? 200, headers: route.headers ?? {} });
	};
}

const tokens = (text) => figuresIn(text).filter(({ isClaim }) => isClaim).map(({ token }) => token);
const rich = (html, extra = {}) => ({ format: "rich", subject: "", previewText: "", html, ...extra });

describe("figures in an issue", () => {
	test("the same figure in another form is on the page: $1.7 billion, 1.7bn and 1,700,000,000; 8.0% and 8%", () => {
		const values = pageValues("Revenue reached $1,700,000,000 last year, a rise of 8% on the year before, with 1,712,000,000 visits.");
		for (const written of ["$1.7 billion", "1.7bn", "1,700,000,000", "$1.7B", "1700 million", "8.0%", "8%", "8 percent", "1.71 billion"]) {
			const [figure] = figuresIn(written);
			assert.ok(isOnPage(figure, values), written);
		}
		for (const written of ["$1.8 billion", "8.5%", "17%", "170 million"]) assert.equal(isOnPage(figuresIn(written)[0], values), false, written);
	});

	test("dates, years, times, ordinals, a list's numbering, labels and numbers in addresses are left out", () => {
		assert.deepEqual(tokens("On October 29, 2026 at 10:30 am the 2nd report (issue 12, page 40) came out; see https://example.com/2024/report-55?id=9 or example.org/x/77, {{count}} [3], 2026-10-29 and 10/29/2026."), []);
		assert.deepEqual(tokens("1. The first point\n2) The second point"), []);
		assert.deepEqual(tokens("In the 1990s, Q3, COVID-19 and the A320 v1.2.3, 3 people"), []);
		assert.deepEqual(tokens("Marketing 40 staff, Decent 75 seats, sales up 12% in May"), ["40", "75", "12%"], "a word that starts like a month is not a date");
		assert.deepEqual(tokens("Sales rose 45% to $12 million, from 450,000 to 1,200 users, 10-20% of them"), ["45%", "$12 million", "450,000", "1,200", "10", "20%"]);
	});

	test("an issue's paragraphs, list items and headings, each with its links; the subject and preview are headings", () => {
		const units = issueUnits({ format: "markdown", subject: "Up 40% this week", previewText: "", markdown: "# A 30% jump\n\nRevenue rose 45% to [$12 million](https://example.com/a).\n\n- 1,200 users signed up\n- [The report](https://example.org/b) counts 77 jobs\n\nNothing to count here." });
		assert.deepEqual(
			units.map(({ kind, field, links, figures }) => [kind, field, links, figures.map(({ token }) => token)]),
			[
				["heading", "subject", [], ["40%"]],
				["heading", "body", [], ["30%"]],
				["text", "body", ["https://example.com/a"], ["45%", "$12 million"]],
				["text", "body", [], ["1,200"]],
				["text", "body", ["https://example.org/b"], ["77"]],
				["text", "body", [], []],
			]
		);
		assert.deepEqual(planChecks(units), { links: ["https://example.com/a", "https://example.org/b"], pages: ["https://example.com/a", "https://example.org/b"], total: 2 });
	});

	test("a paragraph that states a figure with no link is an uncited claim; a heading isn't", () => {
		const units = issueUnits(rich("<h2>Five things, 40% better</h2><p>Signups grew 40% in a month.</p><p>Thanks for reading.</p>"));
		const report = buildClaimReport({ units });
		assert.equal(report.failures, 1);
		assert.deepEqual(report.uncitedClaims, [{ text: "Signups grew 40% in a month.", figures: ["40%"] }]);
		assert.deepEqual(report.unmatchedFigures, []);
	});
});

describe("reading the pages an issue links to", () => {
	let checkIssue;
	let robots;

	before(async () => {
		({ checkIssue } = await import("../lib/claim-check-run.js"));
		robots = await import("../lib/briefings/robots.js");
	});

	const run = (campaign, routes, log = [], resolveHost = PUBLIC) => {
		robots.clearRobotsCache();
		return checkIssue({ units: issueUnits(campaign), fetchImpl: respond(routes, log), resolveHost });
	};

	test("a figure that isn't on the page its paragraph links to is reported; one that is, in another form, isn't", async () => {
		const log = [];
		const { report } = await run(
			rich('<p>The firm made <a href="https://news.example.com/a">$1.7 billion</a>, up 8.0%.</p><p>It hired 350 people (<a href="https://news.example.com/b">source</a>).</p>'),
			{ "https://news.example.com/a": "<html><body><article>Revenue: 1,700,000,000 dollars, 8% more.</article></body></html>", "https://news.example.com/b": "<p>It hired 120 people.</p>" },
			log
		);
		assert.equal(report.pagesRead, 2);
		assert.deepEqual(report.unmatchedFigures.map(({ figure, urls }) => [figure, urls]), [["350", ["https://news.example.com/b"]]]);
		assert.equal(report.failures, 1);
		assert.ok(log.every(({ headers }) => headers["user-agent"]?.startsWith("FlockStack-Briefings/1.0") && !("cookie" in headers)), "the engine's honest user agent, no cookies");
	});

	test("a dead link is a failure; a site that refuses the check or is slow is only unconfirmed", async () => {
		const { report } = await run(
			rich('<p><a href="https://news.example.com/gone">Gone</a> <a href="https://news.example.com/down">Down</a> <a href="https://news.example.com/bot">Bot</a> <a href="https://news.example.com/fine">Fine</a></p>'),
			{
				"https://news.example.com/gone": { status: 404, body: "Not found" },
				"https://news.example.com/down": { throws: "TypeError" },
				"https://news.example.com/bot": { status: 403, body: "no" },
				"https://news.example.com/fine": "<p>ok</p>",
			}
		);
		assert.deepEqual(report.deadLinks.map(({ url }) => url).sort(), ["https://news.example.com/down", "https://news.example.com/gone"]);
		assert.match(report.deadLinks.find(({ url }) => url.endsWith("/gone")).reason, /404/);
		assert.deepEqual(report.unsureLinks.map(({ url }) => url), ["https://news.example.com/bot"]);
		assert.equal(report.failures, 2);
	});

	test("a link to a private address is refused by the guard and never asked, not even after a redirect", async () => {
		const log = [];
		const { report } = await run(
			rich('<p>Up 12% (<a href="https://inside.example.com/admin">x</a>), 30% (<a href="https://10.0.0.1/stats">y</a>) and 45% (<a href="https://news.example.com/moved">z</a>).</p>'),
			{ "https://news.example.com/moved": { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } } },
			log
		);
		assert.deepEqual(report.deadLinks.map(({ url }) => url).sort(), ["https://10.0.0.1/stats", "https://inside.example.com/admin", "https://news.example.com/moved"]);
		assert.ok(report.deadLinks.every(({ reason }) => /private network/.test(reason)), JSON.stringify(report.deadLinks));
		assert.ok(!log.some(({ url }) => /inside\.example|10\.0\.0\.1|169\.254/.test(url)), JSON.stringify(log.map(({ url }) => url)));
		assert.equal(report.unconfirmedFigures.length, 3, "a figure whose page couldn't be read is neither found nor missing");
	});

	test("robots.txt is read first and a page it keeps the fetcher out of isn't opened", async () => {
		const log = [];
		const { report } = await run(rich('<p>A 25% rise (<a href="https://shy.example.com/story">source</a>).</p>'), { "https://shy.example.com/robots.txt": "User-agent: *\nDisallow: /\n", "https://shy.example.com/story": "<p>25%</p>" }, log);
		assert.deepEqual(log.map(({ url }) => url), ["https://shy.example.com/robots.txt"]);
		assert.equal(report.unsureLinks[0].reason, "robots.txt asks FlockStack not to open it");
		assert.equal(report.counts.unconfirmedFigures, 1);
		assert.equal(report.failures, 0);
	});

	test("bounded: at most maxLinks links judged and maxPages pages read, and no request starts after the time limit", async () => {
		const many = Array.from({ length: 30 }, (_, index) => `<p>Up ${index + 11}% (<a href="https://news.example.com/${index}">s</a>)</p>`).join("");
		const pages = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`https://news.example.com/${index}`, `<p>${index + 11}%</p>`]));
		const log = [];
		const { report } = await run(rich(many), pages, log);
		assert.equal(report.linksChecked, CLAIM_CHECK.maxLinks);
		assert.equal(report.linksTotal, 30);
		assert.equal(report.pagesRead, CLAIM_CHECK.maxPages);
		assert.ok(log.length <= CLAIM_CHECK.maxRequests);
		assert.equal(report.counts.unmatchedFigures, 0);
		assert.equal(report.counts.unconfirmedFigures, 30 - CLAIM_CHECK.maxPages);

		robots.clearRobotsCache();
		let clock = 0;
		const slow = [];
		const late = await checkIssue({ units: issueUnits(rich(many)), fetchImpl: async (...args) => ((clock += 10_000), respond(pages, slow)(...args)), resolveHost: PUBLIC, now: () => clock });
		assert.ok(late.report.linksChecked < 10, `${late.report.linksChecked} links after the time ran out`);
		assert.ok(slow.length < 12);
	});
});

describe("check_campaign on any issue", () => {
	let app;
	let m;
	let runClaimCheck;
	let robots;

	before(async () => {
		app = await startTestApp(QSTASH_KEYS);
		m = { ...(await loadSendingModules()), claimRoute: await import("../app/api/jobs/check-claims/route.js"), ClaimCheck: (await import("../models/ClaimCheck.js")).default };
		({ runClaimCheck } = await import("../lib/claim-check-run.js"));
		robots = await import("../lib/briefings/robots.js");
	});

	after(() => app?.stop());

	const claimJobs = () => published.filter(({ url }) => url.endsWith("/api/jobs/check-claims"));
	const runJob = (routes, log = []) => {
		robots.clearRobotsCache();
		return runClaimCheck(claimJobs().at(-1).body, { fetchImpl: respond(routes, log), resolveHost: PUBLIC });
	};
	const find = (result, id) => result.items.find((entry) => entry.id === id);
	const BODY = '<p>Acme raised <a href="https://news.example.com/acme">$40 million</a> and now has 1,200 staff.</p><ul><li>Its sales grew 30% (<a href="https://news.example.com/sales">report</a>).</li></ul><p>More on <a href="https://news.example.com/gone">the founders</a>.</p>';
	const PAGES = {
		"https://news.example.com/acme": "<p>Acme raised $40M in a round led by Example Ventures.</p>",
		"https://news.example.com/sales": "<p>Sales grew 25 percent.</p>",
		"https://news.example.com/gone": { status: 404, body: "Not found" },
	};

	test("a plain issue, not a briefing's, is checked by a job and the result comes back through the registry and the REST API", async () => {
		const user = await setupSender(m, "claims-plain@example.com", { contacts: 3 });
		const id = await createDraft(m, user, { subject: "This week", previewText: "Notes", body: BODY });
		const before = claimJobs().length;
		const first = await act(m, user, "check_campaign", { id });
		assert.equal(first.claims.state, "checking");
		assert.ok(first.checking.includes("claims"));
		assert.equal(find(first, "claims").status, "info");
		assert.match(find(first, "claims").message, /^Checking 3 links and the figures they back…$/);
		assert.equal(claimJobs().length, before + 1);
		assert.equal(first.canSend, true, "it never holds a send back on its own");

		const log = [];
		const outcome = await runJob(PAGES, log);
		assert.deepEqual({ ...outcome, requests: undefined }, { checked: 3, pagesRead: 2, failures: 3, requests: undefined });

		const done = await act(m, user, "check_campaign", { id });
		assert.equal(done.claims.state, "done");
		assert.equal(done.claims.passed, false);
		assert.deepEqual(done.claims.deadLinks, [{ url: "https://news.example.com/gone", reason: "404, page not found" }]);
		assert.deepEqual(done.claims.unmatchedFigures.map(({ figure }) => figure), ["1,200", "30%"]);
		assert.deepEqual(done.claims.uncitedClaims, []);
		const row = find(done, "claims");
		assert.equal(row.status, "warning");
		assert.match(row.message, /A link doesn't load: news\.example\.com\/gone \(404, page not found\); 2 figures aren't on the page they link to: 1,200 \(news\.example\.com\/acme\), 30% \(news\.example\.com\/sales\)\./);
		assert.equal(row.fix.target, "body");
		assert.equal(done.canSend, true, "warnings never stop a send");

		const { createApiKey } = await import("../app/(app)/api-keys/actions.js");
		const { key } = await as(user, () => createApiKey(null, form({ name: "Reader", level: "read_only" })));
		const response = await callApi("GET", `/api/v1/campaigns/${id}/check`, { key });
		assert.equal(response.status, 200);
		assert.deepEqual(response.body.claims.unmatchedFigures, done.claims.unmatchedFigures);
	});

	test("unchanged words are never checked again: the kept result answers, and an edit asks again", async () => {
		const user = await setupSender(m, "claims-cache@example.com", { contacts: 2 });
		const id = await createDraft(m, user, { subject: "Cached", previewText: "p", body: BODY });
		await act(m, user, "check_campaign", { id });
		const log = [];
		await runJob(PAGES, log);
		const jobs = claimJobs().length;
		const requests = log.length;
		for (let round = 0; round < 3; round++) assert.equal((await act(m, user, "check_campaign", { id })).claims.state, "done");
		assert.equal(claimJobs().length, jobs, "no new job for the same words");
		assert.equal(log.length, requests, "no page asked again");
		assert.equal((await runJob(PAGES, log)).skipped, "not waiting for this check", "a job delivered twice does nothing");

		await as(user, () => m.campaigns.saveCampaign(id, { subject: "Cached", previewText: "p", body: `${BODY}<p>One more line.</p>` }));
		assert.equal((await act(m, user, "check_campaign", { id })).claims.state, "checking", "edited words are checked again");
		assert.equal(claimJobs().length, jobs + 1);
	});

	test("a job for words the issue no longer has opens nothing", async () => {
		const user = await setupSender(m, "claims-stale@example.com", { contacts: 2 });
		const id = await createDraft(m, user, { subject: "Stale", previewText: "p", body: BODY });
		await act(m, user, "check_campaign", { id });
		const job = claimJobs().at(-1);
		await as(user, () => m.campaigns.saveCampaign(id, { subject: "Stale", previewText: "p", body: "<p>No links now.</p>" }));
		const log = [];
		robots.clearRobotsCache();
		assert.equal((await runClaimCheck(job.body, { fetchImpl: respond(PAGES, log), resolveHost: PUBLIC })).skipped, "the issue changed");
		assert.deepEqual(log, []);
		const response = await m.claimRoute.POST(jsonRequest(job.url, { method: "POST", body: { accountId: "nope", campaignId: "nope", hash: "x" } }));
		assert.equal((await response.json()).skipped, "invalid job");
	});

	test("figures with no source need no job: they are reported at once, and an issue with neither passes", async () => {
		const user = await setupSender(m, "claims-uncited@example.com", { contacts: 2 });
		const jobs = claimJobs().length;
		const id = await createDraft(m, user, { subject: "Numbers", previewText: "p", body: "<p>Open rates rose 12% in October.</p><ol><li>First</li><li>Second</li></ol>" });
		const result = await act(m, user, "check_campaign", { id });
		assert.equal(result.claims.state, "done");
		assert.deepEqual(result.claims.uncitedClaims, [{ text: "Open rates rose 12% in October.", figures: ["12%"] }]);
		assert.match(find(result, "claims").message, /^A paragraph states figures with no link to a source: "Open rates rose 12% in October\."\.$/);
		const plain = await createDraft(m, user, { subject: "Hello", previewText: "p", body: "<p>Just a note on 3 things.</p>" });
		const clean = await act(m, user, "check_campaign", { id: plain });
		assert.equal(clean.claims.state, "none");
		assert.equal(clean.claims.passed, true);
		assert.equal(find(clean, "claims").status, "pass");
		assert.equal(claimJobs().length, jobs, "nothing to open, no job");
	});

	test("a newsletter can require a pass: then the findings, and a check that hasn't finished, refuse the send", async () => {
		const user = await setupSender(m, "claims-required@example.com", { contacts: 2 });
		const id = await createDraft(m, user, { subject: "Required", previewText: "p", body: BODY });
		assert.equal((await act(m, user, "get_newsletter", { id: user.newsletterId })).requireClaimCheck, false, "off by default");
		await act(m, user, "update_newsletter", { id: user.newsletterId, requireClaimCheck: true });
		assert.equal((await act(m, user, "get_newsletter", { id: user.newsletterId })).requireClaimCheck, true);

		const waiting = await act(m, user, "check_campaign", { id });
		assert.equal(find(waiting, "claims").status, "blocker");
		assert.equal(waiting.canSend, false);
		await assert.rejects(act(m, user, "send_campaign", { id }), (error) => error.code === "send_check_failed" && /hasn't finished on these words/.test(error.message));

		await runJob(PAGES);
		const found = await act(m, user, "check_campaign", { id });
		assert.equal(find(found, "claims").status, "blocker");
		assert.match(find(found, "claims").message, /This newsletter needs it to pass before a send\.$/);
		await assert.rejects(act(m, user, "send_campaign", { id }), (error) => error.code === "send_check_failed" && /found a link that doesn't load, 2 figures that aren't on the page it links to/.test(error.message));
		await assert.rejects(act(m, user, "schedule_campaign", { id, scheduledAt: new Date(Date.now() + 86_400_000).toISOString() }), { code: "send_check_failed" });

		const fixed = '<p>Acme raised <a href="https://news.example.com/acme">$40 million</a>.</p><ul><li>Its sales grew 25% (<a href="https://news.example.com/sales">report</a>).</li></ul>';
		await as(user, () => m.campaigns.saveCampaign(id, { subject: "Required", previewText: "p", body: fixed }));
		await act(m, user, "check_campaign", { id });
		await runJob(PAGES);
		const passed = await act(m, user, "check_campaign", { id });
		assert.equal(passed.claims.passed, true);
		assert.equal(find(passed, "claims").status, "pass");
		assert.match(find(passed, "claims").message, /^Every figure is on a page it links to, and the 2 links load\.$/);
		const sent = await act(m, user, "send_campaign", { id });
		assert.notEqual(sent.status, "draft");
	});

	test("the dashboard's settings form saves the requirement, and the review step shows the check while it runs", async () => {
		const user = await setupSender(m, "claims-form@example.com", { contacts: 2 });
		const { getNewsletterDraft } = await import("../lib/newsletter-form.js");
		const stored = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		assert.equal(getNewsletterDraft({ newsletter: stored, domains: [], sharedDomain: null }).isClaimCheckRequired, false);
		const fields = { id: user.newsletterId, name: stored.name, slug: stored.slug, fromEmail: stored.fromEmail, postalAddress: stored.postalAddress, archiveEnabled: stored.archiveEnabled ? "on" : "" };
		assert.deepEqual(await as(user, () => m.newsletters.saveNewsletter(null, form({ ...fields, requireClaimCheck: "on" }))).then(({ ok }) => ok), true);
		const saved = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		assert.equal(saved.requireClaimCheck, true);
		assert.equal(getNewsletterDraft({ newsletter: saved, domains: [], sharedDomain: null }).isClaimCheckRequired, true);
		await as(user, () => m.newsletters.saveNewsletter(null, form(fields)));
		assert.equal((await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean()).requireClaimCheck, false, "the switch off turns it off");

		const { default: PanelReady } = await import("../components/PanelReady.jsx");
		const ready = {
			error: null,
			result: {
				isChecking: true,
				checking: ["claims"],
				items: [
					{ id: "links", status: "info", title: "Links", message: "The links couldn't be checked just now, so they weren't.", fix: null },
					{ id: "claims", status: "info", title: "Claim check", message: "Checking 3 links and the figures they back…", fix: null },
				],
			},
		};
		const html = renderToStaticMarkup(createElement(PanelReady, { ready, onFix() {}, onTest() {}, isTesting: false, isTestDisabled: false }));
		assert.match(html, /data-check="claims"[^>]*><svg[^>]*aria-label="Checking"/);
		assert.doesNotMatch(html, /data-check="links"[^>]*><svg[^>]*aria-label="Checking"/, "only the row still running spins");
	});
});

describe("the review step's wording", () => {
	const newsletter = { _id: "n1", name: "Notes", fromEmail: "hello@notes.example.org", postalAddress: "1 Main St, Paris", archiveEnabled: true };
	const rendered = { html: "<p>Hi</p> {{unsubscribe_url}}", bytes: 20_000 };
	const campaign = { subject: "A calm subject", previewText: "Something to read", format: "rich", html: "<p>Hello</p>", audience: "all", testSentAt: new Date() };
	const check = (claims, links = null) => buildReadyCheck({ campaign, newsletter, rendered, audience: { count: 5, label: "Everyone", segmentName: null }, claims, links }).items.find(({ id }) => id === "claims");

	test("warnings by default, blockers when required, and a dead link the links row names is not listed twice", () => {
		const units = issueUnits(rich('<p>A <a href="https://news.example.com/gone">story</a>.</p>'));
		const report = buildClaimReport({ units, linkStates: { "https://news.example.com/gone": { state: "broken", reason: "404, page not found" } }, total: 1 });
		assert.equal(check({ state: "done", required: false, report }).status, "warning");
		assert.equal(check({ state: "done", required: true, report }).status, "blocker");
		const links = { state: "done", total: 1, checked: 1, broken: [{ url: "https://news.example.com/gone", reason: "404, page not found" }], unsure: 0 };
		assert.equal(check({ state: "done", required: false, report }, links).message, "A link doesn't load (see Links).");
		assert.equal(check(null), undefined, "no claims state, no row");
	});
});
