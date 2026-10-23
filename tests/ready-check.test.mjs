import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { as, jsonRequest, startTestApp } from "./helpers/app.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, setupSender } from "./helpers/sending.mjs";
import { published } from "./stubs/qstash.mjs";
import { buildReadyCheck, findImages, findLinks, findMergeUsage, getSpamSignals } from "../lib/ready-check.js";
import { LINK_CHECK, getLinkProblem, hashLinks, judgeStatus } from "../lib/link-check-rules.js";

const newsletter = { _id: "n1", name: "Notes", fromEmail: "hello@notes.example.org", postalAddress: "1 Main St, Paris", archiveEnabled: true };
const rendered = { html: "<p>Hi</p> {{unsubscribe_url}}", bytes: 20_000 };
const campaign = { subject: "A calm subject", previewText: "Something to read", format: "rich", html: "<p>Hello</p>", audience: "all", testSentAt: new Date() };

function check(overrides = {}) {
	return buildReadyCheck({ campaign, newsletter, rendered, audience: { count: 120, label: "Everyone", segmentName: null }, ...overrides });
}

const find = (result, id) => result.items.find((entry) => entry.id === id);

describe("the checklist", () => {
	test("a clean issue has no blocker and no warning", () => {
		const result = check();
		assert.equal(result.canSend, true);
		assert.equal(result.blockers, 0);
		assert.equal(result.warnings, 0);
		assert.equal(find(result, "audience").status, "info");
		assert.match(find(result, "audience").message, /120 readers: everyone on the list/);
	});

	test("the subject is a blocker when empty and a warning past 60 characters, with a fix", () => {
		assert.equal(find(check({ campaign: { ...campaign, subject: "" } }), "subject").status, "blocker");
		assert.equal(find(check({ campaign: { ...campaign, subject: "x".repeat(60) } }), "subject").status, "pass");
		const long = find(check({ campaign: { ...campaign, subject: `${"word ".repeat(15)}end` } }), "subject");
		assert.equal(long.status, "warning");
		assert.match(long.message, /past about 60/);
		assert.deepEqual(long.fix, { label: "Edit subject", target: "subject" });
	});

	test("missing preview text and a missing test are warnings, never blockers", () => {
		const result = check({ campaign: { ...campaign, previewText: "", testSentAt: undefined } });
		assert.equal(find(result, "preview").status, "warning");
		assert.equal(find(result, "test").status, "warning");
		assert.equal(find(result, "test").fix.target, "test");
		assert.equal(result.canSend, true);
		assert.equal(result.warnings, 2);
	});

	test("the sender, the postal address, the unsubscribe link, the size and an empty issue are blockers", () => {
		const result = check({
			campaign: { ...campaign, html: "<p></p>" },
			newsletter: { ...newsletter, postalAddress: "" },
			rendered: { html: "<p>no link</p>", bytes: 130_000 },
			senderProblem: "hello@example.org isn't verified for sending",
		});
		for (const id of ["content", "address", "sender", "unsubscribe", "size"]) assert.equal(find(result, id).status, "blocker", id);
		assert.equal(find(result, "sender").message, "hello@example.org isn't verified for sending.");
		assert.equal(find(result, "address").fix.path, "/newsletters#postal-address");
		assert.equal(result.canSend, false);
		assert.equal(result.blockers, 5);
	});

	test("the plan's limit is a blocker with its numbers, and room is a pass", () => {
		const refused = check({ planProblem: "This send needs 4,812 emails and your plan has 2,000 left this month. Upgrade to send." });
		assert.equal(find(refused, "plan").status, "blocker");
		assert.match(find(refused, "plan").message, /4,812 emails and your plan has 2,000 left/);
		assert.equal(find(refused, "plan").fix.path, "/billing");
		const room = check({ emailsLeft: 5000, emails: 120 });
		assert.equal(find(room, "plan").status, "pass");
		assert.match(find(room, "plan").message, /120 emails and your plan has 5,000 left/);
	});

	test("nobody to send to is a blocker, a deleted segment too, and a segment is named", () => {
		assert.equal(find(check({ audience: { count: 0, label: "Everyone", segmentName: null } }), "audience").status, "blocker");
		const deleted = find(check({ audience: { count: 0, label: "Everyone", segmentName: null, problem: "This campaign's segment was deleted: pick another audience" } }), "audience");
		assert.equal(deleted.status, "blocker");
		assert.match(deleted.message, /segment was deleted/);
		const named = find(check({ audience: { count: 4812, label: "Paid readers", segmentName: "Engaged" }, campaign: { ...campaign, audience: "paid" } }), "audience");
		assert.match(named.message, /4,812 readers: paid readers of the segment Engaged/);
	});

	test("images without alt text and over a megabyte are warnings", () => {
		const images = [
			{ src: "https://img.example.org/a.png", alt: "A chart" },
			{ src: "https://img.example.org/b.png", alt: null },
			{ src: "https://img.example.org/c.png", alt: "  " },
		];
		const sizes = new Map([["https://img.example.org/a.png", 300_000], ["https://img.example.org/b.png", 3_400_000]]);
		const result = check({ images, imageSizes: sizes });
		assert.equal(find(result, "images-alt").status, "warning");
		assert.match(find(result, "images-alt").message, /2 of 3 images have no alt text/);
		assert.equal(find(result, "images-size").status, "warning");
		assert.match(find(result, "images-size").message, /An image is over 1\.0 MB \(the biggest is 3\.4 MB\)/);
		const fine = check({ images: [images[0]], imageSizes: new Map([[images[0].src, 1_000_000]]) });
		assert.equal(find(fine, "images-alt").status, "pass");
		assert.equal(find(fine, "images-size").status, "pass", "1 MB exactly is not over");
		assert.equal(find(check(), "images-alt"), undefined, "no images, nothing to say");
	});

	test("merge tags some contacts have no value for are warnings that say how many and what they see instead", () => {
		const result = check({
			mergeTags: [
				{ name: "first_name", fallback: "there", isField: true, missing: 312, total: 4812 },
				{ name: "city", fallback: "", isField: true, missing: 2, total: 4812 },
				{ name: "frist_name", fallback: "", isField: false, missing: 0, total: 4812 },
			],
		});
		const item = find(result, "merge-tags");
		assert.equal(item.status, "warning");
		assert.match(item.message, /\{\{first_name\}\} is empty for 312 of 4,812 contacts, who see "there"/);
		assert.match(item.message, /\{\{city\}\} is empty for 2 of 4,812 contacts, who see nothing there \(add a fallback like \{\{city\|there\}\}\)/);
		assert.match(item.message, /\{\{frist_name\}\} isn't a field of this newsletter/);
		assert.equal(find(check({ mergeTags: [{ name: "first_name", fallback: "", isField: true, missing: 0, total: 10 }] }), "merge-tags").status, "pass");
	});

	test("pushy subjects get a warning, calm ones don't, and it never blocks", () => {
		assert.deepEqual(getSpamSignals("Your weekly notes"), []);
		assert.deepEqual(getSpamSignals("BUY THE THING NOW"), ["it is all capital letters"]);
		assert.deepEqual(getSpamSignals("Read this!!!"), ["it has several exclamation marks"]);
		assert.ok(getSpamSignals("FREE!!! stuff").includes("it shouts \"free\""));
		assert.deepEqual(getSpamSignals("Free tools this week"), []);
		assert.deepEqual(getSpamSignals("Make $$$ today"), ["it is full of money signs"]);
		assert.deepEqual(getSpamSignals("OK"), [], "short words in capitals are fine");
		const result = check({ campaign: { ...campaign, subject: "ACT NOW!!! FREE!!!" } });
		assert.equal(find(result, "spam").status, "warning");
		assert.equal(result.canSend, true);
	});

	test("the free plan's footer and a paywall break are information", () => {
		const result = check({ isFreePlan: true, sentWith: true, hasPaywallBreak: true });
		assert.equal(find(result, "free-footer").status, "info");
		assert.match(find(result, "free-footer").message, /Sent with FlockStack/);
		assert.equal(find(result, "paywall").status, "info");
		assert.match(find(result, "paywall").message, /Free readers see the issue up to the paywall break/);
		const free = check({ hasPaywallBreak: true, campaign: { ...campaign, audience: "free" } });
		assert.match(find(free, "paywall").message, /free readers only/);
		assert.equal(find(check({ hasPaywallBreak: true, campaign: { ...campaign, audience: "paid" } }), "paywall"), undefined);
		assert.equal(find(check({ isFreePlan: true, sentWith: false }), "free-footer"), undefined);
	});

	test("sending turned off is a blocker, and a web only issue is checked as a page", () => {
		assert.equal(find(check({ isSendingEnabled: false }), "sending").status, "blocker");
		const web = check({ campaign: { ...campaign, publishTo: "web", previewText: "" } });
		assert.equal(find(web, "website").status, "pass");
		for (const id of ["preview", "unsubscribe", "sender", "address", "audience", "plan", "test"]) assert.equal(find(web, id), undefined, id);
		assert.equal(find(check({ campaign: { ...campaign, publishTo: "web" }, newsletter: { ...newsletter, archiveEnabled: false } }), "website").status, "blocker");
	});

	test("links: none, checking, working, broken and not checked", () => {
		assert.equal(find(check({ links: { state: "none" } }), "links").status, "pass");
		const checking = check({ links: { state: "checking", total: 3 } });
		assert.equal(find(checking, "links").message, "Checking 3 links…");
		assert.equal(checking.isChecking, true);
		assert.equal(find(check({ links: { state: "done", total: 3, checked: 3, broken: [], unsure: 1 } }), "links").status, "pass");
		const broken = find(check({ links: { state: "done", total: 25, checked: 20, broken: [{ url: "https://example.org/gone", reason: "404, page not found" }], unsure: 0 } }), "links");
		assert.equal(broken.status, "warning");
		assert.match(broken.message, /A link doesn't load: example\.org\/gone \(404, page not found\)\. The first 20 of 25 were checked\./);
		assert.equal(find(check({ links: { state: "error" } }), "links").status, "info");
	});
});

describe("what the check reads from an issue", () => {
	test("links: web addresses once each, leaving out mail, anchors, tags and placeholders", () => {
		const html = `<a href="https://example.org/a?x=1&amp;y=2">A</a><a href='http://example.org/b'>B</a><a href="https://example.org/a?x=1&y=2">again</a>
			<a href="mailto:me@example.org">m</a><a href="#top">t</a><a href="tel:123">t</a><a href="{{unsubscribe_url}}">u</a><a href="https://example.org/{{first_name}}">p</a><a href="ftp://example.org/f">f</a><a>none</a>`;
		assert.deepEqual(findLinks(html), ["https://example.org/a?x=1&y=2", "http://example.org/b"]);
	});

	test("images: the source and the alt text, with pictures still uploading left out", () => {
		const html = '<img src="https://img.example.org/a.png" alt="A chart"><img alt="late" src="https://img.example.org/b.png"><img src="https://img.example.org/c.png"><img src="blob:x" alt="y">';
		assert.deepEqual(findImages(html), [
			{ src: "https://img.example.org/a.png", alt: "A chart" },
			{ src: "https://img.example.org/b.png", alt: "late" },
			{ src: "https://img.example.org/c.png", alt: null },
		]);
	});

	test("merge tags: the fields used with the words they fall back to, the email itself and the reserved tags left out", () => {
		const usage = findMergeUsage("Hi {{first_name|there}}", "", "<p>{{email}} {{city}} {{unsubscribe_url}} {{first_name}}</p>");
		assert.deepEqual([...usage], [["first_name", "there"], ["city", ""]]);
	});
});

describe("the guard on the links FlockStack opens", () => {
	test("only public web addresses on the default ports", () => {
		for (const url of ["https://example.org/page", "http://example.org/page", "https://example.org:443/x", "http://news.example.co.uk/a?b=c"]) assert.equal(getLinkProblem(url), null, url);
		const refused = [
			"ftp://example.org/f",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"https://user:pass@example.org/",
			"https://example.org:8443/",
			"http://example.org:8080/",
			"http://localhost/",
			"http://localhost:3000/",
			"http://127.0.0.1/",
			"http://127.1/",
			"http://0.0.0.0/",
			"http://10.0.0.5/",
			"http://172.16.4.4/",
			"http://192.168.1.1/",
			"http://169.254.169.254/latest/meta-data/",
			"http://100.64.0.1/",
			"http://[::1]/",
			"http://[fd00::1]/",
			"http://[::ffff:127.0.0.1]/",
			"http://metadata.google.internal/",
			"http://printer.local/",
			"http://intranet/",
			"http://2130706433/",
			"not an address",
		];
		for (const url of refused) assert.notEqual(getLinkProblem(url), null, url);
	});

	test("a status is a page, a refusal that says nothing about the link, or a gone page", () => {
		for (const status of [200, 204, 301, 302]) assert.equal(judgeStatus(status).state, "ok", String(status));
		for (const status of [401, 403, 405, 429, 999, 500, 503]) assert.equal(judgeStatus(status).state, "unsure", String(status));
		for (const status of [404, 410, 400, 402]) assert.equal(judgeStatus(status).state, "broken", String(status));
	});

	test("the kept result is for the addresses, in any order", () => {
		assert.equal(hashLinks(["https://a.example/", "https://b.example/"]), hashLinks(["https://b.example/", "https://a.example/"]));
		assert.notEqual(hashLinks(["https://a.example/"]), hashLinks(["https://a.example/x"]));
	});
});

describe("opening the links", () => {
	let app;
	let m;
	let link;
	let realFetch;
	let calls;
	let answers;

	before(async () => {
		app = await startTestApp(QSTASH_KEYS);
		m = { ...(await loadSendingModules()), checkRoute: await import("../app/api/jobs/check-links/route.js") };
		link = await import("../lib/link-check.js");
		realFetch = globalThis.fetch;
		globalThis.fetch = async (input, init = {}) => {
			const url = String(input?.url ?? input);
			if (!url.includes("example.org") && !url.includes("example.net")) return realFetch(input, init);
			calls.push({ url, method: init.method ?? "GET", redirect: init.redirect });
			const answer = answers.get(`${init.method ?? "GET"} ${url}`) ?? answers.get(url) ?? { status: 200 };
			if (answer.throws) throw Object.assign(new Error("boom"), { name: answer.throws });
			return new Response(null, { status: answer.status, headers: answer.location ? { location: answer.location } : {} });
		};
	});

	after(async () => {
		globalThis.fetch = realFetch;
		await app?.stop();
	});

	const reset = (map = {}) => {
		calls = [];
		answers = new Map(Object.entries(map));
	};
	const checkJobs = () => published.filter(({ url }) => url.endsWith("/api/jobs/check-links"));
	const runCheckJob = async () => {
		const job = checkJobs().at(-1);
		return (await m.checkRoute.POST(jsonRequest(job.url, { method: "POST", body: job.body }))).json();
	};

	test("a link is asked for its head, then its first byte when the site doesn't take that; redirects are followed by hand", async () => {
		reset({
			"HEAD https://example.org/post": { status: 405 },
			"GET https://example.org/post": { status: 200 },
			"https://example.org/moved": { status: 301, location: "/final" },
			"https://example.org/final": { status: 200 },
		});
		assert.equal((await link.checkLink("https://example.org/post")).state, "ok");
		assert.deepEqual(calls.map(({ method }) => method), ["HEAD", "GET"]);
		assert.ok(calls.every(({ redirect }) => redirect === "manual"), "never followed by fetch itself");
		reset({ "https://example.org/moved": { status: 301, location: "/final" }, "https://example.org/final": { status: 200 } });
		assert.equal((await link.checkLink("https://example.org/moved")).state, "ok");
		assert.deepEqual(calls.map(({ url }) => url), ["https://example.org/moved", "https://example.org/final"]);
	});

	test("a redirect to a private address is not followed, and neither is a fourth hop", async () => {
		reset({ "https://example.org/sneaky": { status: 302, location: "http://169.254.169.254/latest/meta-data/" } });
		const sneaky = await link.checkLink("https://example.org/sneaky");
		assert.equal(sneaky.state, "broken");
		assert.match(sneaky.reason, /redirects to an address that points inside a private network/);
		assert.deepEqual(calls.map(({ url }) => url), ["https://example.org/sneaky"], "the private address was never asked");

		reset(Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`https://example.org/hop${n}`, { status: 302, location: `/hop${n + 1}` }])));
		const loop = await link.checkLink("https://example.org/hop1");
		assert.equal(loop.state, "broken");
		assert.equal(loop.reason, "redirects too many times");
		assert.equal(calls.length, 4, "the first address and three redirects");
		reset({ "https://example.org/a": { status: 302, location: "/b" }, "https://example.org/b": { status: 302, location: "/c" }, "https://example.org/c": { status: 302, location: "/d" }, "https://example.org/d": { status: 200 } });
		assert.equal((await link.checkLink("https://example.org/a")).state, "ok", "three redirects are fine");
	});

	test("a private address in the issue is never asked at all", async () => {
		reset();
		for (const url of ["http://localhost/admin", "http://10.0.0.1/", "https://192.168.0.1/", "http://[::1]:3000/"]) {
			const result = await link.checkLink(url);
			assert.equal(result.state, "broken", url);
		}
		assert.deepEqual(calls, []);
	});

	test("gone is broken, a refusal and a slow answer are not, and a site that can't be reached is", async () => {
		reset({
			"https://example.org/gone": { status: 404 },
			"https://example.org/bot": { status: 403 },
			"https://example.org/slow": { throws: "TimeoutError" },
			"https://example.org/down": { throws: "TypeError" },
		});
		assert.equal((await link.checkLink("https://example.org/gone")).state, "broken");
		assert.equal((await link.checkLink("https://example.org/bot")).state, "unsure");
		assert.deepEqual(await link.checkLink("https://example.org/slow"), { url: "https://example.org/slow", state: "unsure", reason: "took too long to answer" });
		assert.equal((await link.checkLink("https://example.org/down")).state, "broken");
	});

	test("check_campaign starts a job on the first call, keeps its result, and asks again only when a link changes", async () => {
		reset({ "https://example.org/gone": { status: 404 }, "https://example.net/fine": { status: 200 } });
		const user = await setupSender(m, "link-job@example.com", { contacts: 3 });
		const id = await createDraft(m, user, {
			subject: "Links",
			previewText: "Some links",
			body: '<p><a href="https://example.net/fine">Fine</a> <a href="https://example.org/gone">Gone</a> <a href="https://example.net/fine">Fine again</a> <a href="mailto:me@example.org">Mail</a></p>',
		});
		const jobs = checkJobs().length;

		const first = await act(m, user, "check_campaign", { id });
		assert.equal(first.isChecking, true);
		assert.equal(first.items.find(({ id: one }) => one === "links").message, "Checking 2 links…");
		assert.equal(checkJobs().length, jobs + 1);
		assert.deepEqual(calls, [], "nothing is opened while the request waits");
		const again = await act(m, user, "check_campaign", { id });
		assert.equal(again.isChecking, true);
		assert.equal(checkJobs().length, jobs + 1, "one job while it runs");

		assert.deepEqual(await runCheckJob(), { checked: 2, broken: 1 });
		const done = await act(m, user, "check_campaign", { id });
		assert.equal(done.isChecking, false);
		const links = done.items.find(({ id: one }) => one === "links");
		assert.equal(links.status, "warning");
		assert.match(links.message, /A link doesn't load: example\.org\/gone \(404, page not found\)/);
		assert.equal(links.fix.target, "body");
		assert.equal(checkJobs().length, jobs + 1, "the result is kept");
		assert.equal((await runCheckJob()).skipped, "not waiting for this check", "a job delivered twice does nothing");

		await as(user, () => m.campaigns.saveCampaign(id, { subject: "Links", previewText: "Some links", body: '<p><a href="https://example.net/fine">Fine</a></p>' }));
		assert.equal((await act(m, user, "check_campaign", { id })).isChecking, true, "a changed link asks again");
		assert.equal(checkJobs().length, jobs + 2);
		await runCheckJob();
		assert.equal((await act(m, user, "check_campaign", { id })).items.find(({ id: one }) => one === "links").status, "pass");

		await as(user, () => m.campaigns.saveCampaign(id, { subject: "Edited subject", previewText: "Some links", body: '<p><a href="https://example.net/fine">Fine</a></p>' }));
		await act(m, user, "check_campaign", { id });
		assert.equal(checkJobs().length, jobs + 2, "editing words doesn't ask again");
	});

	test("only the first 20 links are opened", async () => {
		reset();
		const user = await setupSender(m, "link-many@example.com", { contacts: 2 });
		const body = `<p>${Array.from({ length: 25 }, (_, index) => `<a href="https://example.net/${index}">${index}</a>`).join(" ")}</p>`;
		const id = await createDraft(m, user, { subject: "Many", previewText: "p", body });
		await act(m, user, "check_campaign", { id });
		assert.deepEqual(await runCheckJob(), { checked: 20, broken: 0 });
		assert.equal(calls.length, 20);
		const result = await act(m, user, "check_campaign", { id });
		assert.match(result.items.find(({ id: one }) => one === "links").message, /The first 20 of 25 were checked\./);
	});

	test("a job for links the draft no longer has opens nothing", async () => {
		reset();
		const user = await setupSender(m, "link-stale@example.com", { contacts: 2 });
		const id = await createDraft(m, user, { subject: "Stale", previewText: "p", body: '<p><a href="https://example.net/old">Old</a></p>' });
		await act(m, user, "check_campaign", { id });
		const job = checkJobs().at(-1);
		await as(user, () => m.campaigns.saveCampaign(id, { subject: "Stale", previewText: "p", body: "<p>No links now</p>" }));
		const response = await m.checkRoute.POST(jsonRequest(job.url, { method: "POST", body: job.body }));
		assert.equal((await response.json()).skipped, "the links changed");
		assert.deepEqual(calls, []);
		assert.equal((await act(m, user, "check_campaign", { id })).items.find(({ id: one }) => one === "links").status, "pass");
	});

	test("the limit on started checks stops an account from turning the check into a crawler", async () => {
		reset();
		const user = await setupSender(m, "link-rate@example.com", { contacts: 2 });
		const id = await createDraft(m, user, { subject: "Rate", previewText: "p", body: '<p><a href="https://example.net/0">x</a></p>' });
		let refused = null;
		for (let index = 0; index < 32 && !refused; index++) {
			await as(user, () => m.campaigns.saveCampaign(id, { subject: "Rate", previewText: "p", body: `<p><a href="https://example.net/${index}">x</a></p>` }));
			const result = await act(m, user, "check_campaign", { id });
			if (result.items.find(({ id: one }) => one === "links").message.startsWith("The links couldn't be checked")) refused = index;
		}
		assert.ok(refused >= 29 && refused <= 31, `refused at ${refused}`);
	});
});
