import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createConfirmToken } from "../lib/confirmation.js";
import { getRewardEmail } from "../lib/referral-content.js";
import { createReferralCode, createReferralPageToken, getReferralLink, hashIp, readReferralCode, verifyReferralPageToken } from "../lib/referral-links.js";
import { normalizeRewards } from "../lib/referral-rules.js";
import { REFERRAL_COUNT_TAG, REFERRAL_LINK_TAG, fillReferralTags, isReferralLinkTag } from "../lib/referral-tags.js";
import { activate, anonymous, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

const SHARED_DOMAIN = "flockstackmail.com";
const REWARDS = [
	{ referrals: 1, title: "A thank you", text: "Reply with the word FLOCK for a surprise." },
	{ referrals: 2, title: "The field guide", url: "https://example.com/field-guide.pdf" },
];
let app;
let m;
let nextId = 0;
let sequence = 0;

async function callTool(key, name, args = {}) {
	const request = new Request("http://localhost:3000/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
			authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name, arguments: args } }),
	});
	const text = await (await anonymous(() => m.mcpRoute.POST(request))).text();
	return JSON.parse(text.split("\n").find((line) => line.startsWith("data: ")).slice(6)).result;
}

// A paying account with a newsletter that confirms signups, has its website on and can send.
async function program(email, { rewards = REWARDS, enabled = true, emails } = {}) {
	const user = await signIn(email);
	await activate(user, emails === undefined ? {} : { limitOverrides: { emailsPerMonth: emails } });
	user.slug = email.split("@")[0].replace(/[^a-z0-9]/g, "-");
	const url = await as(user, () =>
		catchRedirect(
			m.newsletters.saveNewsletter(
				null,
				form({
					name: `${user.slug} news`,
					slug: user.slug,
					fromEmail: `hello@${user.slug}.${SHARED_DOMAIN}`,
					postalAddress: "1 Main St, Paris",
					archiveEnabled: "on",
					requireConfirmation: "on",
				})
			)
		)
	);
	user.newsletterId = url.split("/").at(-1);
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	const saved = await callApi("PATCH", "/api/v1/referrals/settings", { key: user.key, body: { newsletter: user.slug, enabled, rewards } });
	assert.equal(saved.status, 200, JSON.stringify(saved.body));
	user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	return user;
}

// An active subscriber, who can share their link.
async function subscriber(user, email, extra = {}) {
	return m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email, status: "active", source: "website", ...extra });
}

// Someone on the website, from an address of their own, filling in the form with a referral code.
function visit(ip, run) {
	return runWithRequest({ jar: new Map(), headers: { "x-forwarded-for": ip } }, run);
}

async function signUp(user, email, { code, ip = `203.0.113.${++sequence}` } = {}) {
	const result = await visit(ip, () => m.archive.subscribe(null, form({ newsletter: user.slug, email, ...(code && { ref: code }) })));
	await flushAfter();
	return result;
}

async function confirm(user, email) {
	const contact = await m.Contact.findOne({ accountId: user.accountId, newsletterId: user.newsletterId, email }).lean();
	const token = createConfirmToken({ contactId: contact._id, newsletterId: user.newsletterId });
	const result = await anonymous(() => m.confirm.confirmSubscription(token));
	await flushAfter();
	return result;
}

async function referral(user, email) {
	const contact = await m.Contact.findOne({ accountId: user.accountId, newsletterId: user.newsletterId, email }).lean();
	return contact && m.Referral.findOne({ accountId: user.accountId, referredId: contact._id }).lean();
}

const counted = async (user, email) => (await m.Contact.findOne({ accountId: user.accountId, newsletterId: user.newsletterId, email }).lean()).referral?.count ?? 0;
const codeOf = (contact) => createReferralCode(contact._id);

before(async () => {
	app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		archive: await import("../app/archive/actions.js"),
		confirm: await import("../app/confirm/actions.js"),
		referralPage: (await import("../app/referral/page.js")).default,
		referralsPage: await import("../app/(app)/referrals/page.js"),
		referralActions: await import("../app/(app)/referrals/actions.js"),
		mcpRoute: await import("../app/mcp/route.js"),
		blocks: await import("../lib/account-blocks.js"),
		sendingRules: await import("../lib/sending-rules.js"),
		archiveContent: await import("../lib/archive-content.js"),
		rateLimit: await import("../lib/rate-limit.js"),
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		Account: (await import("../models/Account.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		Message: (await import("../models/Message.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
		Referral: (await import("../models/Referral.js")).default,
		ReferralReward: (await import("../models/ReferralReward.js")).default,
		Suppression: (await import("../models/Suppression.js")).default,
	};
});

after(() => app?.stop());

describe("referral codes and tags", () => {
	const contactId = "6650f1c2e9b1d4a012345678";

	test("name one subscriber, can't be guessed or altered, and open their page", () => {
		const code = createReferralCode(contactId);
		assert.match(code, /^[A-Za-z0-9_-]{27}$/);
		assert.equal(readReferralCode(code), contactId);
		assert.equal(createReferralCode(contactId), code, "the same every time: nothing is stored");
		assert.equal(readReferralCode(`${code.slice(0, -1)}${code.endsWith("A") ? "B" : "A"}`), null);
		assert.equal(readReferralCode(createReferralCode("6650f1c2e9b1d4a012345679").slice(0, 16) + code.slice(16)), null, "another subscriber's ID with this signature");
		for (const bad of [undefined, "", "abc", `${code}x`, `${code.slice(0, 26)}!`]) assert.equal(readReferralCode(bad), null, String(bad));
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		const aliases = [...alphabet].map((last) => `${code.slice(0, 26)}${last}`).filter((other) => other !== code);
		assert.deepEqual(aliases.filter((other) => readReferralCode(other) !== null), [], "only the code as made counts, not its other spellings");

		const token = createReferralPageToken({ contactId, newsletterId: "6650f1c2e9b1d4a0aaaaaaaa" });
		assert.deepEqual(verifyReferralPageToken(token), { contactId, newsletterId: "6650f1c2e9b1d4a0aaaaaaaa" });
		assert.equal(verifyReferralPageToken(`${token}x`), null);
		assert.equal(verifyReferralPageToken(token, Date.now() + 11 * 365 * 86_400_000), null, "it lasts years, not for ever");
		assert.equal(verifyReferralPageToken(createReferralCode(contactId)), null, "a code is not a page link");
	});

	test("link to the newsletter's website with the code, and hash addresses with a key", () => {
		const link = getReferralLink({ slug: "weekly" }, contactId);
		assert.equal(link, `https://weekly.${SHARED_DOMAIN}/?ref=${createReferralCode(contactId)}`);
		assert.equal(getReferralLink({ slug: "weekly", archiveHost: "news.example.com" }, contactId), `https://news.example.com/?ref=${createReferralCode(contactId)}`);
		assert.match(hashIp("203.0.113.9"), /^[A-Za-z0-9_-]{22}$/);
		assert.notEqual(hashIp("203.0.113.9"), hashIp("203.0.113.10"));
		assert.equal(hashIp("unknown"), null);
	});

	test("merge tags fill in both spellings, and a link tag is a valid link address", () => {
		const html = `<a href="${REFERRAL_LINK_TAG}">x</a> <a href="%7B%7Breferral_link%7D%7D">y</a> {{ referral_link }} ${REFERRAL_COUNT_TAG} {{referral_count}}`;
		assert.equal(fillReferralTags(html, { link: "https://a.test/?ref=1", count: 3 }), '<a href="https://a.test/?ref=1">x</a> <a href="https://a.test/?ref=1">y</a> https://a.test/?ref=1 3 3');
		assert.equal(fillReferralTags(html, { link: null, count: null }), html, "null leaves them");
		assert.equal(isReferralLinkTag(" {{referral_link}} "), true);
		assert.equal(isReferralLinkTag("https://x.test/{{referral_link}}"), false);
	});

	test("rewards need a number, a title and a link or message, and keep their IDs", () => {
		const ok = normalizeRewards([{ id: "0123456789ab", referrals: 5, title: " Big ", text: "Hi" }, { referrals: 2, title: "Small", url: "https://example.com/x" }]);
		assert.deepEqual(ok.rewards.map(({ referrals, title }) => [referrals, title]), [[2, "Small"], [5, "Big"]], "lowest number first");
		assert.equal(ok.rewards[1].id, "0123456789ab");
		assert.match(ok.rewards[0].id, /^[0-9a-f]{12}$/);
		assert.match(normalizeRewards([{ referrals: 0, title: "a", text: "b" }]).problem, /Reward 1: referrals should be a whole number/);
		assert.match(normalizeRewards([{ referrals: 1, title: "a", text: "b" }, { referrals: 1, title: "c", text: "d" }]).problem, /already unlocks at 1/);
		assert.match(normalizeRewards([{ referrals: 1, title: "", text: "b" }]).problem, /add a title/);
		assert.match(normalizeRewards([{ referrals: 1, title: "a" }]).problem, /add a link or a message/);
		assert.match(normalizeRewards([{ referrals: 1, title: "a", url: "http://example.com" }]).problem, /must start with https/);
		assert.match(normalizeRewards([{ referrals: 1, title: "a", url: "javascript:alert(1)" }]).problem, /must start with https/);
		assert.match(normalizeRewards(Array.from({ length: 11 }, (_, index) => ({ referrals: index + 1, title: "a", text: "b" }))).problem, /at most 10/);
	});
});

describe("the settings", () => {
	test("turn on with rewards through the REST API, MCP and the dashboard, and report what counted", async () => {
		const user = await program("settings-owner@example.com", { enabled: false, rewards: [] });
		const initial = await callApi("GET", `/api/v1/referrals/settings?newsletter=${user.slug}`, { key: user.key });
		assert.deepEqual(
			{ ...initial.body, newsletterId: undefined },
			{
				newsletterId: undefined,
				enabled: false,
				isActive: false,
				problem: null,
				rewards: [],
				mergeTags: { link: REFERRAL_LINK_TAG, count: REFERRAL_COUNT_TAG },
				totals: { credited: 0, pending: 0, rejected: 0, referrers: 0 },
			}
		);

		const updated = await callTool(user.key, "update_referral_settings", { newsletter: user.slug, enabled: true, rewards: [{ referrals: 3, title: "Stickers", text: "Reply with your address" }] });
		assert.equal(updated.structuredContent.enabled, true);
		assert.equal(updated.structuredContent.isActive, true);
		const [reward] = updated.structuredContent.rewards;
		assert.deepEqual({ ...reward, id: undefined }, { id: undefined, referrals: 3, title: "Stickers", url: "", text: "Reply with your address" });

		const edited = await callApi("PATCH", "/api/v1/referrals/settings", { key: user.key, body: { newsletter: user.slug, rewards: [{ id: reward.id, referrals: 4, title: "Stickers", text: "Reply with your address" }] } });
		assert.equal(edited.body.rewards[0].id, reward.id, "an edited reward keeps its ID, and with it its unlocks");
		assert.equal(edited.body.enabled, true, "what a change leaves out stays");

		const saved = await as(user, () => m.referralActions.saveReferralSettings({ newsletterId: user.newsletterId, enabled: false, rewards: edited.body.rewards }));
		assert.equal(saved.ok, true);
		assert.equal((await callApi("GET", "/api/v1/referrals/settings", { key: user.key })).body.enabled, false);
	});

	test("need confirmed signups and a website, and refuse rewards that don't make sense", async () => {
		const user = await program("settings-rules@example.com");
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { requireConfirmation: false } });
		const off = await callApi("GET", "/api/v1/referrals/settings", { key: user.key });
		assert.equal(off.body.isActive, false);
		assert.match(off.body.problem, /Turn on confirmation emails first/);
		const refused = await callApi("PATCH", "/api/v1/referrals/settings", { key: user.key, body: { enabled: true } });
		assert.equal(refused.status, 400);
		assert.match(refused.body.error.message, /confirmation emails/);

		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { requireConfirmation: true, archiveEnabled: false } });
		assert.match((await callApi("PATCH", "/api/v1/referrals/settings", { key: user.key, body: { enabled: true } })).body.error.message, /Turn on the website first/);
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { archiveEnabled: true } });

		const bad = await callApi("PATCH", "/api/v1/referrals/settings", { key: user.key, body: { rewards: [{ referrals: 2, title: "No way to claim it" }] } });
		assert.equal(bad.status, 400);
		assert.match(bad.body.error.message, /add a link or a message/);
		const stored = await callApi("GET", "/api/v1/referrals/settings", { key: user.key });
		assert.equal(stored.body.rewards.length, REWARDS.length, "a refused change saved nothing");
	});

	test("can be read by a blocked account but not changed", async () => {
		const user = await program("settings-blocked@example.com");
		await m.blocks.blockAccount(user.accountId, { reason: "an admin", by: "admin" });
		assert.equal((await callApi("GET", "/api/v1/referrals/settings", { key: user.key })).status, 200);
		assert.equal((await callApi("GET", "/api/v1/referrals/leaderboard", { key: user.key })).status, 200);
		const blocked = await callApi("PATCH", "/api/v1/referrals/settings", { key: user.key, body: { enabled: false } });
		assert.equal(blocked.body.error.code, "account_blocked");
	});
});

describe("a referral", () => {
	test("counts once the new subscriber confirms, unlocks rewards and emails them through the usual sending path", async () => {
		const user = await program("flow-owner@example.com");
		const ann = await subscriber(user, "ann@example.org");

		const first = await signUp(user, "friend1@example.org", { code: codeOf(ann) });
		assert.equal(first.pending, true);
		assert.equal((await referral(user, "friend1@example.org")).status, "pending");
		assert.equal(await counted(user, "ann@example.org"), 0, "not yet: they haven't confirmed");
		const friend = await m.Contact.findOne({ accountId: user.accountId, email: "friend1@example.org" }).lean();
		assert.deepEqual(String(friend.referral.referredBy), String(ann._id));

		const before = sesEmails.length;
		assert.deepEqual(await confirm(user, "friend1@example.org"), { ok: true });
		assert.equal(await counted(user, "ann@example.org"), 1);
		assert.equal((await referral(user, "friend1@example.org")).status, "credited");
		assert.deepEqual(await confirm(user, "friend1@example.org"), { ok: true }, "a second click");
		assert.equal(await counted(user, "ann@example.org"), 1, "counts once");

		const emails = sesEmails.slice(before).filter((email) => email.to === "ann@example.org" || [email.to].flat().includes("ann@example.org"));
		assert.equal(emails.length, 1, JSON.stringify(sesEmails.slice(before).map(({ to, subject }) => [to, subject])));
		const [email] = emails;
		assert.equal(email.subject, "You unlocked a reward from flow-owner news");
		assert.match(email.text, /You've referred 1 reader\. That unlocks: A thank you\./);
		assert.match(email.text, /Reply with the word FLOCK for a surprise\./);
		assert.match(email.text, /1 more referral unlocks The field guide/);
		assert.match(email.text, /Unsubscribe: https:\/\/flow-owner\.flockstackmail\.com\/unsubscribe\?token=/, "with its unsubscribe link");
		assert.match(email.text, /https:\/\/flow-owner\.flockstackmail\.com\/referral\?token=/);
		const message = await m.Message.findOne({ accountId: user.accountId, kind: "referral", email: "ann@example.org" }).lean();
		assert.equal(message.status, "sent");
		assert.equal(message.referralRewardId, user.newsletter.referral.rewards[0].id);
		assert.equal((await m.Account.findById(user.accountId).lean()).usage.emailsSent >= 2, true, "it took room in the plan's month, like the confirmation and welcome emails");

		await signUp(user, "friend2@example.org", { code: codeOf(ann) });
		await confirm(user, "friend2@example.org");
		assert.equal(await counted(user, "ann@example.org"), 2);
		const second = sesEmails.findLast((item) => [item.to].flat().includes("ann@example.org"));
		assert.match(second.text, /That unlocks: The field guide\./);
		assert.match(second.text, /Get your reward \(https:\/\/example\.com\/field-guide\.pdf\)/);
		assert.match(second.text, /That's every reward/);

		await signUp(user, "friend3@example.org", { code: codeOf(ann) });
		const afterThree = sesEmails.length;
		await confirm(user, "friend3@example.org");
		assert.equal(await counted(user, "ann@example.org"), 3);
		assert.equal(sesEmails.slice(afterThree).filter((item) => [item.to].flat().includes("ann@example.org")).length, 0, "no reward at 3, no email");
		assert.equal(await m.ReferralReward.countDocuments({ accountId: user.accountId, contactId: ann._id }), 2);
	});

	test("doesn't count a subscriber who was already on the list, one who signs up twice, or a code that was made up", async () => {
		const user = await program("flow-repeat@example.com");
		const ann = await subscriber(user, "ann@example.org");
		const bob = await subscriber(user, "bob@example.org");
		await subscriber(user, "member@example.org");

		await signUp(user, "member@example.org", { code: codeOf(ann) });
		assert.equal(await m.Referral.countDocuments({ accountId: user.accountId }), 0, "already a subscriber: nobody brought them in");

		await signUp(user, "new1@example.org", { code: codeOf(ann) });
		await signUp(user, "new1@example.org", { code: codeOf(bob) });
		const records = await m.Referral.find({ accountId: user.accountId }).lean();
		assert.equal(records.length, 1);
		assert.equal(String(records[0].referrerId), String(ann._id), "the first referrer keeps it");

		await signUp(user, "new2@example.org", { code: "x".repeat(27) });
		await signUp(user, "new3@example.org", { code: `${codeOf(ann).slice(0, 26)}Z` });
		await signUp(user, "new4@example.org");
		assert.equal(await m.Referral.countDocuments({ accountId: user.accountId }), 1);
		assert.equal((await m.Contact.findOne({ accountId: user.accountId, email: "new2@example.org" }).lean()).status, "pending", "they still signed up");
	});

	test("ignores a code from another newsletter, and does nothing while the program is off or confirmation is", async () => {
		const user = await program("flow-scope@example.com");
		const other = await program("flow-scope-other@example.com");
		const stranger = await subscriber(other, "stranger@example.org");
		await signUp(user, "visitor1@example.org", { code: codeOf(stranger) });
		assert.equal(await m.Referral.countDocuments({ accountId: user.accountId }), 0, "a subscriber of another newsletter");

		const ann = await subscriber(user, "ann@example.org");
		await callApi("PATCH", "/api/v1/referrals/settings", { key: user.key, body: { enabled: false } });
		await signUp(user, "visitor2@example.org", { code: codeOf(ann) });
		assert.equal(await m.Referral.countDocuments({ accountId: user.accountId }), 0, "program off");

		await callApi("PATCH", "/api/v1/referrals/settings", { key: user.key, body: { enabled: true } });
		await signUp(user, "visitor3@example.org", { code: codeOf(ann) });
		assert.equal(await m.Referral.countDocuments({ accountId: user.accountId, status: "pending" }), 1);
		await callApi("PATCH", "/api/v1/newsletters/" + user.newsletterId, { key: user.key, body: { requireConfirmation: false } });
		await confirm(user, "visitor3@example.org");
		assert.equal(await counted(user, "ann@example.org"), 0, "while confirmation is off nothing is credited, and the referral stays pending");
		assert.equal((await referral(user, "visitor3@example.org")).status, "pending");
	});
});

describe("abuse", () => {
	test("a subscriber referring themselves, by their own address or an alias of it, never counts", async () => {
		const user = await program("abuse-self@example.com");
		const ann = await subscriber(user, "ann.smith@gmail.com");
		await signUp(user, "annsmith+two@gmail.com", { code: codeOf(ann) });
		await signUp(user, "a.n.n.smith@googlemail.com", { code: codeOf(ann) });
		const records = await m.Referral.find({ accountId: user.accountId }).lean();
		assert.deepEqual(records.map(({ status, reason }) => [status, reason]), [["rejected", "self"], ["rejected", "self"]]);
		await confirm(user, "annsmith+two@gmail.com");
		assert.equal(await counted(user, "ann.smith@gmail.com"), 0);
	});

	test("one inbox under several aliases counts once for a referrer", async () => {
		const user = await program("abuse-alias@example.com");
		const ann = await subscriber(user, "ann@example.org");
		await signUp(user, "bob@gmail.com", { code: codeOf(ann) });
		await signUp(user, "b.o.b+news@gmail.com", { code: codeOf(ann) });
		await signUp(user, "bob+more@gmail.com", { code: codeOf(ann) });
		assert.deepEqual((await m.Referral.find({ accountId: user.accountId }).sort({ createdAt: 1 }).lean()).map(({ status, reason }) => [status, reason]), [
			["pending", undefined],
			["rejected", "alias"],
			["rejected", "alias"],
		]);
	});

	test("a household can send two, a farm on one network can't send more", async () => {
		const user = await program("abuse-network@example.com");
		const ann = await subscriber(user, "ann@example.org");
		for (const name of ["one", "two", "three", "four"]) await signUp(user, `${name}@example.org`, { code: codeOf(ann), ip: "198.51.100.77" });
		const statuses = (await m.Referral.find({ accountId: user.accountId }).sort({ createdAt: 1 }).lean()).map(({ status, reason }) => [status, reason]);
		assert.deepEqual(statuses, [["pending", undefined], ["pending", undefined], ["rejected", "same_ip"], ["rejected", "same_ip"]]);

		const bob = await subscriber(user, "bob@example.org", { signupIpHash: hashIp("198.51.100.88") });
		await signUp(user, "five@example.org", { code: codeOf(bob), ip: "198.51.100.88" });
		await signUp(user, "six@example.org", { code: codeOf(bob), ip: "198.51.100.88" });
		await signUp(user, "seven@example.org", { code: codeOf(bob), ip: "198.51.100.88" });
		const fromBob = await m.Referral.find({ accountId: user.accountId, referrerId: bob._id }).sort({ createdAt: 1 }).lean();
		assert.deepEqual(fromBob.map(({ status, reason }) => [status, reason]), [["pending", undefined], ["rejected", "same_ip"], ["rejected", "same_ip"]], "the referrer's own signup counts as one from their network");
	});

	test("floods are rate limited, from one network and for one referrer", async () => {
		const user = await program("abuse-flood@example.com");
		const referrers = await Promise.all(["a", "b", "c", "d"].map((name) => subscriber(user, `${name}@example.org`)));
		for (const [index, referrer] of referrers.entries()) await signUp(user, `visitor${index}@example.org`, { code: codeOf(referrer), ip: "198.51.100.200" });
		const byNetwork = await m.Referral.find({ accountId: user.accountId }).sort({ createdAt: 1 }).lean();
		assert.deepEqual(byNetwork.map(({ status, reason }) => [status, reason]), [["pending", undefined], ["pending", undefined], ["pending", undefined], ["rejected", "rate_limited"]], "3 a day from a network, whoever it refers");

		const popular = await subscriber(user, "popular@example.org");
		for (let hit = 0; hit < 30; hit += 1) await m.rateLimit.isRateLimited({ name: "referral-referrer", limit: 30, window: "1 d", key: String(popular._id) });
		await signUp(user, "late@example.org", { code: codeOf(popular), ip: "198.51.100.201" });
		assert.equal((await referral(user, "late@example.org")).reason, "rate_limited");
		assert.equal((await m.Contact.findOne({ accountId: user.accountId, email: "late@example.org" }).lean()).status, "pending", "they can still join");
	});

	test("an address on the suppression list, a referrer who left, and one who never confirms don't count", async () => {
		const user = await program("abuse-lists@example.com");
		const ann = await subscriber(user, "ann@example.org");
		await signUp(user, "listed@example.org", { code: codeOf(ann) });
		await m.Suppression.create({ accountId: user.accountId, email: "listed@example.org", reason: "bounce" });
		await confirm(user, "listed@example.org");
		assert.deepEqual([(await referral(user, "listed@example.org")).status, (await referral(user, "listed@example.org")).reason], ["rejected", "suppressed"]);

		await m.Suppression.create({ accountId: user.accountId, email: "bounced@example.org", reason: "bounce" });
		await signUp(user, "bounced@example.org", { code: codeOf(ann) });
		assert.equal(await referral(user, "bounced@example.org"), null, "already suppressed when they sign up: not even pending");

		await signUp(user, "waits@example.org", { code: codeOf(ann) });
		await signUp(user, "left@example.org", { code: codeOf(ann) });
		await m.Contact.updateOne({ accountId: user.accountId, _id: ann._id }, { $set: { status: "unsubscribed" } });
		await confirm(user, "left@example.org");
		assert.equal((await referral(user, "left@example.org")).reason, "referrer_unavailable");
		assert.equal((await referral(user, "waits@example.org")).status, "pending");
		assert.equal(await counted(user, "ann@example.org"), 0);
	});
});

describe("reward emails", () => {
	test("follow the sending rules: nothing from a blocked account or to an address that left, and none once the month's emails are used up", async () => {
		const user = await program("rules-owner@example.com", { emails: 100 });
		const ann = await subscriber(user, "ann@example.org");
		const bob = await subscriber(user, "bob@example.org");
		const cat = await subscriber(user, "cat@example.org");

		await signUp(user, "r1@example.org", { code: codeOf(ann) });
		await m.Suppression.create({ accountId: user.accountId, email: "ann@example.org", reason: "manual" });
		const before = sesEmails.length;
		await confirm(user, "r1@example.org");
		assert.equal(await counted(user, "ann@example.org"), 1, "it still counts");
		assert.equal(sesEmails.slice(before).filter((item) => [item.to].flat().includes("ann@example.org")).length, 0, "no email to a suppressed address");
		assert.equal(await m.ReferralReward.countDocuments({ accountId: user.accountId, contactId: ann._id }), 1);

		await signUp(user, "r2@example.org", { code: codeOf(bob) });
		await m.blocks.blockAccount(user.accountId, { reason: "an admin", by: "admin" });
		const blockedAt = sesEmails.length;
		await confirm(user, "r2@example.org");
		assert.equal(sesEmails.slice(blockedAt).length, 0, "a blocked account sends nothing");
		assert.equal(await counted(user, "bob@example.org"), 1);
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId, kind: "referral", contactId: bob._id }), 0);
		await m.Account.updateOne({ _id: user.accountId }, { $set: { status: "active" }, $unset: { pausedAt: 1, pauseReason: 1, pausedBy: 1 } });

		await signUp(user, "r3@example.org", { code: codeOf(cat) });
		await m.Account.updateOne({ _id: user.accountId }, { $set: { "usage.emailsSent": 100 } });
		await confirm(user, "r3@example.org");
		assert.equal(await counted(user, "cat@example.org"), 1);
		const skipped = await m.Message.findOne({ accountId: user.accountId, kind: "referral", contactId: cat._id }).lean();
		assert.deepEqual([skipped.status, skipped.error], ["skipped", "This month's emails are used up"]);
	});

	test("go out once, even when two referrals are credited at the same time", async () => {
		const user = await program("rules-race@example.com", { rewards: [{ referrals: 2, title: "Race prize", text: "Yours" }] });
		const ann = await subscriber(user, "ann@example.org");
		for (const name of ["x1", "x2"]) await signUp(user, `${name}@example.org`, { code: codeOf(ann) });
		const before = sesEmails.length;
		await Promise.all(["x1", "x2"].map((name) => confirm(user, `${name}@example.org`)));
		assert.equal(await counted(user, "ann@example.org"), 2);
		assert.equal(await m.ReferralReward.countDocuments({ accountId: user.accountId, contactId: ann._id }), 1);
		assert.equal(sesEmails.slice(before).filter((item) => [item.to].flat().includes("ann@example.org")).length, 1);
	});
});

describe("merge tags in issues", () => {
	const contact = { _id: "6650f1c2e9b1d4a012345678", email: "ann@example.org", referral: { count: 4 } };

	function render(newsletter, campaign, who = contact) {
		return m.sendingRules.buildRecipientEmail({ campaign, newsletter, contact: who, messageId: "6650f1c2e9b1d4a0aaaaaaaa", sender: {} });
	}

	test("give each subscriber their own link and count, in rich, HTML and Markdown issues, and the link is tracked", async () => {
		const user = await program("tags-owner@example.com");
		const link = getReferralLink(user.newsletter, contact._id);
		const campaigns = {
			rich: { format: "rich", subject: "Hi", html: `<p>Share: <a href="${REFERRAL_LINK_TAG}">your link</a>. ${REFERRAL_COUNT_TAG} so far. Plain: ${REFERRAL_LINK_TAG}</p>` },
			html: { format: "html", subject: "Hi", html: `<html><body><p>You have referred ${REFERRAL_COUNT_TAG}: <a href="${REFERRAL_LINK_TAG}">go</a></p></body></html>` },
			markdown: { format: "markdown", subject: "Hi", markdown: `[Share](${REFERRAL_LINK_TAG}) — ${REFERRAL_COUNT_TAG} so far` },
		};
		for (const [format, campaign] of Object.entries(campaigns)) {
			const email = render(user.newsletter, campaign);
			assert.doesNotMatch(email.html, /referral_link|referral_count|%7B%7B/, format);
			assert.match(email.html, /\/c\/[0-9a-f]{24}\.[A-Za-z0-9_-]{22}\./, `${format}: links go through the click tracker`);
			const tracked = [...email.html.matchAll(/\/c\/[0-9a-f]{24}\.[A-Za-z0-9_-]{22}\.(?:\d+\.)?([A-Za-z0-9_-]+)/g)].map(([, encoded]) => Buffer.from(encoded, "base64url").toString());
			assert.ok(tracked.includes(link), `${format}: ${tracked.join(" ")}`);
			assert.match(email.html, /\b4\b/, `${format}: the count`);
			assert.doesNotMatch(email.text, /referral_/, format);
		}
		const other = render(user.newsletter, campaigns.rich, { _id: "6650f1c2e9b1d4a012345679", email: "bob@example.org" });
		assert.match(other.text, /Plain: https:\/\/tags-owner\.flockstackmail\.com\/\?ref=/);
		assert.notEqual(other.text, render(user.newsletter, campaigns.rich).text);
		assert.match(other.text, /0 so far/);
	});

	test("work next to a reader's own merge tags, and leave the billing link of a paid reader alone", async () => {
		const user = await program("tags-merge@example.com");
		const campaign = { format: "markdown", subject: "Hi {{first_name|friend}}", markdown: `Hello {{first_name|there}}, share ${REFERRAL_LINK_TAG} ({{referral_count}})` };
		const paid = { ...contact, fields: { first_name: "Ann" }, tier: "paid", paidUntil: new Date(Date.now() + 864e5), stripeCustomerId: "cus_merge" };
		const email = render(user.newsletter, campaign, paid);
		assert.equal(email.subject, "Hi Ann");
		assert.match(email.text, /Hello Ann, share https:\/\/tags-merge\.flockstackmail\.com\/\?ref=\S+ \(4\)/);
		assert.match(email.text, /Manage your subscription: https?:\/\//);
		assert.doesNotMatch(`${email.html}${email.text}`, /\{\{|%7B%7B/);
		assert.match(render(user.newsletter, campaign).subject, /^Hi friend$/);
	});

	test("link to the website when the program is off, and the web page shows no raw tag", async () => {
		const user = await program("tags-off@example.com", { enabled: false });
		const email = render(user.newsletter, { format: "rich", subject: "Hi", html: `<p>${REFERRAL_LINK_TAG}</p>` });
		assert.match(email.text, /https:\/\/tags-off\.flockstackmail\.com\//);
		assert.doesNotMatch(email.text, /\?ref=/);

		const campaign = { format: "rich", subject: "Hi", html: `<p><a href="${REFERRAL_LINK_TAG}">Share</a> ${REFERRAL_COUNT_TAG}</p>` };
		assert.match(m.archiveContent.renderIssueBody(campaign).html, /<a href="#">Share<\/a> 0/);
		assert.match(m.archiveContent.renderIssueBody(campaign, { referralLink: "https://x.test/#subscribe" }).html, /href="https:\/\/x\.test\/#subscribe"/);
		assert.match(m.archiveContent.renderIssueBody(campaign, { referralLink: null }).html, /href="\{\{referral_link\}\}"/, "an export keeps the source");
	});
});

describe("a subscriber's page", () => {
	const render = async (token) => renderToStaticMarkup(createElement(m.TooltipProvider, null, await anonymous(() => m.referralPage({ searchParams: Promise.resolve({ token }) }))));

	test("shows their link, count, and the rewards they reached, and keeps the others locked", async () => {
		const user = await program("page-owner@example.com");
		const ann = await subscriber(user, "ann@example.org", { referral: { count: 1 } });
		const token = createReferralPageToken({ contactId: ann._id, newsletterId: user.newsletterId });
		const html = await render(token);
		assert.ok(html.includes(getReferralLink(user.newsletter, ann._id)), "their link");
		assert.match(html, /Share page-owner news/);
		assert.match(html, /1 more referral unlocks The field guide/);
		assert.match(html, /Reply with the word FLOCK for a surprise\./, "the reward they unlocked");
		assert.match(html, /Locked until you reach 2 referrals/);
		assert.doesNotMatch(html, /field-guide\.pdf/, "the locked reward's link isn't in the page");

		await m.Contact.updateOne({ accountId: user.accountId, _id: ann._id }, { $set: { "referral.count": 2 } });
		const unlocked = await render(token);
		assert.match(unlocked, /href="https:\/\/example\.com\/field-guide\.pdf"/);
		assert.match(unlocked, /You&#x27;ve unlocked every reward\./);
	});

	test("says what's left to the next reward in the plural, on the page and in the reward email", async () => {
		const rewards = [
			{ referrals: 1, title: "A thank you", text: "Thanks." },
			{ referrals: 5, title: "The field guide", url: "https://example.com/field-guide.pdf" },
		];
		const user = await program("page-plural@example.com", { rewards });
		const ann = await subscriber(user, "plural@example.org", { referral: { count: 1 } });
		const html = await render(createReferralPageToken({ contactId: ann._id, newsletterId: user.newsletterId }));
		assert.match(html, /4 more referrals unlock The field guide\./);
		assert.match(html, /role="progressbar" aria-label="Progress to the next reward"/);
		const email = getRewardEmail({ newsletter: user.newsletter, reward: user.newsletter.referral.rewards[0], count: 1, pageUrl: "https://example.com/r" });
		assert.match(email.markdown, /4 more referrals unlock The field guide\./);
	});

	test("answers a forged link, an unsubscribed subscriber and a newsletter without the program", async () => {
		const user = await program("page-closed@example.com");
		const ann = await subscriber(user, "ann@example.org");
		const token = createReferralPageToken({ contactId: ann._id, newsletterId: user.newsletterId });
		assert.match(await render(`${token}x`), /This link doesn&#x27;t work/);
		assert.match(await render(undefined), /This link doesn&#x27;t work/);
		await m.Contact.updateOne({ accountId: user.accountId, _id: ann._id }, { $set: { status: "unsubscribed" } });
		assert.match(await render(token), /Referrals are off/);
		await m.Contact.updateOne({ accountId: user.accountId, _id: ann._id }, { $set: { status: "active" } });
		await callApi("PATCH", "/api/v1/referrals/settings", { key: user.key, body: { enabled: false } });
		assert.match(await render(token), /Referrals are off/);
	});

	test("opens on the newsletter's own host without a session", async () => {
		const url = `https://weekly.${SHARED_DOMAIN}/referral?token=abc`;
		const response = await m.proxy(new m.NextRequest(url, { headers: { host: new URL(url).host } }));
		assert.equal(response.headers.get("x-middleware-next"), "1");
		const app = await m.proxy(new m.NextRequest("http://localhost:3000/referral?token=abc", { headers: { host: "localhost:3000" } }));
		assert.equal(app.headers.get("x-middleware-next"), "1", "and on the app's domain");
	});
});

describe("the dashboard and the API", () => {
	test("rank the referrers, list every referral with why one was rejected, and page through them", async () => {
		const user = await program("board-owner@example.com");
		const ann = await subscriber(user, "ann@example.org");
		const bob = await subscriber(user, "bob@example.org");
		for (const name of ["a1", "a2", "a3"]) {
			await signUp(user, `${name}@example.org`, { code: codeOf(ann) });
			await confirm(user, `${name}@example.org`);
		}
		await signUp(user, "b1@example.org", { code: codeOf(bob) });
		await confirm(user, "b1@example.org");
		await signUp(user, "p1@example.org", { code: codeOf(bob) });
		await signUp(user, "ann+x@example.org", { code: codeOf(ann) });
		await m.Contact.updateOne({ accountId: user.accountId, _id: bob._id }, { $set: { status: "unsubscribed" } });

		const board = await callApi("GET", "/api/v1/referrals/leaderboard", { key: user.key });
		assert.deepEqual(board.body.referrers.map(({ email, referrals }) => [email, referrals]), [["ann@example.org", 3], ["bob@example.org", 1]]);
		assert.deepEqual(board.body.totals, { credited: 4, pending: 2, rejected: 0, referrers: 2 });

		const all = await callApi("GET", "/api/v1/referrals?limit=3", { key: user.key });
		assert.equal(all.body.referrals.length, 3);
		assert.ok(all.body.nextCursor);
		const rest = await callApi("GET", `/api/v1/referrals?limit=3&cursor=${all.body.nextCursor}`, { key: user.key });
		assert.equal(rest.body.referrals.length, 3);
		assert.equal(rest.body.nextCursor, null);
		assert.equal(new Set([...all.body.referrals, ...rest.body.referrals].map(({ id }) => id)).size, 6);

		const pending = await callApi("GET", "/api/v1/referrals?status=pending", { key: user.key });
		assert.deepEqual(pending.body.referrals.map(({ referred, referrer }) => [referred.email, referrer.email]), [["ann+x@example.org", "ann@example.org"], ["p1@example.org", "bob@example.org"]], "newest first");
		const byReferrer = await callApi("GET", `/api/v1/referrals?referrer=${ann._id}`, { key: user.key });
		assert.equal(byReferrer.body.referrals.length, 4);
		assert.equal((await callApi("GET", "/api/v1/referrals?referrer=nope", { key: user.key })).status, 400);
		assert.equal((await callApi("GET", "/api/v1/referrals?status=rejected", { key: user.key })).body.referrals.length, 0);
	});

	test("show the leaderboard and what didn't count on the page", async () => {
		const user = await program("board-page@example.com");
		const ann = await subscriber(user, "ann.lee@gmail.com");
		await signUp(user, "annlee+self@gmail.com", { code: codeOf(ann) });
		await m.Contact.updateOne({ accountId: user.accountId, _id: ann._id }, { $set: { "referral.count": 5 } });
		const html = await as(user, async () => renderToStaticMarkup(createElement(m.TooltipProvider, null, await m.referralsPage.default())));
		assert.match(html, /Leaderboard/);
		assert.match(html, /ann\.lee@gmail\.com/);
		assert.match(html, /Referrals that didn&#x27;t count/);
		assert.match(html, /annlee\+self@gmail\.com/);
		assert.match(html, /same inbox/);
		assert.match(html, /Add reward/);
	});

	test("credit a signup through the API with the referral code of a form of your own", async () => {
		const user = await program("api-owner@example.com");
		const ann = await subscriber(user, "ann@example.org");
		const response = await callApi("POST", "/api/v1/contacts", { key: user.key, body: { newsletter: user.slug, email: "viaapi@example.org", ip: "203.0.113.150", referral: codeOf(ann) } });
		assert.equal(response.status, 201, JSON.stringify(response.body));
		await flushAfter();
		assert.equal((await referral(user, "viaapi@example.org")).status, "pending");
		await confirm(user, "viaapi@example.org");
		assert.equal(await counted(user, "ann@example.org"), 1);
	});
});

describe("the signup form", () => {
	async function withBrowser(search, run) {
		const store = new Map();
		const previous = { window: globalThis.window, localStorage: globalThis.localStorage };
		globalThis.window = { location: { search } };
		globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
		try {
			return await run(store);
		} finally {
			for (const [name, value] of Object.entries(previous)) {
				if (value === undefined) delete globalThis[name];
				else globalThis[name] = value;
			}
		}
	}

	test("keeps the code a visitor arrived with for the pages they read next, for 30 days", async () => {
		const { captureReferralCode, referralKey } = await import("../lib/storage.js");
		const code = createReferralCode("6650f1c2e9b1d4a012345678");
		await withBrowser(`?utm=x&ref=${code}`, (store) => {
			assert.equal(captureReferralCode("weekly"), code);
			assert.equal(JSON.parse(store.get(referralKey("weekly"))).code, code);
			globalThis.window.location.search = "";
			assert.equal(captureReferralCode("weekly"), code, "an issue page without ?ref=");
			assert.equal(captureReferralCode("monthly"), "", "another newsletter's form");
			store.set(referralKey("weekly"), JSON.stringify({ code, at: Date.now() - 31 * 86_400_000 }));
			assert.equal(captureReferralCode("weekly"), "", "after 30 days");
		});
		await withBrowser("?ref=not-a-code", () => assert.equal(captureReferralCode("weekly"), ""));
	});

	test("carries the code in a hidden field of the form", async () => {
		const FormSubscribe = (await import("../components/FormSubscribe.jsx")).default;
		const html = renderToStaticMarkup(createElement(FormSubscribe, { newsletterSlug: "weekly" }));
		assert.match(html, /<input type="hidden" name="ref" value=""\/>/);
	});
});
