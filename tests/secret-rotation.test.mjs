import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";

// What a rotation of BETTER_AUTH_SECRET does to the links of emails already sent and to the other things signed with keys derived
// from it, with the old value in BETTER_AUTH_SECRET_PREVIOUS and without (docs/AUTH-ROTATION.md). Signing always uses the current
// secret; a previous one is only ever used to check.
const OLD = "old-secret-for-rotation-tests-0123456789abcdef";
const NEW = "new-secret-for-rotation-tests-fedcba9876543210";
const OLDER = "older-secret-for-rotation-tests-a1b2c3d4e5f607";
const IDS = { contactId: "65f000000000000000000001", newsletterId: "65f000000000000000000002" };
const MESSAGE_ID = "65f000000000000000000003";

let app;
let m;

// Runs with the deployment's secrets, as they are on a Worker.
async function deployed({ current, previous }, run) {
	const before = { current: process.env.BETTER_AUTH_SECRET, previous: process.env.BETTER_AUTH_SECRET_PREVIOUS };
	process.env.BETTER_AUTH_SECRET = current;
	if (previous) process.env.BETTER_AUTH_SECRET_PREVIOUS = previous;
	else delete process.env.BETTER_AUTH_SECRET_PREVIOUS;
	try {
		return await run();
	} finally {
		process.env.BETTER_AUTH_SECRET = before.current;
		if (before.previous === undefined) delete process.env.BETTER_AUTH_SECRET_PREVIOUS;
		else process.env.BETTER_AUTH_SECRET_PREVIOUS = before.previous;
	}
}

before(async () => {
	app = await startTestApp({ BETTER_AUTH_SECRET: OLD });
	m = {
		config: await import("../lib/config.js"),
		secrets: await import("../lib/auth-secrets.js"),
		unsubscribe: await import("../lib/unsubscribe.js"),
		tracking: await import("../lib/tracking.js"),
		confirmation: await import("../lib/confirmation.js"),
		lastChance: await import("../lib/last-chance.js"),
		readerLinks: await import("../lib/reader-links.js"),
		referrals: await import("../lib/referral-links.js"),
		paid: await import("../lib/paid-links.js"),
		download: await import("../lib/download-link.js"),
		exportToken: await import("../lib/export-token.js"),
		accountExport: await import("../lib/account-export-token.js"),
		magic: await import("../lib/magic-links.js"),
		revalidate: await import("../lib/internal-revalidate.js"),
		revalidateRoute: await import("../app/api/internal/revalidate/route.js"),
		contacts: await import("../lib/contacts.js"),
		suppressions: await import("../lib/global-suppressions.js"),
	};
});

after(() => app?.stop());

describe("the secrets", () => {
	test("BETTER_AUTH_SECRET_PREVIOUS is a comma-separated list, newest first, without the current value or repeats", async () => {
		await deployed({ current: NEW, previous: ` ${OLD} , ${OLDER},${OLD},${NEW},, ` }, () => {
			assert.deepEqual(m.config.getPreviousAppSecrets(), [OLD, OLDER]);
			assert.deepEqual(m.config.getAppSecrets(), [NEW, OLD, OLDER]);
		});
		await deployed({ current: NEW }, () => assert.deepEqual(m.config.getAppSecrets(), [NEW]));
	});

	test("a secret gets the same version whatever its place in the list, so no counter has to be kept", () => {
		const first = m.secrets.getVersionedSecrets([NEW, OLD]);
		const later = m.secrets.getVersionedSecrets([OLDER, NEW, OLD]);
		assert.deepEqual(first.map(({ value }) => value), [NEW, OLD]);
		assert.equal(first[0].version, later[1].version);
		assert.equal(first[1].version, later[2].version);
		assert.ok(first.every(({ version }) => Number.isInteger(version) && version >= 0));
	});
});

describe("links in emails already sent", () => {
	const at = Date.UTC(2026, 9, 1);
	// A link of each kind, made while OLD was the secret.
	const made = () =>
		deployed({ current: OLD }, () => ({
			unsubscribe: m.unsubscribe.createUnsubscribeToken(IDS),
			open: m.tracking.getOpenUrl("https://app.example.com", MESSAGE_ID),
			click: m.tracking.getClickUrl("https://app.example.com", MESSAGE_ID, "https://example.com/a", 2),
			confirm: m.confirmation.createConfirmToken(IDS, at),
			keep: m.lastChance.createKeepToken(IDS, at),
			reader: m.readerLinks.createReaderToken("email", IDS, at),
			referral: m.referrals.createReferralCode(IDS.contactId),
			referralPage: m.referrals.createReferralPageToken(IDS, at),
			pledge: m.paid.createPaidToken("pledge-cancel", { p: "pledge-1" }, at),
			exported: m.exportToken.createExportToken({ accountId: IDS.contactId }, at).token,
			accountExport: m.accountExport.createAccountExportToken({ accountId: IDS.contactId, exportId: IDS.newsletterId, expiresAt: new Date(at + 3_600_000) }),
			magic: m.magic.getMagicSignature({ _id: IDS.newsletterId }),
		}));

	const tokenOf = (url) => url.split("/").at(-1);
	const check = (links) => ({
		unsubscribe: m.unsubscribe.verifyUnsubscribeToken(links.unsubscribe),
		open: m.tracking.readOpenToken(tokenOf(links.open)),
		click: m.tracking.readClickToken(tokenOf(links.click))?.isSigned,
		confirm: m.confirmation.verifyConfirmToken(links.confirm, at + 1000),
		keep: m.lastChance.verifyKeepToken(links.keep, at + 1000),
		reader: m.readerLinks.verifyReaderToken("email", links.reader, at + 1000),
		referral: m.referrals.readReferralCode(links.referral),
		referralPage: m.referrals.verifyReferralPageToken(links.referralPage, at + 1000),
		pledge: m.paid.readPaidToken("pledge-cancel", links.pledge, at + 1000),
		exported: m.exportToken.verifyExportToken(links.exported, at + 1000),
		accountExport: m.accountExport.verifyAccountExportToken(links.accountExport, at + 1000),
		magic: m.magic.checkMagicLink({ _id: IDS.newsletterId }, { keyId: 1, signature: links.magic }),
	});

	test("every kind of link still works with the old secret in BETTER_AUTH_SECRET_PREVIOUS", async () => {
		const links = await made();
		const result = await deployed({ current: NEW, previous: OLD }, () => check(links));
		assert.deepEqual(result.unsubscribe, IDS);
		assert.equal(result.open, MESSAGE_ID);
		assert.equal(result.click, true);
		assert.ok(result.confirm && result.keep && result.reader && result.referralPage && result.pledge && result.exported && result.accountExport);
		assert.equal(result.referral, IDS.contactId);
		assert.equal(result.magic, "valid");
	});

	test("and none without it", async () => {
		const links = await made();
		const result = await deployed({ current: NEW }, () => check(links));
		assert.deepEqual(result, { unsubscribe: null, open: null, click: false, confirm: null, keep: null, reader: null, referral: null, referralPage: null, pledge: null, exported: null, accountExport: null, magic: "invalid" });
	});

	test("new links are signed with the current secret only, and a previous secret cannot forge one", async () => {
		await deployed({ current: NEW, previous: OLD }, () => {
			const token = m.unsubscribe.createUnsubscribeToken(IDS);
			assert.deepEqual(deployedCheck(NEW, token), IDS, "made with the new secret");
			assert.equal(deployedCheck(OLD, token), null, "not with the old one");
			assert.equal(m.unsubscribe.verifyUnsubscribeToken(`${token.split(".")[0]}.${"A".repeat(43)}`), null);
		});
	});

	function deployedCheck(secret, token) {
		const original = process.env.BETTER_AUTH_SECRET;
		const previous = process.env.BETTER_AUTH_SECRET_PREVIOUS;
		process.env.BETTER_AUTH_SECRET = secret;
		delete process.env.BETTER_AUTH_SECRET_PREVIOUS;
		try {
			return m.unsubscribe.verifyUnsubscribeToken(token);
		} finally {
			process.env.BETTER_AUTH_SECRET = original;
			if (previous !== undefined) process.env.BETTER_AUTH_SECRET_PREVIOUS = previous;
		}
	}

	test("a download link made before the rotation opens while the old secret is kept", async () => {
		const token = await deployed({ current: OLD }, () => m.download.createDownloadToken({ orderId: "order-1" }));
		assert.deepEqual(await deployed({ current: NEW, previous: OLD }, () => m.download.verifyDownloadToken(token)), { orderId: "order-1", version: 1 });
		assert.equal(await deployed({ current: NEW }, () => m.download.verifyDownloadToken(token)), null);
	});
});

describe("the app and the API Worker during a rotation", () => {
	test("the app accepts a revalidation signed with the old secret while it is kept", async () => {
		const body = m.revalidate.buildRevalidateBody([["/campaigns"]]);
		const ask = (secret) => new Request("https://app.example.com/api/internal/revalidate", { method: "POST", body, headers: { [m.revalidate.SIGNATURE_HEADER]: m.revalidate.signBody(body, secret) } });
		assert.equal((await deployed({ current: NEW, previous: OLD }, () => m.revalidateRoute.POST(ask(OLD)))).status, 200);
		assert.equal((await deployed({ current: NEW }, () => m.revalidateRoute.POST(ask(OLD)))).status, 401);
	});
});

describe("browser cookies", () => {
	const sign = (value, secret) => crypto.createHmac("sha256", secret).update(value).digest("base64");
	const cookie = (name, value, secret) => `${name}=${encodeURIComponent(`${value}.${sign(value, secret)}`)}`;

	test("a session cookie signed with a previous secret is signed again with the current one", () => {
		const header = `theme=dark; ${cookie("fs.session_token", "abc123", OLD)}; ${cookie("__Secure-fs.state", "xyz", OLD)}`;
		const resigned = m.secrets.resignCookieHeader(header, { prefix: "fs", secrets: [NEW, OLD] });
		assert.equal(resigned, `theme=dark; ${cookie("fs.session_token", "abc123", NEW)}; ${cookie("__Secure-fs.state", "xyz", NEW)}`);
	});

	test("it leaves alone what is already current, what no secret signed, and cookies that are not Better Auth's", () => {
		const forged = cookie("fs.session_token", "abc123", OLDER);
		const header = `${cookie("fs.session_token", "abc123", NEW)}; ${forged.replace("fs.session", "fs.account")}; ${cookie("other.session_token", "abc123", OLD)}; fs.session_token=notsigned`;
		assert.equal(m.secrets.resignCookieHeader(header, { prefix: "fs", secrets: [NEW, OLD] }), header);
		assert.equal(m.secrets.resignCookieHeader(forged, { prefix: "fs", secrets: [NEW] }), forged, "nothing to try without a previous secret");
		assert.equal(m.secrets.resignCookieHeader(null, { prefix: "fs", secrets: [NEW, OLD] }), null);
	});
});

describe("what is hashed with a key derived from a secret", () => {
	test("a status left by a deleted contact is still found after a rotation with the old secret kept", async () => {
		const account = { _id: "65f0000000000000000000a1" };
		const contact = { _id: "65f0000000000000000000a2", accountId: account._id, newsletterId: IDS.newsletterId, email: "gone@example.com", status: "unsubscribed" };
		await deployed({ current: OLD }, () => m.contacts.removeContact(account, contact));
		const find = () => m.contacts.findDeletedStatuses({ accountId: account._id, newsletterId: IDS.newsletterId, emails: ["gone@example.com"] });
		assert.equal((await deployed({ current: OLD }, find)).get("gone@example.com"), "unsubscribed");
		assert.equal((await deployed({ current: NEW, previous: OLD }, find)).get("gone@example.com"), "unsubscribed");
		assert.equal((await deployed({ current: NEW }, find)).size, 0, "forgotten without the old secret");
	});

	test("the never-email list is found with SUPPRESSION_HASH_KEY_PREVIOUS, and written with the current key", async () => {
		const oldKey = "old-suppression-key-for-tests-0123456789abcdef";
		const newKey = "new-suppression-key-for-tests-fedcba9876543210";
		const withKeys = async ({ current, previous }, run) => {
			const before = { current: process.env.SUPPRESSION_HASH_KEY, previous: process.env.SUPPRESSION_HASH_KEY_PREVIOUS };
			process.env.SUPPRESSION_HASH_KEY = current;
			if (previous) process.env.SUPPRESSION_HASH_KEY_PREVIOUS = previous;
			else delete process.env.SUPPRESSION_HASH_KEY_PREVIOUS;
			try {
				return await run();
			} finally {
				process.env.SUPPRESSION_HASH_KEY = before.current;
				if (before.previous === undefined) delete process.env.SUPPRESSION_HASH_KEY_PREVIOUS;
				else process.env.SUPPRESSION_HASH_KEY_PREVIOUS = before.previous;
			}
		};
		await withKeys({ current: oldKey }, () => m.suppressions.suppressGlobally({ emails: ["nope@example.com"], reason: "trap", detail: "test" }));
		const find = () => m.suppressions.findGloballySuppressed(["nope@example.com", "fine@example.com"]);
		assert.deepEqual([...(await withKeys({ current: newKey, previous: oldKey }, find))], ["nope@example.com"]);
		assert.equal((await withKeys({ current: newKey }, find)).size, 0, "forgotten without the old key");
		assert.ok(await withKeys({ current: newKey, previous: oldKey }, () => m.suppressions.getGlobalSuppression("nope@example.com")));
		await withKeys({ current: newKey, previous: oldKey }, () => m.suppressions.suppressGlobally({ emails: ["new@example.com"], reason: "trap", detail: "test" }));
		assert.deepEqual([...(await withKeys({ current: newKey }, () => m.suppressions.findGloballySuppressed(["new@example.com"])))], ["new@example.com"], "new entries use the current key");
	});
});

describe("when the app throws", () => {
	test("the Worker answers 503 and retry-after, JSON for the API's paths and text for the others", async () => {
		const { unavailableResponse } = await import("../lib/unavailable-response.js");
		for (const path of ["/mcp", "/api/auth/oauth2/token", "/api/v1/contacts", "/.well-known/oauth-authorization-server"]) {
			const response = unavailableResponse(path);
			assert.equal(response.status, 503, path);
			assert.equal(response.headers.get("retry-after"), "5");
			assert.equal((await response.json()).error.code, "unavailable", path);
		}
		for (const path of ["/", "/campaigns", "/apiary", "/archive/news"]) {
			const response = unavailableResponse(path);
			assert.equal(response.status, 503, path);
			assert.match(response.headers.get("content-type"), /^text\/plain/);
			assert.equal(response.headers.get("cache-control"), "no-store");
		}
	});
});
