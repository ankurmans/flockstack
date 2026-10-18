import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { activate, as, catchRedirect, form, platformEmails, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { calls, cloudflareError, failNext, listRecords, zones } from "./stubs/cloudflare-api.mjs";
import { dnsRecords } from "./stubs/dns-broker.mjs";

// Shared addresses' DNS records on a Cloudflare zone, through the real shared-sender code with Cloudflare's API and SES
// in memory. The DNS helper stays for servers without Cloudflare's variables.
const ZONE = "zone_shared_dns";
let app;
let m;

function save(user, slug, fields = {}) {
	return as(user, () => m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St, Paris", archiveEnabled: "on", ...fields })));
}

async function customer(email, slug) {
	const user = await signIn(email);
	await activate(user);
	const url = await as(user, () => catchRedirect(save(user, slug)));
	user.newsletterId = url.split("/").at(-1);
	return user;
}

function newsletterOf(user) {
	return m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
}

function recordsFor(slug, zoneId = ZONE) {
	return listRecords(zoneId)
		.filter(({ comment }) => comment === `flockstack shared address: ${slug}`)
		.map(({ type, name, content, priority, proxied }) => [type, name, content, priority ?? null, proxied]);
}

function quietly(run) {
	const error = console.error;
	console.error = () => {};
	return run().finally(() => {
		console.error = error;
	});
}

const subjects = (from) => platformEmails.slice(from).map(({ subject }) => subject);

before(async () => {
	app = await startTestApp({ CLOUDFLARE_API_TOKEN: "test-cloudflare-token", CLOUDFLARE_SHARED_ZONE_ID: ZONE, ARCHIVE_CNAME_TARGET: "sites.flockstack.io" });
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		sharedDns: await import("../lib/shared-dns.js"),
		sharedSender: await import("../lib/shared-sender.js"),
		Account: (await import("../models/Account.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
	};
});

after(() => app?.stop());

describe("shared addresses on Cloudflare DNS", () => {
	test("a new newsletter's records go into the shared zone, DNS only but the web record, and SES finds them", async () => {
		const user = await customer("cf-dns@example.com", "cf-dns");
		const subdomain = "cf-dns.flockstackmail.com";
		const { sharedSender } = await newsletterOf(user);
		assert.equal(sharedSender.dnsDriver, "cloudflare");
		assert.deepEqual(recordsFor("cf-dns"), [
			["CNAME", `tok1._domainkey.${subdomain}`, "tok1.dkim.amazonses.com", null, false],
			["CNAME", `tok2._domainkey.${subdomain}`, "tok2.dkim.amazonses.com", null, false],
			["CNAME", `tok3._domainkey.${subdomain}`, "tok3.dkim.amazonses.com", null, false],
			["MX", `bounce.${subdomain}`, "feedback-smtp.us-east-1.amazonses.com", 10, false],
			["TXT", `bounce.${subdomain}`, "v=spf1 include:amazonses.com ~all", null, false],
			["CNAME", subdomain, "sites.flockstack.io", null, true],
		]);
		assert.deepEqual(sharedSender.dnsRecordIds, listRecords(ZONE).filter(({ comment }) => comment.endsWith(": cf-dns")).map(({ id }) => id), "ids in order");
		assert.equal([...dnsRecords.values()].some(({ slug }) => slug === "cf-dns"), false, "nothing through the DNS helper");
		const account = await m.Account.findById(user.accountId).lean();
		const refreshed = await m.sharedSender.refreshSharedSender(account, await newsletterOf(user));
		assert.equal(refreshed.sharedSender.verified, true, "SES found the records");
	});

	test("the EU Worker publishes its own SES region's records", async () => {
		await withEnv({ FLOCKSTACK_REGION: "eu", SES_REGION: "eu-west-1" }, async () => {
			await customer("cf-dns-eu@example.com", "cf-dns-eu");
		});
		assert.deepEqual(recordsFor("cf-dns-eu").find(([type]) => type === "MX"), ["MX", "bounce.cf-dns-eu.flockstackmail.com", "feedback-smtp.eu-west-1.amazonses.com", 10, false]);
	});

	test("a slug change removes the old records and publishes the new ones; the purge removes the rest", async () => {
		const user = await customer("cf-dns-move@example.com", "cf-dns-old");
		const old = (await newsletterOf(user)).sharedSender;
		assert.equal((await save(user, "cf-dns-new", { id: user.newsletterId, fromEmail: "hello@cf-dns-old.flockstackmail.com" })).ok, true);
		assert.deepEqual(recordsFor("cf-dns-old"), []);
		assert.ok(old.dnsRecordIds.every((id) => !zones.get(ZONE).records.has(id)));
		assert.equal(recordsFor("cf-dns-new").length, 6);

		await m.sharedSender.releaseSharedSenders(await m.Account.findById(user.accountId).lean());
		assert.deepEqual(recordsFor("cf-dns-new"), []);
		assert.equal((await newsletterOf(user)).sharedSender, undefined);
	});

	test("publishing again is idempotent: the same records, or this slug's own left from before, are reused", async () => {
		const records = [
			{ purpose: "dkim", type: "CNAME", name: "tok1._domainkey.again.flockstackmail.com", value: "tok1.dkim.amazonses.com" },
			{ purpose: "web", type: "CNAME", name: "again.flockstackmail.com", value: "sites.flockstack.io" },
		];
		const first = await m.sharedDns.publishSharedRecords("again", records);
		const second = await m.sharedDns.publishSharedRecords("again", records);
		assert.deepEqual(second.ids, first.ids);

		const moved = [records[0], { ...records[1], value: "sites-eu.flockstack.io" }];
		const third = await m.sharedDns.publishSharedRecords("again", moved);
		assert.deepEqual(third.ids, first.ids, "this slug's own web record is updated in place");
		assert.equal(recordsFor("again").find(([, name]) => name === "again.flockstackmail.com")[2], "sites-eu.flockstack.io");
		assert.equal(recordsFor("again").length, 2);
	});

	test("a name someone else's record holds is refused, and what was created for the slug is taken back", async () => {
		zones.get(ZONE).records.set("dns_owner", { id: "dns_owner", type: "CNAME", name: "taken.flockstackmail.com", content: "elsewhere.example.com" });
		const records = [
			{ purpose: "dkim", type: "CNAME", name: "tok1._domainkey.taken.flockstackmail.com", value: "tok1.dkim.amazonses.com" },
			{ purpose: "web", type: "CNAME", name: "taken.flockstackmail.com", value: "sites.flockstack.io" },
		];
		await assert.rejects(m.sharedDns.publishSharedRecords("taken", records), (error) => {
			assert.equal(error.message, "Cloudflare refused taken's records: CNAME taken.flockstackmail.com is taken");
			assert.equal(error.helperProblem, null);
			return true;
		});
		assert.deepEqual(recordsFor("taken"), []);
		assert.equal(zones.get(ZONE).records.get("dns_owner").content, "elsewhere.example.com", "never overwritten");
	});

	test("Cloudflare's rate limit and a bad token alert once for the shared DNS, like the DNS helper's cap and failure", async () => {
		const one = await signIn("cf-dns-429@example.com");
		await activate(one);
		const before = platformEmails.length;
		failNext({ name: "createDnsRecord", error: cloudflareError(429, 971, "Please wait and consider throttling your request speed") });
		await quietly(() => as(one, () => catchRedirect(save(one, "cf-dns-429"))));
		assert.deepEqual(subjects(before), ["[FlockStack] Shared DNS at its daily cap", "[FlockStack] Shared address not set up"]);

		const two = await signIn("cf-dns-403@example.com");
		await activate(two);
		const next = platformEmails.length;
		failNext({ name: "createDnsRecord", error: cloudflareError(403, 10000, "Authentication error") });
		await quietly(() => as(two, () => catchRedirect(save(two, "cf-dns-403"))));
		assert.deepEqual(subjects(next), ["[FlockStack] Shared DNS failing", "[FlockStack] Shared address not set up"]);
		assert.ok(platformEmails.at(-2).text.includes("CLOUDFLARE_API_TOKEN"));
		assert.deepEqual(recordsFor("cf-dns-429"), []);
		assert.deepEqual(recordsFor("cf-dns-403"), []);
	});

	test("the daily cap counts shared addresses per zone and answers like the helper's", async () => {
		await withEnv({ CLOUDFLARE_DNS_DAILY_CAP: "1", CLOUDFLARE_SHARED_ZONE_ID: "zone_capped" }, async () => {
			const records = (slug) => [{ purpose: "web", type: "CNAME", name: `${slug}.flockstackmail.com`, value: "sites.flockstack.io" }];
			assert.equal((await m.sharedDns.publishSharedRecords("capped-one", records("capped-one"))).ids.length, 1);
			await assert.rejects(m.sharedDns.publishSharedRecords("capped-two", records("capped-two")), (error) => error.helperProblem === "cap" && error.status === 429);
			assert.deepEqual(recordsFor("capped-two", "zone_capped"), []);
		});
	});

	test("without CLOUDFLARE_SHARED_ZONE_ID or the token, the DNS helper publishes, and its records are removed through it later", async () => {
		const start = calls.length;
		const user = await withEnv({ CLOUDFLARE_SHARED_ZONE_ID: "" }, () => customer("broker-dns@example.com", "broker-dns"));
		await withEnv({ CLOUDFLARE_API_TOKEN: "" }, () => customer("broker-dns-two@example.com", "broker-dns-two"));
		assert.deepEqual(calls.slice(start), [], "no Cloudflare call");
		const { sharedSender } = await newsletterOf(user);
		assert.equal(sharedSender.dnsDriver, "broker");
		assert.ok(sharedSender.dnsRecordIds.every((id) => dnsRecords.get(id)?.slug === "broker-dns"));

		// Cloudflare is set up now: the helper's records still go through the helper.
		await m.sharedSender.releaseSharedSenders(await m.Account.findById(user.accountId).lean());
		assert.ok(sharedSender.dnsRecordIds.every((id) => !dnsRecords.has(id)));
		assert.equal(calls.slice(start).some(({ name }) => name === "deleteDnsRecord"), false);
		assert.equal(m.sharedDns.getSharedDnsDriverId({ CLOUDFLARE_SHARED_ZONE_ID: ZONE }), "broker");
		assert.equal(m.sharedDns.getSharedDnsDriverId({ CLOUDFLARE_SHARED_ZONE_ID: ZONE, CLOUDFLARE_API_TOKEN: "x" }), "cloudflare");
	});
});
