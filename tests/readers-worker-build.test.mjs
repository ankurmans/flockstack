import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildReadersWorker } from "../scripts/build-readers-worker.mjs";
import { VARIABLES, listEnvironment } from "../scripts/readers-env.mjs";
import { activate, as, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";

// scripts/build-readers-worker.mjs: the readers Worker is one ES module with the shared source in it and nothing of Next.js or React.
// The built file is loaded and asked for answers, against a database file the test's own modules share, so what runs is what Wrangler
// uploads and a link from an email already sent is checked by the signature the bundle computes, not the test's.
let folder;
let outFile;
let source;
let worker;
let app;
let seed;
const SECRET = "test-secret-for-integration-tests-0123456789";
const pending = [];
const ctx = { waitUntil: (promise) => pending.push(promise) };
const BASE = "https://weekly.flockstackmail.com";

const hkdf = (label) => Buffer.from(crypto.hkdfSync("sha256", SECRET, "", label, 32));
const sign = (label, value) => crypto.createHmac("sha256", hkdf(label)).update(value).digest("base64url").slice(0, 22);
const ask = (path, init) => worker.fetch(new Request(`${BASE}${path}`, init), { DB: {} }, ctx);
const settle = () => Promise.allSettled(pending.splice(0));

before(async () => {
	folder = mkdtempSync(join(tmpdir(), "flockstack-readers-build-"));
	outFile = join(folder, "index.js");
	const built = await buildReadersWorker({ outFile, metafile: true });
	assert.equal(built.outFile, outFile);
	source = readFileSync(outFile, "utf8");
	// The test's own modules and the bundle share one database file.
	const database = join(folder, "readers.sqlite");
	app = await startTestApp();
	const driver = await import("../lib/docdb/driver.js");
	driver.setDriver(await driver.sqliteDriver(database));
	process.env.FLOCKSTACK_SQLITE = database;
	Object.assign(process.env, { BETTER_AUTH_SECRET: SECRET, SUPPRESSION_HASH_KEY: "test-suppression-hash-key-0123456789abcdef", FLOCKSTACK_CLOUD: "true", APP_URL: "https://flockstack.io" });
	worker = (await import(pathToFileURL(outFile).href)).default;

	const newsletters = await import("../app/(app)/newsletters/actions.js");
	const Contact = (await import("../models/Contact.js")).default;
	const Campaign = (await import("../models/Campaign.js")).default;
	const Message = (await import("../models/Message.js")).default;
	const user = await signIn("readers-build@example.com");
	await activate(user);
	const url = await as(user, () => catchRedirect(newsletters.saveNewsletter(null, form({ name: "Weekly", slug: "weekly", postalAddress: "1 Main St, Paris" }))));
	const newsletterId = url.split("/").at(-1);
	const contact = await Contact.create({ accountId: user.accountId, newsletterId, email: "reader@example.org", status: "active" });
	const campaign = await Campaign.create({ accountId: user.accountId, newsletterId, subject: "Issue", status: "sent", sentAt: new Date(), stats: { recipients: 1, sent: 1 } });
	const message = await Message.create({ accountId: user.accountId, newsletterId, campaignId: campaign._id, contactId: contact._id, kind: "campaign", email: "reader@example.org", status: "sent", sentAt: new Date(Date.now() - 600_000) });
	seed = { user, newsletterId, contactId: String(contact._id), campaignId: String(campaign._id), messageId: String(message._id), Message, Contact, Campaign };
});

after(async () => {
	delete process.env.FLOCKSTACK_SQLITE;
	await app?.stop();
	rmSync(folder, { recursive: true, force: true });
});

describe("the built readers Worker", () => {
	test("has no Next.js, React or server component code in it", () => {
		const meta = JSON.parse(readFileSync(`${outFile}.meta.json`, "utf8"));
		const inputs = Object.keys(Object.values(meta.outputs)[0].inputs);
		for (const input of inputs) {
			assert.doesNotMatch(input, /node_modules\/(next|react|react-dom|scheduler|@opennextjs|better-auth|@better-auth|stripe|@tiptap|prosemirror)/, input);
			assert.doesNotMatch(input, /^(app\/.*\.jsx|components\/)/, input);
		}
		assert.ok(inputs.includes("workers/api/runtime-hooks.js"));
		assert.ok(!inputs.includes("lib/runtime-hooks.js"));
		assert.doesNotMatch(source, /from"next\/|from "next\/|require\("next|react-dom/);
	});

	test("has no character above U+00FF, and is a small part of the app's 28 MB", () => {
		assert.equal(source.search(/[^\x00-\xff]/), -1);
		assert.ok(statSync(outFile).size < 3_000_000, `${statSync(outFile).size} bytes`);
	});

	test("every endpoint, driven through the built Worker, reads only environment names that scripts/readers-env.mjs lists", async () => {
		const read = new Set();
		const real = process.env;
		process.env = new Proxy(real, {
			get(target, key, receiver) {
				if (typeof key === "string" && /^[A-Z][A-Z0-9_]{2,}$/.test(key)) read.add(key);
				return Reflect.get(target, key, receiver);
			},
		});
		try {
			const { createUnsubscribeToken } = await import("../lib/unsubscribe.js");
			const token = createUnsubscribeToken({ contactId: "64f1a2b3c4d5e6f7a8b9c0d1", newsletterId: seed.newsletterId });
			const url = "https://example.org/story";
			const click = `${seed.messageId}.${sign("flockstack-tracking-v1", `click:${seed.messageId}:0:${url}`)}.0.${Buffer.from(url).toString("base64url")}`;
			for (const [path, init] of [
				[`/o/${seed.messageId}.${sign("flockstack-tracking-v1", `open:${seed.messageId}`)}`, {}],
				[`/c/${click}`, { headers: { "user-agent": "Mozilla/5.0 Chrome/141" } }],
				[`/api/unsubscribe?token=${token}`, {}],
				[`/api/unsubscribe?token=${token}`, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } }],
				["/api/views", { method: "POST", body: JSON.stringify({ id: seed.campaignId }), headers: { "user-agent": "Mozilla/5.0 Chrome/141" } }],
				["/api/visit", { method: "POST", body: JSON.stringify({ n: "weekly", kind: "home" }), headers: { "user-agent": "Mozilla/5.0 Chrome/141", "content-type": "application/json" } }],
				["/api/recommendations/impression", { method: "POST", body: JSON.stringify({ newsletter: "weekly", shown: [] }), headers: { "user-agent": "Mozilla/5.0 Chrome/141" } }],
				[`/f/${seed.campaignId}`, { method: "POST", body: JSON.stringify({ email: "someone@gmail.com" }), headers: { "content-type": "application/json", accept: "application/json" } }],
				["/embed.js", {}],
			]) {
				await ask(path, init);
				await settle();
			}
		} finally {
			process.env = real;
		}
		const unlisted = [...read].filter((name) => listEnvironment(`process.env.${name}`).length > 0 && !VARIABLES[name]);
		assert.deepEqual(unlisted, [], "read by an endpoint, and not in VARIABLES");
		for (const name of ["BETTER_AUTH_SECRET"]) assert.ok(read.has(name), `${name} is read`);
	});

	test("an open pixel: the GIF at once, and the open recorded behind it in the shared database", async () => {
		const response = await ask(`/o/${seed.messageId}.${sign("flockstack-tracking-v1", `open:${seed.messageId}`)}`);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "image/gif");
		assert.equal(response.headers.get("x-served-by"), "readers");
		assert.match(response.headers.get("x-frame-options"), /DENY/);
		await settle();
		assert.ok((await seed.Message.findOne({ accountId: seed.user.accountId, _id: seed.messageId }).lean()).openedAt, "the open is recorded");
	});

	test("a click link redirects and counts the click, after the answer", async () => {
		const url = "https://example.org/story";
		const token = `${seed.messageId}.${sign("flockstack-tracking-v1", `click:${seed.messageId}:0:${url}`)}.0.${Buffer.from(url).toString("base64url")}`;
		const response = await ask(`/c/${token}`, { headers: { "user-agent": "Mozilla/5.0 Chrome/141" } });
		assert.equal(response.status, 302);
		assert.equal(response.headers.get("location"), url);
		await settle();
		assert.ok((await seed.Message.findOne({ accountId: seed.user.accountId, _id: seed.messageId }).lean()).clickedAt, "the click is recorded");
	});

	test("one-click unsubscribe takes the contact off the list with a token signed by the app's secret, and a token signed by another secret is refused", async () => {
		const payload = Buffer.from(JSON.stringify({ c: seed.contactId, n: seed.newsletterId })).toString("base64url");
		const { createUnsubscribeToken } = await import("../lib/unsubscribe.js");
		const token = createUnsubscribeToken({ contactId: seed.contactId, newsletterId: seed.newsletterId });
		assert.ok(payload && token.includes("."));
		const other = crypto.createHmac("sha256", Buffer.from(crypto.hkdfSync("sha256", "another-secret-another-secret-12345", "", "flockstack-unsubscribe-v1", 32))).update(token.split(".")[0]).digest("base64url");
		const refused = await ask(`/api/unsubscribe?token=${token.split(".")[0]}.${other}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
		assert.equal(refused.status, 400);
		assert.equal((await seed.Contact.findOne({ accountId: seed.user.accountId, _id: seed.contactId }).lean()).status, "active");
		const response = await ask(`/api/unsubscribe?token=${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		await settle();
		assert.equal((await seed.Contact.findOne({ accountId: seed.user.accountId, _id: seed.contactId }).lean()).status, "unsubscribed");
	});

	test("the beacons, the form's preflight and the embed script answer", async () => {
		assert.equal((await ask("/api/views", { method: "POST", headers: { "user-agent": "Mozilla/5.0 Chrome/141" }, body: JSON.stringify({ id: seed.campaignId }) })).status, 204);
		assert.equal((await ask("/api/recommendations/impression", { method: "POST", body: "{}" })).status, 204);
		assert.equal((await ask(`/f/${seed.campaignId}`, { method: "OPTIONS" })).status, 204);
		const script = await ask("/embed.js");
		assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
		assert.match(await script.text(), /iframe/);
	});

	test("what is not its own is marked for the router, and switched off it hands everything back", async () => {
		assert.equal((await ask("/unsubscribe")).headers.get("x-fs-readers-miss"), "1");
		const off = await worker.fetch(new Request(`${BASE}/o/x`), { DB: {}, READERS_DISABLED: "true" }, ctx);
		assert.equal(off.status, 503);
		assert.equal(off.headers.get("x-fs-readers-unprocessed"), "1");
	});
});
