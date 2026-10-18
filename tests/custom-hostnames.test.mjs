import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { activate, as, catchRedirect, form, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { calls, cloudflareError, failNext, findHostname, listRoutes, setHostnameStatus, zones } from "./stubs/cloudflare-api.mjs";
import { cnames } from "./stubs/dns-check.mjs";
import { verifyIdentity } from "./stubs/ses.mjs";

// Customers' archive subdomains on FlockStack Cloud on Cloudflare: a Cloudflare for SaaS custom hostname and a Worker
// route each, through the real domain functions with Cloudflare's API in memory.
const ZONE = "zone_flockstack_saas";
const CLOUDFLARE = { CLOUDFLARE_API_TOKEN: "test-cloudflare-token", CLOUDFLARE_SAAS_ZONE_ID: ZONE, ARCHIVE_CNAME_TARGET: "sites.flockstack.io" };
let app;
let m;

async function customer(email, slug) {
	const user = await signIn(email);
	await activate(user);
	await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: slug, slug, postalAddress: "1 Main St, Paris", archiveEnabled: "on" }))));
	return user;
}

async function account(user) {
	return m.Account.findById(user.accountId).lean();
}

function find(user, domain) {
	return m.Domain.findOne({ accountId: user.accountId, domain }).lean();
}

function since(index, name) {
	return calls.slice(index).filter((call) => !name || call.name === name);
}

function quietly(run) {
	const error = console.error;
	console.error = () => {};
	return run().finally(() => {
		console.error = error;
	});
}

before(async () => {
	app = await startTestApp(CLOUDFLARE);
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		domainActions: await import("../app/(app)/domains/actions.js"),
		domains: await import("../lib/domains.js"),
		customHostnames: await import("../lib/custom-hostnames.js"),
		records: await import("../lib/domain-records.js"),
		Account: (await import("../models/Account.js")).default,
		Domain: (await import("../models/Domain.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
	};
});

after(() => app?.stop());

describe("custom hostnames", () => {
	test("adding a domain creates its hostname and a route to this region's Worker; the check follows Cloudflare to active", async () => {
		const user = await customer("cf-owner@example.com", "cf-owner");
		const start = calls.length;
		const added = await m.domains.addDomain({ account: await account(user), domain: "cf-owner.com" });
		assert.equal(added.archiveHost, "news.cf-owner.com");
		assert.deepEqual(since(start, "createWorkerRoute").map(({ args }) => args), [{ zoneId: ZONE, pattern: "news.cf-owner.com/*", script: "flockstack" }]);
		assert.deepEqual(since(start, "createCustomHostname").map(({ args }) => args), [
			{ zoneId: ZONE, hostname: "news.cf-owner.com", ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } },
		]);

		let domain = await find(user, "cf-owner.com");
		assert.equal(domain.customHostname.id, findHostname(ZONE, "news.cf-owner.com").id);
		assert.equal(domain.customHostname.routeId, listRoutes(ZONE).find(({ pattern }) => pattern === "news.cf-owner.com/*").id);
		assert.deepEqual([domain.customHostname.state, domain.customHostname.worker, domain.archiveHostVerified], ["pending_validation", "flockstack", false]);
		const archive = () => m.records.getDomainSetup(domain, { cnameTarget: "sites.flockstack.io" }).find(({ key }) => key === "archive");
		assert.deepEqual(
			archive().records.map(({ type, host, value }) => [type, host, value]),
			[
				["CNAME", "news", "sites.flockstack.io"],
				["TXT", "_cf-custom-hostname.news", `verify-${domain.customHostname.id}`],
			],
			"the CNAME to the region's target, and the TXT record Cloudflare returned"
		);
		assert.deepEqual(archive().status, { label: "Waiting for DNS", tone: "wait" });

		// A CNAME alone doesn't make it ready on Cloudflare: only an active hostname with its certificate does.
		verifyIdentity("cf-owner.com");
		cnames.set("news.cf-owner.com", ["sites.flockstack.io"]);
		domain = await m.domains.checkDomain({ account: await account(user), domainId: added._id });
		assert.deepEqual([domain.verified, domain.archiveHostVerified, domain.customHostname.state], [true, false, "pending_validation"]);

		setHostnameStatus(ZONE, "news.cf-owner.com", { status: "active", sslStatus: "pending_issuance" });
		domain = await m.domains.checkDomain({ account: await account(user), domainId: added._id });
		assert.deepEqual([domain.archiveHostVerified, domain.customHostname.state, domain.customHostname.sslStatus], [false, "pending_certificate", "pending_issuance"]);
		assert.deepEqual(archive().status, { label: "Issuing the certificate", tone: "wait" });
		assert.deepEqual(archive().records.map(({ type }) => type), ["CNAME"], "no ownership record once the hostname is active");

		setHostnameStatus(ZONE, "news.cf-owner.com", { sslStatus: "active" });
		domain = await m.domains.checkDomain({ account: await account(user), domainId: added._id });
		assert.deepEqual([domain.archiveHostVerified, domain.customHostname.state], [true, "active"]);
		assert.deepEqual(archive().status, { label: "Found", tone: "good" });

		await m.Newsletter.updateOne({ accountId: user.accountId }, { $set: { fromEmail: "hi@cf-owner.com" } });
		await m.domains.syncArchiveHosts(user.accountId);
		assert.equal((await m.Newsletter.findOne({ accountId: user.accountId }).lean()).archiveHost, "news.cf-owner.com");

		assert.equal([...zones.get(ZONE).hostnames.values()].filter(({ hostname }) => hostname === "news.cf-owner.com").length, 1, "checked three times, one hostname");
		assert.equal(listRoutes(ZONE).filter(({ pattern }) => pattern === "news.cf-owner.com/*").length, 1, "and one route");
		assert.equal(since(start, "createWorkerRoute").length, 1, "the route is found, not made again");
	});

	test("the EU Worker routes its customers' hostnames to itself, and FLOCKSTACK_WORKER_NAME names another Worker", async () => {
		const user = await customer("cf-eu@example.com", "cf-eu");
		await withEnv({ FLOCKSTACK_REGION: "eu" }, () => m.domains.addDomain({ account: user.account, domain: "cf-eu.com" }));
		assert.equal(listRoutes(ZONE).find(({ pattern }) => pattern === "news.cf-eu.com/*").script, "flockstack-eu");
		assert.equal((await find(user, "cf-eu.com")).customHostname.worker, "flockstack-eu");

		await withEnv({ FLOCKSTACK_WORKER_NAME: "flockstack-staging" }, () => m.domains.addDomain({ account: user.account, domain: "cf-staging.com" }));
		assert.equal(listRoutes(ZONE).find(({ pattern }) => pattern === "news.cf-staging.com/*").script, "flockstack-staging");
		assert.equal(m.customHostnames.getWorkerName({ FLOCKSTACK_REGION: "us" }), "flockstack");
	});

	test("Cloudflare's statuses: blocked, moved and timed out", async () => {
		const user = await customer("cf-status@example.com", "cf-status");
		const added = await m.domains.addDomain({ account: user.account, domain: "cf-status.com" });
		const check = () => m.domains.checkDomain({ account: user.account, domainId: added._id });

		setHostnameStatus(ZONE, "news.cf-status.com", { status: "blocked" });
		let domain = await check();
		assert.deepEqual([domain.customHostname.state, domain.archiveHostVerified], ["blocked", false]);
		assert.deepEqual(m.records.getDomainSetup(domain, { cnameTarget: "sites.flockstack.io" }).find(({ key }) => key === "archive").status, {
			label: "Refused by Cloudflare, contact support",
			tone: "bad",
		});

		const start = calls.length;
		setHostnameStatus(ZONE, "news.cf-status.com", { status: "moved" });
		domain = await check();
		assert.equal(since(start, "refreshCustomHostname").length, 1, "a moved hostname is asked to validate again");
		assert.equal(domain.customHostname.state, "pending_validation");

		setHostnameStatus(ZONE, "news.cf-status.com", { status: "active", sslStatus: "validation_timed_out" });
		domain = await check();
		assert.deepEqual(since(start, "refreshCustomHostname").at(-1).args.ssl, m.customHostnames.CUSTOM_HOSTNAME_SSL, "with the same ssl settings");
		assert.equal(domain.customHostname.sslStatus, "pending_validation");

		assert.deepEqual(
			m.customHostnames.getValidationRecords({ status: "active", ssl: { validation_records: [{ txt_name: "_acme-challenge.news.example.com", txt_value: "token-1" }, { http_url: "http://x" }] } }),
			[{ type: "TXT", name: "_acme-challenge.news.example.com", value: "token-1" }],
			"a certificate's TXT validation records, never its HTTP ones"
		);
	});

	test("a hostname another region routes is left alone: nothing is created, and removing the domain keeps it", async () => {
		const user = await customer("cf-taken@example.com", "cf-taken");
		await withEnv({ FLOCKSTACK_REGION: "eu" }, () => m.domains.addDomain({ account: user.account, domain: "cf-both.com" }));
		const theirs = findHostname(ZONE, "news.cf-both.com");

		const other = await customer("cf-other@example.com", "cf-other");
		await m.Domain.deleteOne({ accountId: user.accountId, domain: "cf-both.com" });
		const start = calls.length;
		const added = await m.domains.addDomain({ account: other.account, domain: "cf-both.com" });
		assert.equal(since(start, "createCustomHostname").length, 0);
		assert.equal(added.customHostname.state, "conflict");
		assert.equal(added.customHostname.id, undefined);
		assert.deepEqual(m.records.getDomainSetup(added, { cnameTarget: "sites.flockstack.io" }).find(({ key }) => key === "archive").status, {
			label: "Used by another FlockStack account",
			tone: "bad",
		});

		await m.domains.removeDomain({ account: other.account, domainId: added._id });
		assert.deepEqual(findHostname(ZONE, "news.cf-both.com"), theirs);
		assert.equal(listRoutes(ZONE).find(({ pattern }) => pattern === "news.cf-both.com/*").script, "flockstack-eu");
	});

	test("Cloudflare failing halfway: the check answers, keeps what it knew, and the next one finishes", async () => {
		const user = await customer("cf-retry@example.com", "cf-retry");
		failNext({ name: "createCustomHostname", error: cloudflareError(503, 1500, "Internal Server Error") });
		const added = await quietly(() => m.domains.addDomain({ account: user.account, domain: "cf-retry.com" }));
		assert.equal(added.customHostname.state, "unavailable");
		assert.equal(findHostname(ZONE, "news.cf-retry.com"), null);
		assert.ok(listRoutes(ZONE).some(({ pattern }) => pattern === "news.cf-retry.com/*"), "the route went in first");
		assert.deepEqual(m.records.getDomainSetup(added, { cnameTarget: "sites.flockstack.io" }).find(({ key }) => key === "archive").status, {
			label: "Not checked, try again in a minute",
			tone: "wait",
		});

		const checked = await m.domains.checkDomain({ account: user.account, domainId: added._id });
		assert.deepEqual([checked.customHostname.state, Boolean(checked.customHostname.id)], ["pending_validation", true]);
		assert.equal(listRoutes(ZONE).filter(({ pattern }) => pattern === "news.cf-retry.com/*").length, 1);

		// Ready before Cloudflare stopped answering: still ready.
		setHostnameStatus(ZONE, "news.cf-retry.com", { status: "active", sslStatus: "active" });
		await m.domains.checkDomain({ account: user.account, domainId: added._id });
		failNext({ name: "listWorkerRoutes", error: cloudflareError(null, 0, "fetch failed") });
		const kept = await quietly(() => m.domains.checkDomain({ account: user.account, domainId: added._id }));
		assert.deepEqual([kept.archiveHostVerified, kept.customHostname.state, kept.customHostname.id], [true, "active", checked.customHostname.id]);
	});

	test("removing a domain deletes its route and hostname; if Cloudflare fails, the domain stays until it's removed again", async () => {
		const user = await customer("cf-remove@example.com", "cf-remove");
		const added = await m.domains.addDomain({ account: user.account, domain: "cf-remove.com" });

		failNext({ name: "deleteWorkerRoute", error: cloudflareError(403, 10000, "Authentication error") });
		assert.deepEqual(await as(user, () => m.domainActions.removeDomainAction(String(added._id))), { error: "Removing the domain failed, try again in a minute" });
		assert.ok(await find(user, "cf-remove.com"), "kept, with its ids");
		assert.ok(findHostname(ZONE, "news.cf-remove.com"));

		assert.deepEqual(await as(user, () => m.domainActions.removeDomainAction(String(added._id))), { ok: true, removed: "cf-remove.com" });
		assert.equal(findHostname(ZONE, "news.cf-remove.com"), null);
		assert.equal(listRoutes(ZONE).some(({ pattern }) => pattern === "news.cf-remove.com/*"), false);
		assert.equal(await find(user, "cf-remove.com"), null);
	});

	test("a route left by a failure halfway is found and removed with its hostname, without ids", async () => {
		const user = await customer("cf-orphan@example.com", "cf-orphan");
		const added = await m.domains.addDomain({ account: user.account, domain: "cf-orphan.com" });
		await m.Domain.updateOne({ accountId: user.accountId, _id: added._id }, { $unset: { customHostname: 1 } });
		await m.domains.removeDomain({ account: user.account, domainId: added._id });
		assert.equal(findHostname(ZONE, "news.cf-orphan.com"), null);
		assert.equal(listRoutes(ZONE).some(({ pattern }) => pattern === "news.cf-orphan.com/*"), false);
	});

	test("an account's purge removes every domain's route and hostname", async () => {
		const user = await customer("cf-purge@example.com", "cf-purge");
		await m.domains.addDomain({ account: user.account, domain: "cf-purge-one.com" });
		await m.domains.addDomain({ account: user.account, domain: "cf-purge-two.com", archiveHost: "letters.cf-purge-two.com" });
		assert.ok(findHostname(ZONE, "letters.cf-purge-two.com"));

		await m.domains.releaseDomains(user.account);
		for (const host of ["news.cf-purge-one.com", "letters.cf-purge-two.com"]) {
			assert.equal(findHostname(ZONE, host), null, host);
			assert.equal(listRoutes(ZONE).some(({ pattern }) => pattern === `${host}/*`), false, host);
		}
		assert.equal(await m.Domain.countDocuments({ accountId: user.accountId }), 0);
	});

	test("a trusted archive host never reaches Cloudflare and is verified as before", async () => {
		const user = await customer("cf-trusted@example.com", "cf-trusted");
		await withEnv({ ARCHIVE_TRUSTED_HOSTS: "newsletter.trusted-site.com" }, async () => {
			const start = calls.length;
			const added = await m.domains.addDomain({ account: user.account, domain: "cf-trusted.com", archiveHost: "newsletter.trusted-site.com" });
			assert.equal(added.archiveHostVerified, true);
			await m.domains.removeDomain({ account: user.account, domainId: added._id });
			assert.deepEqual(since(start), [], "no Cloudflare call");
		});
	});

	test("without the token, the zone or FlockStack Cloud, nothing calls Cloudflare and the CNAME is checked as before", async () => {
		const user = await customer("cf-off@example.com", "cf-off");
		for (const [index, env] of [{ CLOUDFLARE_API_TOKEN: "" }, { CLOUDFLARE_SAAS_ZONE_ID: "" }, { FLOCKSTACK_CLOUD: "" }].entries()) {
			await withEnv(env, async () => {
				const domain = `cf-off-${index}.com`;
				const start = calls.length;
				const added = await m.domains.addDomain({ account: user.account, domain });
				cnames.set(`news.${domain}`, ["sites.flockstack.io"]);
				const checked = await m.domains.checkDomain({ account: user.account, domainId: added._id });
				assert.equal(checked.archiveHostVerified, true, "the CNAME is enough");
				assert.equal(checked.customHostname?.id, undefined);
				await m.domains.removeDomain({ account: user.account, domainId: added._id });
				assert.deepEqual(since(start), [], JSON.stringify(env));
			});
		}
		assert.equal(m.customHostnames.getCustomHostnameConfig({ ...CLOUDFLARE, FLOCKSTACK_CLOUD: "true" }).worker, "flockstack");
		assert.equal(m.customHostnames.getCustomHostnameConfig({ ...CLOUDFLARE, FLOCKSTACK_CLOUD: "true", ARCHIVE_CNAME_TARGET: "" }), null);
	});
});

describe("certificate validation", () => {
	test("the Worker passes Cloudflare's validation paths through on customers' hostnames only", async () => {
		const { isCertificateValidationRequest } = await import("../lib/certificate-validation.js");
		const env = { CLOUDFLARE_SAAS_ZONE_ID: ZONE, APP_URL: "https://flockstack.io", SHARED_DOMAIN: "flockstack.io", ARCHIVE_TRUSTED_HOSTS: "newsletter.example.org" };
		const is = (url, values = env) => isCertificateValidationRequest(new Request(url), values);
		assert.equal(is("http://news.example.com/.well-known/acme-challenge/token-1"), true);
		assert.equal(is("http://news.example.com/.well-known/pki-validation/token-1.txt"), true);
		assert.equal(is("http://news.example.com/p/hello"), false);
		assert.equal(is("https://flockstack.io/.well-known/acme-challenge/token-1"), false);
		assert.equal(is("https://weekly.flockstack.io/.well-known/acme-challenge/token-1"), false);
		assert.equal(is("https://newsletter.example.org/.well-known/acme-challenge/token-1"), false);
		assert.equal(is("http://news.example.com/.well-known/acme-challenge/token-1", { ...env, CLOUDFLARE_SAAS_ZONE_ID: "" }), false, "only with custom hostnames");
	});
});
