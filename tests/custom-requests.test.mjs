import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { as, form, startTestApp, withEnv } from "./helpers/app.mjs";
import { platformSent } from "./stubs/ses.mjs";
import { flushAfter } from "./stubs/next-server.mjs";

// The Custom plan's request form: what it accepts, what it stores, who is told, and how it is held back. FlockStack's own
// emails go out through SES here (RESEND_API_KEY is off), recorded by tests/stubs/ses.mjs; none leaves.
let app;
let m;
let visitors = 0;

const FIELDS = {
	name: "Dana Reyes",
	email: "dana@publisher.example.com",
	company: "The Weekly Brief",
	website: "publisher.example.com",
	platform: "beehiiv",
	subscribers: "400k-1m",
	emailsPerMonth: "2m-10m",
	timeline: "this-quarter",
	message: "We send daily to a large list.",
};

function visitor() {
	return { jar: new Map(), ip: `203.0.113.${++visitors}` };
}

function formWith(fields = {}, needs = ["sso", "soc2"]) {
	const data = form({ ...FIELDS, ...fields });
	for (const need of needs) data.append("needs", need);
	return data;
}

async function submit(fields, { needs, from = visitor() } = {}) {
	const result = await as(from, () => m.actions.sendCustomRequest(null, formWith(fields, needs)));
	await flushAfter();
	return result;
}

const read = (get, getAll = () => []) => m.rules.parseCustomRequest({ get, getAll });
const fromObject = (fields, needs = []) => read((name) => fields[name] ?? null, () => needs);

before(async () => {
	app = await startTestApp({ RESEND_API_KEY: "", ADMIN_EMAILS: "admin@example.com, second@example.com" });
	m = {
		actions: await import("../app/(site)/custom/actions.js"),
		rules: await import("../lib/custom-rules.js"),
		requests: await import("../lib/custom-requests.js"),
		rateLimit: await import("../lib/rate-limit.js"),
		CustomRequest: (await import("../models/CustomRequest.js")).default,
	};
});

after(() => app?.stop());

describe("what the form accepts", () => {
	test("needs a name, a valid work email and a newsletter or company", () => {
		assert.deepEqual(fromObject({ ...FIELDS, name: "  " }), { problem: "Enter your name" });
		assert.deepEqual(fromObject({ ...FIELDS, email: "not an email" }), { problem: "Enter a valid email" });
		assert.deepEqual(fromObject({ ...FIELDS, email: "Dana <dana@publisher.example.com>" }), { problem: "Enter a valid email" });
		assert.deepEqual(fromObject({ ...FIELDS, email: "dana@mailinator.com" }), { problem: "Use your work email: we reply to it" });
		assert.deepEqual(fromObject({ ...FIELDS, company: "" }), { problem: "Tell us your newsletter or company" });
		const { value } = fromObject({ ...FIELDS, email: "  Dana@Publisher.Example.com " });
		assert.equal(value.email, "dana@publisher.example.com");
	});

	test("keeps only the choices the form offers, and an 'other' line only when other is ticked", () => {
		const { value } = fromObject(
			{ ...FIELDS, platform: "friendster", subscribers: "lots", emailsPerMonth: "", timeline: "yesterday", otherNeed: "Custom domains per newsletter" },
			["sso", "made-up", "sso", "scim"]
		);
		assert.deepEqual([value.platform, value.subscribers, value.emailsPerMonth, value.timeline], ["", "", "", ""]);
		assert.deepEqual(value.needs, ["sso", "scim"]);
		assert.equal(value.otherNeed, "", "no 'other' tick, no line");

		const withOther = fromObject({ ...FIELDS, otherNeed: "Custom domains per newsletter" }, ["other"]).value;
		assert.deepEqual(withOther.needs, ["other"]);
		assert.equal(withOther.otherNeed, "Custom domains per newsletter");
	});

	test("caps every text, and a website is an http or https address or nothing", () => {
		const { value } = fromObject({ ...FIELDS, name: "N".repeat(500), company: "C".repeat(500), message: "m".repeat(9000) });
		assert.equal(value.name.length, 100);
		assert.equal(value.company.length, 120);
		assert.equal(value.message.length, 2000);

		assert.equal(fromObject({ ...FIELDS, website: "" }).value.website, "");
		assert.equal(fromObject({ ...FIELDS, website: "Example.com/" }).value.website, "https://example.com");
		assert.equal(fromObject({ ...FIELDS, website: "http://example.com/news" }).value.website, "http://example.com/news");
		for (const website of ["javascript:alert(1)", "ftp://example.com", "localhost", "https://user:pass@example.com", "not a site"]) {
			assert.equal(fromObject({ ...FIELDS, website }).problem, "Enter your website as an address like example.com", website);
		}
	});
});

describe("sending a request", () => {
	test("stores it as new, in this region, and tells the admins and the requester", async () => {
		const before = platformSent.length;
		const result = await submit({}, { needs: ["sso", "soc2", "seats"] });
		assert.deepEqual(result, { ok: true });

		const [stored] = await m.CustomRequest.find({ email: FIELDS.email }).lean();
		assert.deepEqual(
			[stored.name, stored.company, stored.website, stored.platform, stored.subscribers, stored.emailsPerMonth, stored.timeline, stored.message],
			["Dana Reyes", "The Weekly Brief", "https://publisher.example.com", "beehiiv", "400k-1m", "2m-10m", "this-quarter", "We send daily to a large list."]
		);
		assert.deepEqual(stored.needs, ["sso", "soc2", "seats"]);
		assert.equal(stored.status, "new");
		assert.equal(stored.region, "us");
		assert.ok(stored.createdAt instanceof Date);

		const emails = platformSent.slice(before);
		assert.equal(emails.length, 3, "one alert for each admin, one confirmation");
		const alerts = emails.filter(({ to }) => to !== FIELDS.email);
		assert.deepEqual(alerts.map(({ to }) => to).sort(), ["admin@example.com", "second@example.com"]);
		for (const alert of alerts) {
			assert.equal(alert.subject, "[FlockStack] New Custom plan request");
			assert.match(alert.text, /The Weekly Brief, on beehiiv\./);
			assert.match(alert.text, /Subscribers: 400,000 to 1 million\./);
			assert.match(alert.text, /Would need: SSO\/SAML, SOC 2 report, Team seats and roles\./);
			assert.match(alert.text, /http:\/\/localhost:3000\/admin\/custom$/);
			assert.ok(!alert.text.includes(FIELDS.email) && !alert.text.includes("Dana"), "the alert names no one: alerts are logged");
		}

		const confirmation = emails.find(({ to }) => to === FIELDS.email);
		assert.equal(confirmation.subject, "We got your note about a Custom plan");
		assert.match(confirmation.text, /^Hi Dana,/);
		assert.match(confirmation.text, /reply to you personally within 2 business days/);
		assert.ok(!/https?:\/\//.test(confirmation.text), "no links in it");
	});

	test("never puts the requester's address in a URL", async () => {
		const before = platformSent.length;
		await submit({ email: "url-check@publisher.example.com" });
		for (const email of platformSent.slice(before)) {
			for (const [url] of `${email.subject}\n${email.text}`.matchAll(/https?:\/\/\S+/g)) assert.ok(!url.includes("url-check"), url);
		}
	});

	test("the EU Worker stores its own region", async () => {
		await withEnv({ FLOCKSTACK_REGION: "eu" }, () => submit({ email: "eu@publisher.example.com" }));
		assert.equal((await m.CustomRequest.findOne({ email: "eu@publisher.example.com" }).lean()).region, "eu");
	});

	test("a request with a problem is stored nowhere and tells no one", async () => {
		const before = platformSent.length;
		const count = await m.CustomRequest.countDocuments({});
		assert.deepEqual(await submit({ email: "nope" }), { error: "Enter a valid email" });
		assert.equal(await m.CustomRequest.countDocuments({}), count);
		assert.equal(platformSent.length, before);
	});

	test("the honeypot answers like a success and stores nothing", async () => {
		const before = platformSent.length;
		const count = await m.CustomRequest.countDocuments({});
		assert.deepEqual(await submit({ fax: "555-0100", email: "bot@publisher.example.com" }), { ok: true });
		assert.equal(await m.CustomRequest.countDocuments({}), count);
		assert.equal(platformSent.length, before);
	});

	test("a failing email keeps the request, and the others still go", async () => {
		const ses = await import("./stubs/ses.mjs");
		const before = platformSent.length;
		const error = console.error;
		console.error = () => {};
		ses.state.failNext = { name: "sendSesPlatformEmail", error: new Error("SES is down") };
		try {
			await submit({ email: "failing@publisher.example.com" });
		} finally {
			console.error = error;
			ses.state.failNext = null;
		}
		assert.ok(await m.CustomRequest.findOne({ email: "failing@publisher.example.com" }).lean());
		assert.ok(platformSent.length > before, "the other emails still went");
	});

	test("a self-hosted server has no Custom plan to ask for", async () => {
		const count = await m.CustomRequest.countDocuments({});
		const result = await withEnv({ FLOCKSTACK_CLOUD: "" }, () => submit({ email: "self@publisher.example.com" }));
		assert.deepEqual(result, { error: "This server has no Custom plan" });
		assert.equal(await m.CustomRequest.countDocuments({}), count);
	});
});

describe("limits", () => {
	test("5 requests an hour from a network, then it asks to wait", async () => {
		const from = visitor();
		for (let index = 0; index < 5; index++) assert.deepEqual(await submit({ email: `ip-${index}@publisher.example.com` }, { from }), { ok: true });
		const result = await submit({ email: "ip-5@publisher.example.com" }, { from });
		assert.match(result.error, /Too many requests from your network/);
		assert.equal(await m.CustomRequest.findOne({ email: "ip-5@publisher.example.com" }).lean(), null);
		assert.deepEqual(await submit({ email: "other-network@publisher.example.com" }), { ok: true }, "another network is not held back");
	});

	test("3 requests a day from one address, wherever they come from, and the counter doesn't keep the address", async () => {
		for (let index = 0; index < 3; index++) assert.deepEqual(await submit({ email: "same@publisher.example.com" }), { ok: true });
		assert.match((await submit({ email: "same@publisher.example.com" })).error, /already have your requests/);
		const RateLimit = (await import("../models/RateLimit.js")).default;
		const keys = (await RateLimit.find({}).lean()).map(({ key }) => key);
		assert.ok(keys.some((key) => key.startsWith("custom-request-email:")), "counted");
		assert.ok(!keys.some((key) => key.includes("same@publisher")), "by a keyed hash");
	});
});

describe("retention", () => {
	test("requests untouched for 2 years go, and a change keeps one", async () => {
		const old = await m.CustomRequest.create({ name: "Old", email: "old@publisher.example.com", company: "Old Co", region: "us" });
		const kept = await m.CustomRequest.create({ name: "Kept", email: "kept@publisher.example.com", company: "Kept Co", region: "us" });
		const now = new Date();
		const threeYearsAgo = new Date(now.getTime() - 3 * 365 * 86_400_000);
		const oneYearAgo = new Date(now.getTime() - 365 * 86_400_000);
		await m.CustomRequest.collection.updateOne({ _id: old._id }, { $set: { updatedAt: threeYearsAgo } });
		await m.CustomRequest.collection.updateOne({ _id: kept._id }, { $set: { updatedAt: oneYearAgo } });
		assert.ok((await m.requests.purgeCustomRequests(now)) >= 1);
		assert.equal(await m.CustomRequest.findById(old._id).lean(), null);
		assert.ok(await m.CustomRequest.findById(kept._id).lean());
		assert.equal(await m.requests.purgeCustomRequests(now), 0);
	});
});
