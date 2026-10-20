import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "@/lib/docdb";
import { activate, platformEmails, signIn, startTestApp } from "./helpers/app.mjs";
import { associateTenantResources, calls as sesCalls, leaseIp, sent, state as ses } from "./stubs/ses.mjs";
import { IP_WARMUP, getShareForDay, getWarmupSchedule, isRoutedToDedicatedIp, judgeWarmupStep, pickConfigurationSet } from "../lib/ip-warmup-rules.js";
import { WATCH } from "../lib/config.js";

// The warm-up FlockStack runs itself on standard dedicated IPs: the ramp, the per-message route, and the hourly job that
// moves it a day on.
const HOUR = 3_600_000;
let app;
let m;
let provider;

before(async () => {
	app = await startTestApp({ ADMIN_EMAILS: "ops@example.com" });
	m = {
		inventory: await import("../lib/ip-inventory.js"),
		warmup: await import("../lib/ip-warmup.js"),
		Account: (await import("../models/Account.js")).default,
		DedicatedIp: (await import("../models/DedicatedIp.js")).default,
		Message: (await import("../models/Message.js")).default,
	};
	provider = (await import("../lib/email-provider/index.js")).getEmailProvider();
});

after(() => app?.stop());

describe("the ramp", () => {
	test("30 days from 2% to 100% of the account's email, never falling, in steps no bigger than 13 points", () => {
		const schedule = getWarmupSchedule();
		assert.equal(schedule.length, IP_WARMUP.days);
		assert.deepEqual([schedule[0], schedule.at(-1)], [{ day: 1, share: 2 }, { day: 30, share: 100 }]);
		for (let index = 1; index < schedule.length; index++) {
			const step = schedule[index].share - schedule[index - 1].share;
			assert.ok(step >= 0 && step < 13, `day ${schedule[index].day} steps ${step}`);
		}
		assert.deepEqual([getShareForDay(0), getShareForDay(9), getShareForDay(31)], [0, 5.9, 100], "a day before the start is none, day 9 is under a tenth, past the end is all");
		assert.ok(getShareForDay(15) < 15 && getShareForDay(25) < 55, "most of the climb is in the last third, as a warm-up should");
	});

	test("a message takes the same route every time, and as the share grows it only ever moves towards the IP", () => {
		for (const id of ["6900000000000000000000aa", "6900000000000000000000ab", "x"]) {
			for (const share of [2, 35, 99.5]) assert.equal(isRoutedToDedicatedIp(id, share), isRoutedToDedicatedIp(id, share));
		}
		assert.equal(isRoutedToDedicatedIp("anything", 0), false);
		assert.equal(isRoutedToDedicatedIp("anything", 100), true);
		for (let index = 0; index < 5000; index++) {
			const id = new mongoose.Types.ObjectId();
			if (isRoutedToDedicatedIp(id, 10)) assert.equal(isRoutedToDedicatedIp(id, 35), true, "in at 10% means in at 35%");
		}
	});

	test("over 100,000 ids the share that goes through the IP is the share asked for", () => {
		const ids = Array.from({ length: 100_000 }, () => String(new mongoose.Types.ObjectId()));
		for (const share of [2, 10, 35, 60, 90]) {
			const routed = ids.filter((id) => isRoutedToDedicatedIp(id, share)).length / ids.length;
			assert.ok(Math.abs(routed - share / 100) < 0.006, `${share}% asked, ${(routed * 100).toFixed(2)}% routed`);
		}
	});

	test("the configuration set: the account's own while no IP is set up, the IP's for its share, all of it once warmed up", () => {
		const tenant = { configurationSet: "mc-1", dedicatedConfigurationSet: "mc-1-ip", ipWarmup: { share: 40 } };
		assert.deepEqual(pickConfigurationSet({ configurationSet: "mc-1" }, "a"), { configurationSet: "mc-1", isDedicated: false });
		assert.deepEqual(pickConfigurationSet({ ...tenant, dedicatedConfigurationSet: undefined }, "a"), { configurationSet: "mc-1", isDedicated: false });
		assert.deepEqual(pickConfigurationSet({ ...tenant, ipWarmup: undefined }, "a"), { configurationSet: "mc-1", isDedicated: false }, "routing off while the warm-up is gone");
		const routes = new Set(Array.from({ length: 200 }, (_, index) => pickConfigurationSet(tenant, `id${index}`).configurationSet));
		assert.deepEqual([...routes].toSorted(), ["mc-1", "mc-1-ip"]);
		assert.equal(pickConfigurationSet({ ...tenant, ipWarmup: { share: 40, completedAt: new Date() } }, "a").configurationSet, "mc-1-ip");
	});
});

describe("a day of the warm-up", () => {
	const now = new Date("2026-11-01T12:00:00Z");
	const warmup = { startedAt: new Date(now.getTime() - 40 * HOUR), advancedAt: new Date(now.getTime() - 25 * HOUR), day: 3 };
	const clean = { sent: 1000, bounced: 5, complained: 0 };

	test("advances once the day is over, rates are under the watch level and the account sent enough", () => {
		assert.deepEqual(judgeWarmupStep({ warmup, counts: clean, emailsLastDay: 500, now }), { action: "advance", reason: "" });
	});

	test("waits while the day isn't over, so running the job often counts nothing twice", () => {
		const recent = { ...warmup, advancedAt: new Date(now.getTime() - 5 * HOUR) };
		assert.equal(judgeWarmupStep({ warmup: recent, counts: clean, emailsLastDay: 500, now }).action, "wait");
		assert.equal(judgeWarmupStep({ warmup: { ...warmup, completedAt: now }, counts: clean, emailsLastDay: 500, now }).action, "wait", "a finished warm-up has no days");
	});

	test("holds the day when bounces or complaints are above the watch level, the account is paused or it sent too little", () => {
		const bounced = { sent: 1000, bounced: Math.ceil(WATCH.bounceRate * 1000) + 5, complained: 0 };
		assert.match(judgeWarmupStep({ warmup, counts: bounced, emailsLastDay: 500, now }).reason, /bounces are above the watch level/);
		const complained = { sent: 10_000, bounced: 0, complained: Math.ceil(WATCH.complaintRate * 10_000) + 3 };
		assert.match(judgeWarmupStep({ warmup, counts: complained, emailsLastDay: 500, now }).reason, /complaints are above/);
		assert.equal(judgeWarmupStep({ warmup, counts: clean, emailsLastDay: 500, isPaused: true, now }).action, "hold");
		assert.match(judgeWarmupStep({ warmup, counts: clean, emailsLastDay: IP_WARMUP.minDailyEmails - 1, now }).reason, /too little/);
		assert.equal(judgeWarmupStep({ warmup, counts: { sent: 20, bounced: 2, complained: 0 }, emailsLastDay: 500, now }).action, "advance", "a couple of bounces on a tiny count aren't a rate");
	});
});

// A Pro account with a free IP, as the add-on or an admin leaves it.
let nextIp = 40;
async function warmingAccount(name) {
	const ip = `198.51.100.${nextIp++}`;
	leaseIp(ip);
	await m.inventory.addIp({ ip });
	const user = await signIn(`${name}@example.com`);
	await activate(user, { plan: "pro" });
	const result = await provider.setDedicatedIp(user.accountId, true);
	assert.deepEqual(result, { status: "assigned", ip });
	user.ip = ip;
	return user;
}

const account = (user) => m.Account.findById(user.accountId).lean();

// Emails the account sent a minute ago, some bounced.
async function recentSends(user, count, bounced = 0) {
	await m.Message.insertMany(
		Array.from({ length: count }, (_, index) => ({
			kind: "campaign",
			accountId: user.accountId,
			newsletterId: new mongoose.Types.ObjectId(),
			campaignId: new mongoose.Types.ObjectId(),
			contactId: new mongoose.Types.ObjectId(),
			email: `r${index}-${user.accountId}@example.org`,
			status: index < bounced ? "bounced" : "delivered",
			sentAt: new Date(Date.now() - 60_000),
			deliveredAt: new Date(Date.now() - 50_000),
			...(index < bounced && { bouncedAt: new Date(Date.now() - 40_000) }),
		}))
	);
}

async function dayOver(user, hours = 25) {
	await m.Account.updateOne({ _id: user.accountId }, { $set: { "ses.ipWarmup.advancedAt": new Date(Date.now() - hours * HOUR) } });
}

describe("the hourly job", () => {
	test("moves a warm-up a day on once a day, and running it again the same hour changes nothing", async () => {
		const user = await warmingAccount("job-advance");
		await recentSends(user, 60);
		assert.deepEqual(await m.warmup.advanceIpWarmups(), { advanced: 0, held: 0, completed: 0 }, "day 1 isn't over");
		await dayOver(user);
		assert.deepEqual(await m.warmup.advanceIpWarmups(), { advanced: 1, held: 0, completed: 0 });
		let current = await account(user);
		assert.deepEqual([current.ses.ipWarmup.day, current.ses.ipWarmup.share], [2, 2.3]);
		assert.deepEqual(await m.warmup.advanceIpWarmups(), { advanced: 0, held: 0, completed: 0 });
		current = await account(user);
		assert.equal(current.ses.ipWarmup.day, 2, "the same day is counted once");
	});

	test("holds the day while bounces are above the watch level, then goes on when they are under it", async () => {
		const user = await warmingAccount("job-hold");
		await recentSends(user, 100, 10);
		await dayOver(user);
		assert.deepEqual(await m.warmup.advanceIpWarmups(), { advanced: 0, held: 1, completed: 0 });
		let current = await account(user);
		assert.deepEqual([current.ses.ipWarmup.day, current.ses.ipWarmup.share, current.ses.ipWarmup.holds], [1, 2, 1]);
		assert.match(current.ses.ipWarmup.holdReason, /bounces are above the watch level/);
		assert.ok(current.ses.ipWarmup.heldAt);
		assert.deepEqual(await m.warmup.advanceIpWarmups(), { advanced: 0, held: 0, completed: 0 }, "a hold is a day too: it isn't counted twice");

		await m.Message.updateMany({ accountId: user.accountId }, { $unset: { bouncedAt: 1 }, $set: { status: "delivered" } });
		await dayOver(user);
		assert.deepEqual(await m.warmup.advanceIpWarmups(), { advanced: 1, held: 0, completed: 0 });
		current = await account(user);
		assert.deepEqual([current.ses.ipWarmup.day, current.ses.ipWarmup.holdReason, current.ses.ipWarmup.holds], [2, undefined, 1]);
	});

	test("holds the day for an account that sent too little to warm an IP, and for one that is blocked", async () => {
		const quiet = await warmingAccount("job-quiet");
		await dayOver(quiet);
		const blocked = await warmingAccount("job-blocked");
		await recentSends(blocked, 80);
		await m.Account.updateOne({ _id: blocked.accountId }, { $set: { status: "paused", pausedBy: "admin" } });
		await dayOver(blocked);
		const result = await m.warmup.advanceIpWarmups();
		assert.equal(result.held >= 2, true);
		assert.match((await account(quiet)).ses.ipWarmup.holdReason, /too little/);
		assert.match((await account(blocked)).ses.ipWarmup.holdReason, /paused/);
		assert.equal((await account(quiet)).ses.ipWarmup.day, 1);
	});

	test("the 30th day completes it: the IP is warmed up, all of the email goes through it, and the owner is told", async () => {
		const user = await warmingAccount("job-complete");
		await recentSends(user, 60);
		for (let day = 2; day <= IP_WARMUP.days; day++) {
			await dayOver(user);
			await m.warmup.advanceIpWarmups();
			assert.equal((await account(user)).ses.ipWarmup.day, day);
		}
		const current = await account(user);
		assert.deepEqual([current.ses.ipWarmup.share, Boolean(current.ses.ipWarmup.completedAt)], [100, true]);
		assert.equal((await m.DedicatedIp.findOne({ ip: user.ip }).lean()).state, "assigned");
		const mail = platformEmails.findLast(({ subject }) => subject === "Your dedicated IP is warmed up");
		assert.ok(mail?.to.includes("job-complete@example.com"));
		await dayOver(user);
		assert.deepEqual(await m.warmup.advanceIpWarmups(), { advanced: 0, held: 0, completed: 0 }, "nothing is left to count");
		assert.equal(pickConfigurationSet(current.ses, "any-id").isDedicated, true);
	});
});

describe("sending", () => {
	const email = (id) => ({ from: "Reader <hello@news.example.org>", to: `r-${id}@example.org`, subject: "Hi", html: "<p>Hi</p>", text: "Hi", headers: {} });

	async function send(user, id) {
		const current = await account(user);
		const tenant = await provider.ensureTenant(current);
		return provider.sendEmail({ tenant, message: { _id: id, accountId: user.accountId, kind: "campaign" }, email: email(id), feedbackId: "f:1" });
	}

	test("each email takes one of the account's two configuration sets by its id: the IP's share through the pool, the rest shared, and a retry the same", async () => {
		const user = await warmingAccount("send-split");
		const current = await account(user);
		await associateTenantResources(current.ses.tenantName, { identities: ["news.example.org"] });
		await m.Account.updateOne({ _id: user.accountId }, { $set: { "ses.ipWarmup.share": 35, "ses.ipWarmup.day": 22 } });
		const dedicatedSet = current.ses.dedicatedConfigurationSet;
		const before = sent.length;
		const ids = Array.from({ length: 2000 }, () => new mongoose.Types.ObjectId());
		for (const id of ids) await send(user, id);
		const routes = sent.slice(before).map(({ configurationSet }) => configurationSet);
		const viaIp = routes.filter((set) => set === dedicatedSet).length / routes.length;
		assert.ok(Math.abs(viaIp - 0.35) < 0.04, `35% asked, ${(viaIp * 100).toFixed(1)}% through the IP`);
		assert.equal(routes.filter((set) => set !== dedicatedSet && set !== current.ses.configurationSet).length, 0);
		assert.equal(ses.configurationSetPools.get(dedicatedSet), `mc-ip-${user.accountId}`, "the IP's set sends from the account's pool");
		assert.equal(ses.configurationSetPools.has(current.ses.configurationSet), false, "the other from shared IPs");

		const again = sent.length;
		for (const id of ids.slice(0, 200)) await send(user, id);
		assert.deepEqual(sent.slice(again).map(({ configurationSet }) => configurationSet), routes.slice(0, 200), "a retry takes the first try's route");
	});

	test("an email the IP's set refuses, as when the IP is taken away mid-batch, goes out through shared IPs instead", async () => {
		const user = await warmingAccount("send-fallback");
		const current = await account(user);
		await associateTenantResources(current.ses.tenantName, { identities: ["news.example.org"] });
		await m.Account.updateOne({ _id: user.accountId }, { $set: { "ses.ipWarmup.completedAt": new Date(), "ses.ipWarmup.share": 100 } });
		const id = new mongoose.Types.ObjectId();
		ses.failNext = { name: "sendSesEmail", error: Object.assign(new Error("pool is gone"), { name: "NotFoundException" }) };
		const before = sent.length;
		await send(user, id);
		assert.deepEqual(sent.slice(before).map(({ configurationSet }) => configurationSet), [current.ses.configurationSet]);
		ses.failNext = { name: "sendSesEmail", error: Object.assign(new Error("throttled"), { name: "TooManyRequestsException" }) };
		await assert.rejects(() => send(user, new mongoose.Types.ObjectId()), /throttled/, "other errors are the sender's retry to handle");
		assert.equal(sesCalls.length > 0, true);
	});

	test("an account without an IP sends from its own set, as before", async () => {
		const user = await signIn("send-plain@example.com");
		await activate(user, { plan: "pro" });
		const current = await provider.ensureTenant(await account(user));
		await associateTenantResources(current.tenantName, { identities: ["news.example.org"] });
		const before = sent.length;
		await send(user, new mongoose.Types.ObjectId());
		assert.equal(sent.at(-1).configurationSet, current.configurationSet);
		assert.equal(sent.length, before + 1);
	});
});
