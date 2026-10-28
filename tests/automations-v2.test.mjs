import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
	MAX_TOTAL_STEPS,
	checkSteps,
	countSteps,
	describeStep,
	describeTrigger,
	findStepSegmentIds,
	getSplitSeed,
	getWaitUntil,
	hashToUnit,
	indexSteps,
	listSteps,
	nextStep,
	pickSplitPath,
	toStepOutput,
} from "../lib/automation-rules.js";
import { AUTOMATION_TEMPLATES } from "../lib/automation-templates.js";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

let t;
let m;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

before(async () => {
	t = await setupAudienceTests();
	m = {
		automations: await import("../lib/automations.js"),
		triggers: await import("../lib/automation-triggers.js"),
		linkClicks: await import("../lib/link-clicks.js"),
		referrals: await import("../lib/referrals.js"),
		Automation: (await import("../models/Automation.js")).default,
		Enrollment: (await import("../models/AutomationEnrollment.js")).default,
		Watch: (await import("../models/AutomationWatch.js")).default,
		CampaignLink: (await import("../models/CampaignLink.js")).default,
		Referral: (await import("../models/Referral.js")).default,
		WebhookDelivery: (await import("../models/WebhookDelivery.js")).default,
	};
});

after(() => t?.app.stop());

const tagStep = (tag) => ({ type: "add_tag", tag });
const run = (now = new Date()) => m.automations.runAutomations({ now });
const later = (ms) => new Date(Date.now() + ms);

async function customer(email, options) {
	const user = await t.customer(email, options);
	user.address = (name) => `${name}@${user.slug}.example.org`;
	return user;
}

describe("steps as a tree", () => {
	const TREE = [
		{ type: "email", subject: "Hi", content: "Body" },
		{
			type: "branch",
			condition: { match: "all", conditions: [{ type: "tag", value: "vip" }] },
			paths: [
				{ name: "VIPs", steps: [{ type: "wait", weekday: "friday", time: "10:30", timeZone: "Europe/Paris" }, { type: "set_field", field: "plan", value: "pro" }] },
				{
					steps: [
						{
							type: "split",
							seed: "launch",
							paths: [
								{ percent: 70, steps: [tagStep("a")] },
								{ percent: 30, steps: [{ type: "webhook", name: "crm" }, { type: "move", automation: "6650f1c2e9b1d4a012345678" }] },
							],
						},
					],
				},
			],
		},
	];

	test("keep every step's ID, nested ones included, when the steps are sent back as they were shown", () => {
		const { steps } = checkSteps(TREE);
		const ids = listSteps(steps).map(({ step }) => step.id);
		assert.equal(ids.length, 8);
		assert.equal(new Set(ids).size, 8, "each step has an ID of its own");
		assert.ok(ids.every((id) => /^[a-f0-9]{10}$/.test(id)));

		const shown = steps.map(toStepOutput);
		const again = checkSteps(shown).steps;
		assert.deepEqual(again, steps, "what was shown and sent back is what was stored");
		assert.deepEqual(listSteps(again).map(({ step }) => step.id), ids);

		// An insert, a removal and a move around them change nothing for the steps that stay.
		const edited = structuredClone(shown);
		edited[1].paths[0].steps.unshift({ type: "add_tag", tag: "new" });
		edited[1].paths[1].steps[0].paths[0].steps = [];
		const after = checkSteps(edited).steps;
		const kept = listSteps(after).map(({ step }) => step.id);
		assert.ok(ids.filter((id) => id !== steps[1].paths[1].steps[0].paths[0].steps[0].id).every((id) => kept.includes(id)));
		assert.equal(kept.length, 8, "one added, one removed");
	});

	test("are stored in their final form, and read back by the API's names", () => {
		const { steps } = checkSteps(TREE);
		const [, branch] = steps;
		assert.equal(branch.type, "branch");
		assert.deepEqual(branch.rules, TREE[1].condition);
		assert.equal(branch.paths.length, 2);
		assert.deepEqual(branch.paths[0].steps[0], { id: branch.paths[0].steps[0].id, type: "wait", weekday: "friday", time: "10:30", timeZone: "Europe/Paris" });
		assert.deepEqual(branch.paths[0].steps[1], { id: branch.paths[0].steps[1].id, type: "set_field", field: "plan", value: "pro" });
		const split = branch.paths[1].steps[0];
		assert.deepEqual(split.paths.map(({ percent }) => percent), [70, 30]);
		assert.equal(split.seed, "launch");

		const out = toStepOutput(branch);
		assert.deepEqual(out.condition, TREE[1].condition);
		assert.equal(out.paths[0].name, "VIPs");
		assert.equal(out.paths[1].steps[0].paths[1].steps[1].automation, "6650f1c2e9b1d4a012345678");
		assert.equal(out.rules, undefined);
	});

	test("end a list with a branch or a split, in two paths or 2 to 5, nested 3 lists deep at most", () => {
		const branch = { type: "branch", condition: { match: "all", conditions: [{ type: "tag", value: "x" }] } };
		assert.match(checkSteps([branch, tagStep("a")]).problem, /steps\[0\]: a branch ends its list/);
		assert.match(checkSteps([{ type: "split" }, tagStep("a")]).problem, /a split ends its list/);
		assert.deepEqual(checkSteps([{ ...branch }]).steps[0].paths.map(({ steps }) => steps), [[], []], "paths default to empty ones");
		assert.match(checkSteps([{ ...branch, paths: [{ steps: [] }] }]).problem, /two paths/);
		assert.match(checkSteps([{ ...branch, paths: [{ steps: [] }, { steps: [] }, { steps: [] }] }]).problem, /two paths/);
		assert.match(checkSteps([{ ...branch, paths: [{ percent: 50, steps: [] }, { percent: 50, steps: [] }] }]).problem, /no percent/);
		assert.match(checkSteps([{ type: "branch" }]).problem, /condition or segment, not both/);
		assert.match(checkSteps([{ ...branch, segment: "VIPs" }]).problem, /condition or segment, not both/);

		const split = (paths) => checkSteps([{ type: "split", paths }]);
		assert.match(split([{ steps: [] }]).problem, /2 to 5 paths/);
		assert.match(split(Array.from({ length: 6 }, () => ({ steps: [] }))).problem, /2 to 5 paths/);
		assert.match(split([{ percent: 60, steps: [] }, { percent: 30, steps: [] }]).problem, /add up to 100/);
		assert.match(split([{ percent: 100, steps: [] }, { steps: [] }]).problem, /every path a percent, or none/);
		assert.deepEqual(split([{ steps: [] }, { steps: [] }, { steps: [] }]).steps[0].paths.map(({ percent }) => percent), [34, 33, 33], "none divides evenly");
		assert.deepEqual(split([{ percent: 20, steps: [] }, { percent: 20, steps: [] }, { percent: 20, steps: [] }, { percent: 20, steps: [] }, { percent: 20, steps: [] }]).steps[0].paths.length, 5);

		const nest = (depth) => (depth === 0 ? [] : [{ ...branch, paths: [{ steps: nest(depth - 1) }, { steps: [] }] }]);
		assert.equal(checkSteps(nest(2)).problem, undefined, "the main list and two lists of paths");
		assert.match(checkSteps(nest(3)).problem, /nest 3 lists deep/);
	});

	test("keep to the limits of a list and of the whole automation, with IDs that can't repeat", () => {
		assert.match(checkSteps(Array.from({ length: 21 }, () => ({ type: "end" }))).problem, /up to 20 steps/);
		const fill = (count, tag) => Array.from({ length: count }, () => tagStep(tag));
		const condition = { match: "all", conditions: [{ type: "tag", value: "x" }] };
		const branchOf = (first, second) => ({ type: "branch", condition, paths: [{ steps: first }, { steps: second }] });
		const full = checkSteps([...fill(19, "z"), branchOf(fill(20, "a"), fill(20, "b"))]);
		assert.equal(full.problem, undefined, "19 + 1 + 20 + 20");
		assert.equal(countSteps(full.steps), MAX_TOTAL_STEPS);
		assert.match(checkSteps([...fill(19, "z"), branchOf(fill(20, "a"), [...fill(19, "b"), branchOf(fill(1, "c"), [])])]).problem, /60 steps in all/);

		assert.match(checkSteps([{ id: "a", type: "end" }, { id: "a", type: "end" }]).problem, /used twice/);
		const across = [branchOf([{ id: "same", type: "end" }], [{ id: "same", type: "end" }])];
		assert.match(checkSteps(across).problem, /steps\[0\]\.paths\[1\]\.steps\[0\]: the id same is used twice/);
		for (const id of ["a b", "a.b", "é", "x".repeat(41)]) assert.match(checkSteps([{ id, type: "end" }]).problem, /an id is letters/);
		assert.equal(checkSteps([{ id: "Welcome_1-b", type: "end" }]).steps[0].id, "Welcome_1-b");
	});

	test("check each step's own parts, saying where they went wrong", () => {
		assert.match(checkSteps([{ type: "wait" }]).problem, /amount and unit \(minutes, hours or days\), or until, or weekday/);
		assert.match(checkSteps([{ type: "wait", amount: 1, unit: "days", until: "2026-12-01T09:00:00Z" }]).problem, /amount and unit/);
		assert.match(checkSteps([{ type: "wait", until: "tomorrow" }]).problem, /date and time/);
		assert.match(checkSteps([{ type: "wait", weekday: "monday", time: "25:00" }]).problem, /HH:MM/);
		assert.match(checkSteps([{ type: "wait", weekday: "monday", timeZone: "Mars/Base" }]).problem, /time zone/);
		assert.deepEqual(checkSteps([{ id: "w", type: "wait", until: "2026-12-01T09:00:00+01:00" }]).steps, [{ id: "w", type: "wait", until: "2026-12-01T08:00:00.000Z" }]);
		assert.deepEqual(checkSteps([{ id: "w", type: "wait", weekday: "monday" }]).steps, [{ id: "w", type: "wait", weekday: "monday", time: "09:00", timeZone: "UTC" }]);
		assert.match(checkSteps([{ type: "set_field" }]).problem, /key of a custom field/);
		assert.deepEqual(checkSteps([{ id: "f", type: "set_field", field: " Plan ", value: "pro" }]).steps, [{ id: "f", type: "set_field", field: "plan", value: "pro" }]);
		assert.deepEqual(checkSteps([{ id: "f", type: "set_field", field: "plan" }]).steps[0].value, null, "no value clears the field");
		assert.match(checkSteps([{ type: "move" }]).problem, /ID of an automation/);
		assert.match(checkSteps([{ type: "add_tag", tag: "<b>" }]).problem, /needs a tag/);
		const nested = [{ type: "branch", condition: { match: "all", conditions: [{ type: "tag", value: "x" }] }, paths: [{ steps: [] }, { steps: [{ type: "move" }] }] }];
		assert.match(checkSteps(nested).problem, /^steps\[0\]\.paths\[1\]\.steps\[0\]: move needs/);
		assert.match(checkSteps([{ type: "email", subject: "", content: "x" }], { isComplete: true }).problem, /subject/);
	});

	test("read as words", () => {
		const { steps } = checkSteps(TREE);
		assert.deepEqual(
			listSteps(steps).map(({ step }) => describeStep(step)),
			[
				'Send "Hi"',
				"Branch: matches or not",
				"Wait until Friday at 10:30 (Europe/Paris)",
				"Set plan to pro",
				"Split 70% / 30%",
				"Add the tag a",
				"Send the webhook crm",
				"Move to another automation",
			]
		);
		assert.equal(describeStep({ type: "wait", until: "2026-12-01T09:00:00.000Z" }), "Wait until 2026-12-01 09:00 UTC");
		assert.equal(describeStep({ type: "wait", weekday: "monday", time: "09:00", timeZone: "UTC" }), "Wait until Monday at 09:00 UTC");
		assert.equal(describeStep({ type: "set_field", field: "plan", value: null }), "Clear plan");
		assert.equal(describeStep({ type: "webhook" }), "Send a webhook");
		assert.equal(describeTrigger({ type: "tag_removed", tag: "vip" }), "A contact loses the tag vip");
		assert.equal(describeTrigger({ type: "segment_left" }, { segmentName: "VIPs" }), "A contact leaves the segment VIPs");
		assert.equal(describeTrigger({ type: "field_changed", field: "plan" }), "A contact's plan changes");
		assert.equal(describeTrigger({ type: "upgraded" }), "A reader upgrades to paid");
		assert.equal(describeTrigger({ type: "downgraded" }), "A reader drops to free");
		assert.equal(describeTrigger({ type: "product_bought" }, { productTitle: "The workbook" }), "A reader buys The workbook");
		assert.equal(describeTrigger({ type: "referral_credited", referrals: 5 }), "A subscriber reaches 5 referrals");
		assert.equal(describeTrigger({ type: "unengaged", days: 60 }), "A contact has no opens or clicks for 60 days");
		assert.equal(describeTrigger({ type: "link_clicked", url: "https://example.com/a" }), "A contact clicks https://example.com/a");
		assert.equal(describeTrigger({ type: "manual" }), "You add a contact by hand");
		assert.equal(describeTrigger({ type: "api" }), "Your code adds a contact");
	});

	test("find a step's place and the one after it", () => {
		const { steps } = checkSteps(TREE);
		const index = indexSteps(steps);
		const [email, branch] = steps;
		assert.equal(nextStep(index, email.id).id, branch.id);
		assert.equal(nextStep(index, branch.id), null, "a branch ends its list");
		const [wait, set] = branch.paths[0].steps;
		assert.equal(nextStep(index, wait.id).id, set.id);
		assert.equal(nextStep(index, set.id), null, "the end of a path");
		assert.deepEqual({ level: index.get(set.id).level, parentId: index.get(set.id).parentId, pathIndex: index.get(set.id).pathIndex }, { level: 2, parentId: branch.id, pathIndex: 0 });
		const split = branch.paths[1].steps[0];
		const webhook = split.paths[1].steps[0];
		assert.deepEqual({ level: index.get(webhook.id).level, parentId: index.get(webhook.id).parentId, pathIndex: index.get(webhook.id).pathIndex }, { level: 3, parentId: split.id, pathIndex: 1 });
		assert.deepEqual(findStepSegmentIds([{ id: "b", type: "branch", segmentId: "6650f1c2e9b1d4a012345678", paths: [{ steps: [] }, { steps: [] }] }]), ["6650f1c2e9b1d4a012345678"]);
	});
});

describe("random splits", () => {
	test("give the same path for the same seed, every time", () => {
		for (const seed of ["a", "step:contact-1", "ü", ""]) {
			const first = pickSplitPath([50, 50], seed);
			for (let again = 0; again < 5; again++) assert.equal(pickSplitPath([50, 50], seed), first);
		}
		assert.equal(hashToUnit("x"), hashToUnit("x"));
		assert.ok(hashToUnit("x") >= 0 && hashToUnit("x") < 1);
		assert.notEqual(hashToUnit("x"), hashToUnit("y"));
		assert.equal(getSplitSeed({ id: "s1" }, "c1"), "s1:c1");
		assert.equal(getSplitSeed({ id: "s1", seed: "cohort" }, "c1"), "cohort:c1", "a seed of its own groups splits together");
		assert.equal(pickSplitPath([50, 50], getSplitSeed({ id: "s1", seed: "k" }, "c1")), pickSplitPath([50, 50], getSplitSeed({ id: "s2", seed: "k" }, "c1")));
	});

	test("follow the percents closely over many contacts, for 2 to 5 paths", () => {
		for (const percents of [[50, 50], [10, 90], [34, 33, 33], [20, 20, 20, 20, 20], [5, 15, 30, 50]]) {
			const counts = percents.map(() => 0);
			const total = 20_000;
			for (let contact = 0; contact < total; contact++) counts[pickSplitPath(percents, getSplitSeed({ id: "split" }, `c${contact}`))]++;
			for (const [index, percent] of percents.entries()) {
				const share = (counts[index] / total) * 100;
				assert.ok(Math.abs(share - percent) < 1.5, `${percents.join("/")}: path ${index} got ${share.toFixed(1)}%`);
			}
		}
	});

	test("take a different path in different splits for the same contact", () => {
		let differ = 0;
		for (let contact = 0; contact < 200; contact++) {
			if (pickSplitPath([50, 50], getSplitSeed({ id: "one" }, `c${contact}`)) !== pickSplitPath([50, 50], getSplitSeed({ id: "two" }, `c${contact}`))) differ++;
		}
		assert.ok(differ > 60 && differ < 140, `${differ} of 200 differ`);
	});
});

describe("waiting until", () => {
	test("a date and time is that moment, past or not", () => {
		assert.equal(getWaitUntil({ until: "2026-12-01T09:00:00.000Z" }, new Date("2026-10-20T00:00:00Z")).toISOString(), "2026-12-01T09:00:00.000Z");
		assert.equal(getWaitUntil({ until: "2020-01-01T00:00:00.000Z" }, new Date("2026-10-20T00:00:00Z")).toISOString(), "2020-01-01T00:00:00.000Z");
	});

	test("a weekday is the next time it is that day at that hour in the zone", () => {
		const step = (extra) => ({ type: "wait", weekday: "monday", time: "09:00", timeZone: "UTC", ...extra });
		const at = (extra, now) => getWaitUntil(step(extra), new Date(now)).toISOString();
		// 2026-10-20 is a Tuesday.
		assert.equal(at({}, "2026-10-20T12:00:00Z"), "2026-10-26T09:00:00.000Z");
		assert.equal(at({ weekday: "tuesday" }, "2026-10-20T08:00:00Z"), "2026-10-20T09:00:00.000Z", "later today");
		assert.equal(at({ weekday: "tuesday" }, "2026-10-20T09:00:00Z"), "2026-10-27T09:00:00.000Z", "now is not later");
		assert.equal(at({ weekday: "tuesday" }, "2026-10-20T10:00:00Z"), "2026-10-27T09:00:00.000Z", "next week");
		assert.equal(at({ weekday: "sunday", time: "23:59" }, "2026-10-20T10:00:00Z"), "2026-10-25T23:59:00.000Z");
		assert.equal(at({ timeZone: "Europe/Paris" }, "2026-10-20T12:00:00Z"), "2026-10-26T08:00:00.000Z", "Paris is UTC+1 after the clocks change on the 25th");
		assert.equal(at({ timeZone: "Europe/Paris", weekday: "friday" }, "2026-10-20T12:00:00Z"), "2026-10-23T07:00:00.000Z", "and UTC+2 before");
		assert.equal(at({ timeZone: "America/Los_Angeles", weekday: "tuesday", time: "20:00" }, "2026-10-20T12:00:00Z"), "2026-10-21T03:00:00.000Z", "still Tuesday evening in Los Angeles");
		assert.equal(at({ timeZone: "Pacific/Auckland", weekday: "wednesday" }, "2026-10-20T12:00:00Z"), "2026-10-20T20:00:00.000Z", "Wednesday morning in Auckland is Tuesday evening in UTC");
	});
});

// ---- Through the API and the job

async function create(user, { trigger = { type: "tag_added", tag: "go" }, steps, name = "Series", activate = true } = {}) {
	const created = await t.api(user.key, "POST", "/automations", { name, trigger, steps });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	if (!activate) return created.body;
	const activated = await t.api(user.key, "POST", `/automations/${created.body.id}/activate`);
	assert.equal(activated.status, 200, JSON.stringify(activated.body));
	return activated.body;
}

const subscribe = async (user, name, body = {}) => {
	const response = await t.api(user.signupsKey, "POST", "/contacts", { email: user.address(name), ...body });
	assert.ok([200, 201].includes(response.status), JSON.stringify(response.body));
	return response.body;
};
const tag = (user, id, value) => t.api(user.key, "POST", `/contacts/${id}/tags`, { tag: value });
const untag = (user, id, value) => t.api(user.key, "DELETE", `/contacts/${id}/tags?tag=${encodeURIComponent(value)}`);
const stored = (user, name) => t.m.Contact.findOne({ accountId: user.accountId, email: user.address(name) }).lean();
const tagsOf = async (user, name) => ((await stored(user, name)).tags ?? []).sort();
const enrollmentsOf = (user, automation) => m.Enrollment.find({ accountId: user.accountId, automationId: automation.id }).lean();
const report = async (user, automation) => (await t.api(user.key, "GET", `/automations/${automation.id}/report`)).body;

describe("creating and editing a tree", () => {
	test("keeps step IDs through edits, at every level", async () => {
		const user = await customer("v2-edit@example.com");
		const created = await create(user, {
			trigger: { type: "manual" },
			activate: false,
			steps: [
				tagStep("one"),
				{ type: "branch", condition: { match: "all", conditions: [{ type: "tag", value: "vip" }] }, paths: [{ name: "VIPs", steps: [tagStep("yes")] }, { steps: [tagStep("no"), { type: "end" }] }] },
			],
		});
		const [first, branch] = created.steps;
		assert.equal(branch.paths[0].name, "VIPs");
		assert.deepEqual(branch.condition, { match: "all", conditions: [{ type: "tag", op: "has", value: "vip" }] });
		const flat = [];
		(function collect(list) {
			for (const step of list) {
				flat.push(step.id);
				for (const path of step.paths ?? []) collect(path.steps);
			}
		})(created.steps);
		assert.equal(new Set(flat).size, 5);

		const edited = structuredClone(created.steps);
		edited[1].paths[1].steps.unshift({ type: "wait", amount: 1, unit: "hours" });
		edited.unshift({ type: "add_tag", tag: "zero" });
		const updated = await t.api(user.key, "PATCH", `/automations/${created.id}`, { steps: edited });
		assert.equal(updated.status, 200, JSON.stringify(updated.body));
		assert.equal(updated.body.steps[1].id, first.id);
		assert.equal(updated.body.steps[2].id, branch.id);
		assert.deepEqual(
			updated.body.steps[2].paths.map(({ steps }) => steps.map(({ id }) => id)).flat().filter((id) => created.steps[1].paths.flatMap(({ steps }) => steps).some((step) => step.id === id)).length,
			3,
			"the three steps that stayed kept their IDs"
		);
		assert.match(updated.body.summary, /Add the tag zero → Add the tag one → Branch: matches or not/);

		const got = await t.api(user.key, "GET", `/automations/${created.id}`);
		assert.deepEqual(got.body.steps, updated.body.steps);
		const listed = (await t.api(user.key, "GET", "/automations")).body.automations.find(({ id }) => id === created.id);
		assert.deepEqual(listed.steps, updated.body.steps);
	});

	test("says which step is wrong, however deep it is", async () => {
		const user = await customer("v2-errors@example.com");
		const bad = async (steps) => t.assertError(await t.api(user.key, "POST", "/automations", { name: "Bad", trigger: { type: "manual" }, steps }), 400, "validation_failed");
		const branch = (paths, extra = {}) => ({ type: "branch", condition: { match: "all", conditions: [{ type: "tag", value: "vip" }] }, paths, ...extra });
		assert.match(await bad([branch([{ steps: [] }, { steps: [{ type: "add_tag", tag: "<b>" }] }])]), /^steps\[0\]\.paths\[1\]\.steps\[0\]: add_tag needs a tag/);
		assert.match(await bad([tagStep("a"), branch([{ steps: [] }, { steps: [] }]), tagStep("b")]), /steps\[1\]: a branch ends its list/);
		assert.match(await bad([{ type: "set_field", field: "nope", value: "x" }]), /Step 1: the newsletter has no custom field nope/);
		assert.match(await bad([branch([{ steps: [] }, { steps: [{ type: "set_field", field: "nope", value: "x" }] }])]), /Step 1, path 2, step 1: the newsletter has no custom field nope/);
		assert.match(await bad([branch([{ steps: [] }, { steps: [] }], { condition: { match: "all", conditions: [{ type: "tag", value: "<b>" }] } })]), /rules: tag: value is a tag/);
		assert.match(await bad([branch([{ steps: [] }, { steps: [] }], { condition: undefined, segment: "No such segment" })]), /no segment No such segment/);
		assert.match(await bad([{ type: "move", automation: "6650f1c2e9b1d4a012345678" }]), /no such automation/);
	});

	test("check a field's value against its type, and a move against its newsletter", async () => {
		const user = await customer("v2-refs@example.com");
		await t.api(user.key, "POST", "/custom-fields", { label: "Seats", type: "number" });
		await t.api(user.key, "POST", "/custom-fields", { label: "Plan", type: "list", options: ["free", "pro"] });
		const bad = async (steps) => t.assertError(await t.api(user.key, "POST", "/automations", { name: "Bad", trigger: { type: "manual" }, steps }), 400, "validation_failed");
		assert.match(await bad([{ type: "set_field", field: "seats", value: "many" }]), /fields\.seats/);
		assert.match(await bad([{ type: "set_field", field: "plan", value: "gold" }]), /fields\.plan/);
		const ok = await t.api(user.key, "POST", "/automations", { name: "Ok", trigger: { type: "manual" }, steps: [{ type: "set_field", field: "seats", value: "12" }, { type: "set_field", field: "PLAN", value: "pro" }, { type: "set_field", field: "plan", value: null }] });
		assert.deepEqual(ok.body.steps.map(({ field, value }) => [field, value]), [["seats", 12], ["plan", "pro"], ["plan", null]]);
		assert.equal(ok.body.summary.includes("Set seats to 12 → Set plan to pro → Clear plan"), true);

		const self = await t.api(user.key, "POST", "/automations", { name: "Self", trigger: { type: "manual" }, steps: [] });
		assert.match(t.assertError(await t.api(user.key, "PATCH", `/automations/${self.body.id}`, { steps: [{ type: "move", automation: self.body.id }] }), 400, "validation_failed"), /to itself/);
		const other = await customer("v2-refs-other@example.com");
		const foreign = await t.api(other.key, "POST", "/automations", { name: "Foreign", trigger: { type: "manual" }, steps: [] });
		assert.match(await bad([{ type: "move", automation: foreign.body.id }]), /no such automation/);
		const move = await t.api(user.key, "POST", "/automations", { name: "Mover", trigger: { type: "manual" }, steps: [{ type: "move", automation: self.body.id }] });
		assert.equal(move.body.steps[0].automation, self.body.id);
	});

	test("a branch inside a path takes the same conditions, checked the same", async () => {
		const user = await customer("v2-nested-rules@example.com");
		const inner = (condition) => ({ type: "branch", condition, paths: [{ steps: [tagStep("yes")] }, { steps: [] }] });
		const outer = (condition) => ({ type: "branch", condition: { match: "all", conditions: [{ type: "tag", value: "a" }] }, paths: [{ steps: [] }, { steps: [inner(condition)] }] });
		const make = (condition) => t.api(user.key, "POST", "/automations", { name: "Nested", trigger: { type: "manual" }, steps: [outer(condition)] });
		const created = await make({ match: "any", conditions: [{ type: "tag", value: " VIP " }, { match: "all", conditions: [{ type: "country", op: "is_any_of", values: ["us"] }, { type: "tier", value: "paid" }] }] });
		assert.equal(created.status, 201, JSON.stringify(created.body));
		assert.deepEqual(created.body.steps[0].paths[1].steps[0].condition, {
			match: "any",
			conditions: [{ type: "tag", op: "has", value: "vip" }, { match: "all", conditions: [{ type: "country", op: "is_any_of", values: ["US"] }, { type: "tier", op: "is", value: "paid" }] }],
		});
		t.assertError(await make({ match: "all", conditions: [{ type: "tag", value: "<b>" }] }), 400, "validation_failed");
		t.assertError(await make({ match: "all", conditions: [{ type: "nonsense" }] }), 400, "validation_failed");
		t.assertError(await make({ match: "all", conditions: [] }), 400, "validation_failed");
		t.assertError(await make({ match: "maybe", conditions: [{ type: "tag", value: "a" }] }), 400, "validation_failed");
	});

	test("a branch on a saved segment follows the segment, and the segment can't be deleted under it", async () => {
		const user = await customer("v2-segment-branch@example.com");
		const segment = (await t.api(user.key, "POST", "/segments", { name: "VIPs", rules: { match: "all", conditions: [{ type: "tag", value: "vip" }] } })).body;
		const created = await create(user, { trigger: { type: "manual" }, activate: false, steps: [{ type: "branch", segment: "VIPs", paths: [{ steps: [tagStep("yes")] }, { steps: [] }] }] });
		assert.equal(created.steps[0].segment, segment.id, "stored by ID");
		assert.equal(created.steps[0].condition, undefined);
		assert.match(t.assertError(await t.api(user.key, "DELETE", `/segments/${segment.id}`), 409, "conflict"), /has a branch on this segment/);
		await t.api(user.key, "DELETE", `/automations/${created.id}`);
		assert.equal((await t.api(user.key, "DELETE", `/segments/${segment.id}`)).status, 200);
	});

	test("check each new trigger", async () => {
		const user = await customer("v2-triggers@example.com");
		await t.api(user.key, "POST", "/custom-fields", { label: "Plan", type: "text" });
		const segment = (await t.api(user.key, "POST", "/segments", { name: "VIPs", rules: { match: "all", conditions: [{ type: "tag", value: "vip" }] } })).body;
		const make = (trigger) => t.api(user.key, "POST", "/automations", { name: "T", trigger, steps: [] });
		const fails = async (trigger, pattern) => assert.match(t.assertError(await make(trigger), 400, "validation_failed"), pattern);

		await fails({ type: "tag_removed" }, /tag_removed needs a tag/);
		await fails({ type: "segment_left" }, /segment_left needs a segment/);
		assert.match(t.assertError(await make({ type: "segment_left", segment: "6650f1c2e9b1d4a012345678" }), 404, "not_found"), /Segment not found/);
		await fails({ type: "field_changed" }, /needs a field/);
		await fails({ type: "field_changed", field: "nope" }, /no custom field nope/);
		await fails({ type: "product_bought", product: "6650f1c2e9b1d4a012345678" }, /no such product/);
		await fails({ type: "unengaged" }, /needs days/);
		await fails({ type: "link_clicked" }, /needs url/);
		await fails({ type: "link_clicked", url: "javascript:alert(1)" }, /needs url/);
		await fails({ type: "link_clicked", url: "https://example.com", campaign: "6650f1c2e9b1d4a012345678" }, /no such issue/);

		const ok = async (trigger, expected = trigger) => {
			const response = await make(trigger);
			assert.equal(response.status, 201, JSON.stringify(response.body));
			assert.deepEqual(response.body.trigger, expected);
			return response.body;
		};
		await ok({ type: "tag_removed", tag: " VIP " }, { type: "tag_removed", tag: "vip" });
		await ok({ type: "segment_left", segment: "VIPs" }, { type: "segment_left", segment: segment.id });
		await ok({ type: "field_changed", field: "PLAN" }, { type: "field_changed", field: "plan" });
		for (const type of ["upgraded", "downgraded", "manual", "api"]) await ok({ type });
		await ok({ type: "product_bought" });
		await ok({ type: "referral_credited", referrals: 3 });
		await ok({ type: "unengaged", days: 45 }, { type: "unengaged", days: 45, includeExisting: false });
		await ok({ type: "unengaged", days: 45, includeExisting: true });
		const link = await ok({ type: "link_clicked", url: "https://example.com/a" });
		assert.equal(link.summary, "A contact clicks https://example.com/a");
	});
});

describe("running the steps", () => {
	test("wait until a date and time, then until a weekday", async () => {
		const user = await customer("v2-wait@example.com");
		const until = later(3 * HOUR_MS);
		const automation = await create(user, {
			steps: [
				{ type: "wait", until: until.toISOString() },
				tagStep("after-date"),
				{ type: "wait", weekday: "monday", time: "09:00", timeZone: "UTC" },
				tagStep("after-weekday"),
				{ type: "wait", until: new Date(Date.now() - DAY_MS).toISOString() },
				tagStep("past-wait"),
			],
		});
		const contact = await subscribe(user, "ann");
		await tag(user, contact.id, "go");
		const start = new Date();
		await run(start);
		assert.deepEqual(await tagsOf(user, "ann"), ["go"]);
		const [parked] = await enrollmentsOf(user, automation);
		assert.equal(parked.nextRunAt.toISOString(), until.toISOString());

		await run(new Date(start.getTime() + 2 * HOUR_MS));
		assert.deepEqual(await tagsOf(user, "ann"), ["go"], "not yet");
		const afterDate = new Date(until.getTime() + 1000);
		await run(afterDate);
		assert.deepEqual(await tagsOf(user, "ann"), ["after-date", "go"]);
		const [waiting] = await enrollmentsOf(user, automation);
		const monday = waiting.nextRunAt;
		assert.equal(monday.getUTCDay(), 1);
		assert.equal(monday.toISOString().slice(11), "09:00:00.000Z");
		assert.ok(monday > afterDate && monday - afterDate <= 7 * DAY_MS);

		await run(new Date(monday.getTime() + 1000));
		assert.deepEqual(await tagsOf(user, "ann"), ["after-date", "after-weekday", "go", "past-wait"], "a date in the past doesn't wait");
		assert.equal((await enrollmentsOf(user, automation))[0].status, "completed");
	});

	test("set a field, which starts the automations that wait for that field to change", async () => {
		const user = await customer("v2-field@example.com");
		await t.api(user.key, "POST", "/custom-fields", { label: "Plan", type: "text" });
		await create(user, { name: "Sets", steps: [{ type: "set_field", field: "plan", value: "pro" }, tagStep("set")] });
		const watcher = await create(user, { name: "Watches", trigger: { type: "field_changed", field: "plan" }, steps: [tagStep("noticed")] });
		const contact = await subscribe(user, "ann");
		await tag(user, contact.id, "go");
		await run();
		const ann = await stored(user, "ann");
		assert.equal(ann.fields.plan, "pro");
		assert.deepEqual(await tagsOf(user, "ann"), ["go", "set"]);
		assert.equal((await enrollmentsOf(user, watcher)).length, 1, "the change started the other automation");
		await run();
		assert.deepEqual(await tagsOf(user, "ann"), ["go", "noticed", "set"]);

		// Setting the field to what it has already changes nothing, so nothing starts again.
		const again = await customer("v2-field-again@example.com");
		await t.api(again.key, "POST", "/custom-fields", { label: "Plan", type: "text" });
		const sets = await create(again, { steps: [{ type: "set_field", field: "plan", value: "pro" }] });
		const sameWatcher = await create(again, { name: "Watches", trigger: { type: "field_changed", field: "plan" }, steps: [tagStep("noticed")] });
		const reader = await subscribe(again, "bob", { fields: { plan: "pro" } });
		await tag(again, reader.id, "go");
		await run();
		assert.equal((await enrollmentsOf(again, sets))[0].status, "completed");
		assert.equal((await enrollmentsOf(again, sameWatcher)).length, 0);
	});

	test("send an automation.step event to the webhook endpoints that take it", async () => {
		const user = await customer("v2-webhook@example.com");
		const all = await t.api(user.key, "POST", "/webhooks", { url: "https://hooks.example.com/all" });
		const only = await t.api(user.key, "POST", "/webhooks", { url: "https://hooks.example.com/created", events: ["subscriber.created"] });
		assert.equal(all.status, 201, JSON.stringify(all.body));
		const automation = await create(user, { name: "Tells the CRM", steps: [{ type: "webhook", name: "add-to-crm" }, { type: "webhook" }, tagStep("after")] });
		const contact = await subscribe(user, "ann");
		await tag(user, contact.id, "go");
		await run();
		const deliveries = (await m.WebhookDelivery.find({ accountId: user.accountId, type: "automation.step" }).lean()).sort((a, b) => a._id.toString().localeCompare(b._id.toString()));
		assert.equal(deliveries.length, 2, "one for each webhook step, to the endpoint that takes it");
		assert.deepEqual(deliveries.map((delivery) => String(delivery.endpointId)), [all.body.endpoint.id, all.body.endpoint.id]);
		const [first, second] = deliveries.map((delivery) => JSON.parse(delivery.payload));
		assert.equal(first.type, "automation.step");
		assert.deepEqual({ automation: first.data.automation.name, step: first.data.step.name, email: first.data.subscriber.email }, { automation: "Tells the CRM", step: "add-to-crm", email: user.address("ann") });
		assert.equal(first.data.step.id.length, 10);
		assert.equal(second.data.step.name, null);
		assert.equal(first.data.enrollmentId, String((await enrollmentsOf(user, automation))[0]._id));
		assert.deepEqual(await tagsOf(user, "ann"), ["after", "go"], "the steps went on");
		assert.ok(only.body.endpoint.id);
	});

	test("branch on a condition or a saved segment, seeing what the steps before it did", async () => {
		const user = await customer("v2-branch@example.com");
		const segment = (await t.api(user.key, "POST", "/segments", { name: "Premium", rules: { match: "all", conditions: [{ type: "tag", value: "premium" }] } })).body;
		const automation = await create(user, {
			steps: [
				{ type: "branch", condition: { match: "any", conditions: [{ type: "tag", value: "vip" }, { type: "tier", value: "paid" }] }, paths: [{ steps: [tagStep("yes")] }, { steps: [tagStep("no"), tagStep("no-again")] }] },
			],
		});
		const bySegment = await create(user, {
			name: "By segment",
			trigger: { type: "tag_added", tag: "check" },
			steps: [tagStep("premium"), { type: "branch", segment: segment.id, paths: [{ steps: [tagStep("seg-yes")] }, { steps: [tagStep("seg-no")] }] }],
		});
		const ann = await subscribe(user, "ann");
		const bob = await subscribe(user, "bob");
		await tag(user, ann.id, "vip");
		await tag(user, ann.id, "go");
		await tag(user, bob.id, "go");
		await tag(user, bob.id, "check");
		await run();
		assert.deepEqual(await tagsOf(user, "ann"), ["go", "vip", "yes"]);
		assert.deepEqual(await tagsOf(user, "bob"), ["check", "go", "no", "no-again", "premium", "seg-yes"], "premium was given by the step before the branch");
		assert.deepEqual((await enrollmentsOf(user, automation)).map(({ status }) => status), ["completed", "completed"]);

		const shown = await report(user, automation);
		const [branch, yes, no, noAgain] = shown.steps;
		assert.deepEqual({ level: branch.level, parentId: branch.parentId, ran: branch.ran, pathRuns: branch.pathRuns }, { level: 1, parentId: null, ran: 2, pathRuns: [1, 1] });
		assert.deepEqual([yes, no, noAgain].map((step) => [step.level, step.parentId === branch.id, step.pathIndex, step.ran]), [[2, true, 0, 1], [2, true, 1, 1], [2, true, 1, 1]]);
		assert.equal(shown.entered, 2);
		const seg = await report(user, bySegment);
		assert.deepEqual(seg.steps.find(({ type }) => type === "branch").pathRuns, [1, 0]);
	});

	test("split contacts at random by percent, each to the same path every time", async () => {
		const user = await customer("v2-split@example.com");
		const automation = await create(user, {
			steps: [
				{
					type: "split",
					paths: [
						{ name: "A", percent: 50, steps: [tagStep("path-a")] },
						{ name: "B", percent: 30, steps: [tagStep("path-b")] },
						{ percent: 20, steps: [] },
					],
				},
			],
		});
		const splitId = automation.steps[0].id;
		const contacts = [];
		for (let index = 0; index < 40; index++) {
			const contact = await subscribe(user, `reader${index}`);
			contacts.push(contact);
			await tag(user, contact.id, "go");
		}
		await run();
		const expected = [0, 0, 0];
		for (const contact of contacts) {
			const path = pickSplitPath([50, 30, 20], getSplitSeed({ id: splitId }, contact.id));
			expected[path]++;
			const tags = (await t.m.Contact.findOne({ accountId: user.accountId, _id: contact.id }).lean()).tags;
			assert.equal(tags.includes("path-a"), path === 0, contact.email);
			assert.equal(tags.includes("path-b"), path === 1, contact.email);
		}
		assert.ok(expected.every((count) => count > 0), `all three paths got contacts: ${expected}`);
		const shown = await report(user, automation);
		assert.deepEqual(shown.steps[0].pathRuns, expected);
		assert.equal(shown.steps[0].ran, 40);
		assert.equal(shown.steps.find(({ pathIndex }) => pathIndex === 0).ran, expected[0]);
		assert.equal((await enrollmentsOf(user, automation)).filter(({ status }) => status === "completed").length, 40, "an empty path completes the contact too");
	});

	test("a split's seed keeps the same contacts together across two splits", async () => {
		const user = await customer("v2-seed@example.com");
		const split = (name, seed) => ({ type: "split", ...(seed && { seed }), paths: [{ percent: 50, steps: [tagStep(`${name}-a`)] }, { percent: 50, steps: [tagStep(`${name}-b`)] }] });
		await create(user, { name: "One", trigger: { type: "tag_added", tag: "one" }, steps: [split("one", "cohort")] });
		await create(user, { name: "Two", trigger: { type: "tag_added", tag: "two" }, steps: [split("two", "cohort")] });
		for (let index = 0; index < 12; index++) {
			const contact = await subscribe(user, `reader${index}`);
			await tag(user, contact.id, "one");
			await tag(user, contact.id, "two");
		}
		await run();
		for (let index = 0; index < 12; index++) {
			const tags = await tagsOf(user, `reader${index}`);
			assert.equal(tags.includes("one-a"), tags.includes("two-a"), `reader${index} took the same side in both`);
		}
	});

	test("move a contact to another automation, which can't loop", async () => {
		const user = await customer("v2-move@example.com");
		const target = await create(user, { name: "Target", trigger: { type: "api" }, steps: [tagStep("in-target")] });
		const mover = await create(user, { name: "Mover", steps: [tagStep("moving"), { type: "move", automation: target.id }, tagStep("never")] });
		const contact = await subscribe(user, "ann");
		await tag(user, contact.id, "go");
		await run();
		const [moved] = await enrollmentsOf(user, mover);
		assert.equal(moved.status, "completed", "the move ends the first automation for the contact");
		const [arrived] = await enrollmentsOf(user, target);
		assert.deepEqual([arrived.status, arrived.trigger], ["active", "moved"]);
		assert.deepEqual(await tagsOf(user, "ann"), ["go", "moving"]);
		await run();
		assert.deepEqual(await tagsOf(user, "ann"), ["go", "in-target", "moving"]);
		assert.equal((await enrollmentsOf(user, target))[0].status, "completed");

		// Moving back where the contact has been is refused by the once-only rule, so two automations can point at each other.
		const a = await create(user, { name: "A", trigger: { type: "tag_added", tag: "loop" }, steps: [] , activate: false});
		const b = await create(user, { name: "B", trigger: { type: "api" }, steps: [{ type: "move", automation: a.id }] });
		await t.api(user.key, "PATCH", `/automations/${a.id}`, { steps: [tagStep("a-ran"), { type: "move", automation: b.id }] });
		await t.api(user.key, "POST", `/automations/${a.id}/activate`);
		await tag(user, contact.id, "loop");
		for (let round = 0; round < 4; round++) await run();
		assert.equal((await enrollmentsOf(user, a)).length, 1);
		assert.equal((await enrollmentsOf(user, b)).length, 1);
		assert.ok((await enrollmentsOf(user, b)).every(({ status }) => status !== "active"), "nobody is stuck in the loop");

		// Not into one that is switched off.
		const draft = await create(user, { name: "Draft", trigger: { type: "api" }, steps: [tagStep("x")], activate: false });
		await create(user, { name: "To draft", trigger: { type: "tag_added", tag: "todraft" }, steps: [{ type: "move", automation: draft.id }] });
		await tag(user, contact.id, "todraft");
		await run();
		assert.equal((await enrollmentsOf(user, draft)).length, 0);
	});

	test("a contact waiting on a step stays on it when the steps around it are edited, at any level", async () => {
		const user = await customer("v2-stable@example.com");
		const automation = await create(user, {
			steps: [{ type: "branch", condition: { match: "all", conditions: [{ type: "tag", value: "vip" }] }, paths: [{ steps: [{ type: "wait", amount: 1, unit: "days" }, tagStep("vip-after-wait"), tagStep("vip-last")] }, { steps: [tagStep("regular")] }] }],
		});
		const contact = await subscribe(user, "ann");
		await tag(user, contact.id, "vip");
		await tag(user, contact.id, "go");
		const start = new Date();
		await run(start);
		const [waiting] = await enrollmentsOf(user, automation);
		const afterWait = automation.steps[0].paths[0].steps[1];
		assert.equal(waiting.stepId, afterWait.id, "waiting for the step after the wait, inside the path");
		assert.equal(waiting.stepIndex, 1, "its place in that path");

		await t.api(user.key, "POST", `/automations/${automation.id}/pause`);
		const shown = (await t.api(user.key, "GET", `/automations/${automation.id}`)).body;
		const edited = structuredClone(shown.steps);
		edited.unshift(tagStep("brand-new"));
		edited[1].paths[0].steps.unshift(tagStep("inserted-before"));
		edited[1].paths[0].steps.splice(3, 0, tagStep("inserted-after"));
		edited[1].paths[1].steps = [];
		const saved = await t.api(user.key, "PATCH", `/automations/${automation.id}`, { steps: edited });
		assert.equal(saved.status, 200, JSON.stringify(saved.body));
		assert.equal((await t.api(user.key, "POST", `/automations/${automation.id}/activate`)).status, 200);

		await run(new Date(start.getTime() + DAY_MS + 1000));
		assert.deepEqual(await tagsOf(user, "ann"), ["go", "inserted-after", "vip", "vip-after-wait", "vip-last"], "it went on from its step: what was put before it wasn't run for it");
		assert.equal((await enrollmentsOf(user, automation))[0].status, "completed");
	});

	test("a contact whose step was removed goes on from the same place in the main list", async () => {
		const user = await customer("v2-removed@example.com");
		const automation = await create(user, { steps: [{ type: "wait", amount: 1, unit: "days" }, tagStep("a"), tagStep("b"), tagStep("c")] });
		const contact = await subscribe(user, "ann");
		await tag(user, contact.id, "go");
		const start = new Date();
		await run(start);
		await t.api(user.key, "POST", `/automations/${automation.id}/pause`);
		await t.api(user.key, "PATCH", `/automations/${automation.id}`, { steps: [tagStep("x"), tagStep("y"), tagStep("z")] });
		await t.api(user.key, "POST", `/automations/${automation.id}/activate`);
		await run(new Date(start.getTime() + DAY_MS + 1000));
		assert.deepEqual(await tagsOf(user, "ann"), ["go", "y", "z"], "it was at position 1");
	});

	test("count what each step did for the report, and the contacts waiting for it", async () => {
		const user = await customer("v2-report@example.com");
		// An ID of digits only is the case a path into a document would read as a place in a list.
		const automation = await create(user, {
			steps: [{ id: "1234567890", ...tagStep("a") }, { type: "wait", amount: 2, unit: "days" }, tagStep("b")],
		});
		assert.equal(automation.steps[0].id, "1234567890");
		for (const name of ["ann", "bob", "cat"]) {
			const contact = await subscribe(user, name);
			await tag(user, contact.id, "go");
		}
		const start = new Date();
		await run(start);
		let shown = await report(user, automation);
		assert.deepEqual(shown.steps.map(({ ran, waiting }) => [ran, waiting]), [[3, 0], [3, 0], [0, 3]]);
		assert.deepEqual([shown.automation.enrollments.active, shown.entered], [3, 3]);
		await run(new Date(start.getTime() + 2 * DAY_MS + 1000));
		shown = await report(user, automation);
		assert.deepEqual(shown.steps.map(({ ran, waiting }) => [ran, waiting]), [[3, 0], [3, 0], [3, 0]]);
		assert.deepEqual([shown.automation.enrollments.completed, shown.automation.enrollments.active], [3, 0]);
	});
});

describe("triggers", () => {
	test("a tag coming off starts it, once", async () => {
		const user = await customer("v2-tag-removed@example.com");
		const automation = await create(user, { trigger: { type: "tag_removed", tag: "vip" }, steps: [tagStep("lapsed")] });
		const ann = await subscribe(user, "ann", { tags: ["vip", "beta"] });
		const bob = await subscribe(user, "bob", { tags: ["vip"] });
		assert.equal((await enrollmentsOf(user, automation)).length, 0, "adding the tag starts nothing");
		await untag(user, ann.id, "beta");
		assert.equal((await enrollmentsOf(user, automation)).length, 0, "another tag");
		await untag(user, ann.id, "vip");
		await untag(user, ann.id, "vip");
		await tag(user, ann.id, "vip");
		await untag(user, ann.id, "vip");
		await run();
		assert.equal((await enrollmentsOf(user, automation)).length, 1, "once, however often");
		assert.deepEqual(await tagsOf(user, "ann"), ["lapsed"], "beta was taken off, vip too");
		assert.deepEqual(await tagsOf(user, "bob"), ["vip"]);
		assert.ok(bob.id);
	});

	test("a custom field changing starts it, but not when it stays the same", async () => {
		const user = await customer("v2-field-changed@example.com");
		await t.api(user.key, "POST", "/custom-fields", { label: "Plan", type: "text" });
		await t.api(user.key, "POST", "/custom-fields", { label: "City", type: "text" });
		const automation = await create(user, { trigger: { type: "field_changed", field: "plan" }, steps: [tagStep("plan-changed")] });
		const ann = await subscribe(user, "ann");
		const setField = (id, field, value) => t.api(user.key, "PATCH", `/contacts/${id}/fields`, { field, value });
		await setField(ann.id, "city", "Paris");
		assert.equal((await enrollmentsOf(user, automation)).length, 0, "another field");
		await setField(ann.id, "plan", "pro");
		assert.equal((await enrollmentsOf(user, automation)).length, 1);
		await setField(ann.id, "plan", "pro");
		await setField(ann.id, "plan", "team");
		assert.equal((await enrollmentsOf(user, automation)).length, 1, "once");
		// A signup that carries the field for a contact who has it set differently counts as a change too.
		const bob = await subscribe(user, "bob", { fields: { plan: "pro" } });
		assert.ok(bob.id);
		await subscribe(user, "bob", { fields: { plan: "team" } });
		assert.equal((await enrollmentsOf(user, automation)).length, 2);
		await run();
		assert.deepEqual(await tagsOf(user, "ann"), ["plan-changed"]);
	});

	test("you or your code add contacts by hand to an active automation", async () => {
		const user = await customer("v2-manual@example.com");
		const manual = await create(user, { name: "By hand", trigger: { type: "manual" }, steps: [tagStep("added")] });
		const api = await create(user, { name: "By code", trigger: { type: "api" }, steps: [tagStep("added-by-code")] });
		const draft = await create(user, { name: "Draft", trigger: { type: "manual" }, steps: [tagStep("x")], activate: false });
		await subscribe(user, "ann");
		await subscribe(user, "bob");
		const pending = await subscribe(user, "gone");
		await t.api(user.key, "PATCH", `/contacts/${pending.id}`, { status: "unsubscribed" });
		const subscribeTrigger = await create(user, { name: "On signup", trigger: { type: "subscribed" }, steps: [tagStep("y")] });

		const enroll = (automation, emails) => t.api(user.key, "POST", `/automations/${automation.id}/enroll`, { emails });
		const first = await enroll(manual, [user.address("ann"), user.address("BOB"), user.address("nobody"), user.address("gone"), user.address("ann")]);
		assert.equal(first.status, 200, JSON.stringify(first.body));
		assert.deepEqual(first.body, { enrolled: 2, alreadyIn: 0, notFound: [user.address("nobody")], notActive: [user.address("gone")] });
		assert.deepEqual((await enroll(manual, [user.address("ann"), user.address("cat")])).body, { enrolled: 0, alreadyIn: 1, notFound: [user.address("cat")], notActive: [] });
		assert.equal((await enroll(api, [user.address("ann")])).body.enrolled, 1);

		assert.match(t.assertError(await enroll(subscribeTrigger, [user.address("ann")]), 409, "conflict"), /manual or api trigger/);
		assert.match(t.assertError(await enroll(draft, [user.address("ann")]), 409, "conflict"), /Activate the automation first/);
		t.assertError(await enroll(manual, []), 400, "validation_failed");
		t.assertError(await enroll(manual, Array.from({ length: 101 }, (_, index) => `x${index}@example.com`)), 400, "validation_failed");
		t.assertError(await t.api(user.key, "POST", "/automations/6650f1c2e9b1d4a012345678/enroll", { emails: [user.address("ann")] }), 404, "not_found");

		await run();
		assert.deepEqual(await tagsOf(user, "ann"), ["added", "added-by-code"]);
		assert.deepEqual(await tagsOf(user, "bob"), ["added"]);
		assert.equal((await enrollmentsOf(user, manual)).every(({ trigger }) => trigger === "manual"), true);
		const shown = await report(user, manual);
		assert.deepEqual([shown.entered, shown.automation.enrollments.completed], [2, 2]);
	});

	test("unengaged for N days starts it daily, for those who go quiet after it's on, or for everyone with includeExisting", async () => {
		const user = await customer("v2-unengaged@example.com");
		const base = { accountId: user.accountId, newsletterId: user.newsletterId, status: "active" };
		const quiet = (name, extra = {}) => t.m.Contact.create({ ...base, email: user.address(name), subscribedAt: new Date(Date.now() - 90 * DAY_MS), ...extra });
		await quiet("old-quiet");
		await quiet("old-reader", { lastOpenAt: new Date(Date.now() - 5 * DAY_MS) });
		await t.m.Contact.create({ ...base, email: user.address("new"), subscribedAt: new Date() });
		await quiet("old-gone", { status: "unsubscribed" });

		const fresh = await create(user, { name: "From now", trigger: { type: "unengaged", days: 60 }, steps: [tagStep("wake-up")] });
		const everyone = await create(user, { name: "Everyone", trigger: { type: "unengaged", days: 60, includeExisting: true }, steps: [tagStep("wake-up-all")] });
		// The look is once a UTC day: the three runs below span two hours, so they start where those two hours stay in one day.
		const start = new Date();
		if (start.getUTCHours() >= 21) start.setUTCHours(24, 30, 0, 0);
		await run(start);
		assert.equal((await enrollmentsOf(user, fresh)).filter(({ exitReason }) => exitReason !== "baseline").length, 0, "those already quiet are left alone");
		assert.deepEqual(await tagsOf(user, "old-quiet"), ["wake-up-all"]);
		assert.deepEqual((await enrollmentsOf(user, everyone)).map(({ status }) => status), ["completed"]);

		await run(new Date(start.getTime() + HOUR_MS));
		await quiet("later-quiet");
		await run(new Date(start.getTime() + 2 * HOUR_MS));
		assert.equal((await enrollmentsOf(user, fresh)).filter(({ exitReason }) => exitReason !== "baseline").length, 0, "it looks once a day");
		const nextDay = new Date(start.getTime() + DAY_MS + HOUR_MS);
		await run(nextDay);
		const entered = (await enrollmentsOf(user, fresh)).filter(({ exitReason }) => exitReason !== "baseline");
		assert.equal(entered.length, 1, "later-quiet only");
		assert.deepEqual(await tagsOf(user, "later-quiet"), ["wake-up", "wake-up-all"]);
		assert.deepEqual(await tagsOf(user, "old-quiet"), ["wake-up-all"]);
		assert.deepEqual(await tagsOf(user, "new"), []);
		const counts = await report(user, fresh);
		assert.equal(counts.entered, 1, "contacts it skipped aren't counted as entered");
	});

	test("leaving a segment starts it for each time a contact leaves", async () => {
		const user = await customer("v2-left@example.com");
		const segment = (await t.api(user.key, "POST", "/segments", { name: "VIPs", rules: { match: "all", conditions: [{ type: "tag", value: "vip" }] } })).body;
		const ann = await subscribe(user, "ann", { tags: ["vip"] });
		await subscribe(user, "bob", { tags: ["vip"] });
		await subscribe(user, "cat");
		const automation = await create(user, { trigger: { type: "segment_left", segment: segment.id }, steps: [tagStep("left-vips")] });
		const start = new Date();
		await run(start);
		assert.equal(await m.Watch.countDocuments({ accountId: user.accountId, automationId: automation.id }), 2, "it notes who is inside");
		assert.equal((await enrollmentsOf(user, automation)).length, 0, "nobody has left yet");

		await untag(user, ann.id, "vip");
		await tag(user, (await stored(user, "cat"))._id.toString(), "vip");
		await run(new Date(start.getTime() + 10 * 60_000));
		assert.equal((await enrollmentsOf(user, automation)).length, 0, "it looks about every hour");
		const hour = new Date(start.getTime() + HOUR_MS + 1000);
		await run(hour);
		assert.equal(await m.Watch.countDocuments({ accountId: user.accountId, automationId: automation.id }), 2, "ann is out, cat is in");
		assert.equal((await enrollmentsOf(user, automation)).length, 1);
		await run(hour);
		assert.deepEqual(await tagsOf(user, "ann"), ["left-vips"]);
		await run(new Date(hour.getTime() + HOUR_MS + 1000));
		assert.equal((await enrollmentsOf(user, automation)).length, 1, "not again for the same stay");

		// Back in, and out again: a new stay.
		await tag(user, ann.id, "vip");
		await run(new Date(hour.getTime() + 2 * HOUR_MS + 2000));
		await untag(user, ann.id, "vip");
		await run(new Date(hour.getTime() + 3 * HOUR_MS + 3000));
		assert.equal((await enrollmentsOf(user, automation)).length, 2);

		// A contact who unsubscribes is no longer in the segment's sends, and isn't started either.
		const bob = await stored(user, "bob");
		await t.api(user.key, "PATCH", `/contacts/${bob._id}`, { status: "unsubscribed" });
		await untag(user, bob._id.toString(), "vip");
		await run(new Date(hour.getTime() + 4 * HOUR_MS + 4000));
		assert.equal((await enrollmentsOf(user, automation)).length, 2);
		assert.equal(await m.Watch.countDocuments({ accountId: user.accountId, automationId: automation.id, contactId: bob._id }), 0, "its mark is cleared");
	});

	test("clicking a link in an issue starts it, the first time they click that link", async () => {
		const user = await customer("v2-link@example.com");
		const campaign = await t.m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Offer", status: "sent", sentAt: new Date() });
		const other = await t.m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Other", status: "sent", sentAt: new Date() });
		for (const [owner, index, url] of [[campaign, 0, "https://Example.com/offer/#top"], [campaign, 1, "https://example.com/other"], [other, 0, "https://example.com/offer"]]) {
			await m.CampaignLink.create({ accountId: user.accountId, campaignId: owner._id, index, url });
		}
		const anyIssue = await create(user, { name: "Any issue", trigger: { type: "link_clicked", url: "https://example.com/offer" }, steps: [tagStep("offer-clicker")] });
		const thisIssue = await create(user, { name: "This issue", trigger: { type: "link_clicked", url: "https://example.com/offer", campaign: String(campaign._id) }, steps: [tagStep("this-issue-clicker")] });
		const ann = await subscribe(user, "ann");
		const bob = await subscribe(user, "bob");
		const messageOf = (owner, contact) =>
			t.m.Message.create({ accountId: user.accountId, newsletterId: user.newsletterId, kind: "campaign", campaignId: owner._id, contactId: contact.id, email: contact.email, status: "delivered", sentAt: new Date() }).then((message) => message.toObject());
		const annMessage = await messageOf(campaign, ann);
		const annOther = await messageOf(other, ann);
		const bobMessage = await messageOf(campaign, bob);

		await m.linkClicks.countLinkClick(annMessage, 1);
		assert.equal((await enrollmentsOf(user, anyIssue)).length, 0, "another link");
		await m.linkClicks.countLinkClick(annMessage, 0);
		await m.linkClicks.countLinkClick({ ...annMessage, clickedLinks: [0] }, 0);
		assert.equal((await enrollmentsOf(user, anyIssue)).length, 1, "the address matches whatever its case, fragment and trailing slash");
		assert.equal((await enrollmentsOf(user, thisIssue)).length, 1);
		await m.linkClicks.countLinkClick(annOther, 0);
		assert.equal((await enrollmentsOf(user, anyIssue)).length, 1, "once, and the same contact in another issue starts only the automation for any issue");
		assert.equal((await enrollmentsOf(user, thisIssue)).length, 1);
		await m.linkClicks.countLinkClick(bobMessage, 0);
		await run();
		assert.deepEqual(await tagsOf(user, "ann"), ["offer-clicker", "this-issue-clicker"]);
		assert.deepEqual(await tagsOf(user, "bob"), ["offer-clicker", "this-issue-clicker"]);
		const link = await m.CampaignLink.findOne({ accountId: user.accountId, campaignId: campaign._id, index: 0 }).lean();
		assert.deepEqual([link.clicks, link.uniqueClicks], [3, 2], "counting clicks is as it was");
	});

	test("a referral credited starts it for the referrer each time, or at the number you name", async () => {
		const user = await customer("v2-referral@example.com");
		await t.m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { referral: { enabled: true, rewards: [] }, requireConfirmation: true, archiveEnabled: true } });
		const newsletter = await t.m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const every = await create(user, { name: "Every credit", trigger: { type: "referral_credited" }, steps: [tagStep("thanked")] });
		const three = await create(user, { name: "Three", trigger: { type: "referral_credited", referrals: 3 }, steps: [tagStep("ambassador")] });
		const referrer = await t.m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: user.address("ann"), status: "active" });
		for (let index = 1; index <= 3; index++) {
			const referred = await t.m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: user.address(`friend${index}`), status: "active" });
			await m.Referral.create({ accountId: user.accountId, newsletterId: user.newsletterId, referrerId: referrer._id, referredId: referred._id, status: "pending" });
			assert.equal((await m.referrals.creditReferral({ newsletter, contact: referred })).count, index);
		}
		assert.deepEqual((await enrollmentsOf(user, every)).map(({ cycle }) => cycle).sort(), ["r1", "r2", "r3"], "each credit is its own");
		assert.deepEqual((await enrollmentsOf(user, three)).map(({ cycle }) => cycle), ["r3"]);
		await run();
		assert.deepEqual(await tagsOf(user, "ann"), ["ambassador", "thanked"]);
	});
});

describe("templates", () => {
	test("are listed, with what each starts from and does", async () => {
		const user = await customer("v2-templates@example.com");
		const listed = await t.api(user.key, "GET", "/automation-templates");
		assert.equal(listed.status, 200, JSON.stringify(listed.body));
		assert.deepEqual(listed.body.templates.map(({ id }) => id), ["welcome-series", "re-engagement", "paid-onboarding", "product-buyer-thank-you", "paid-upsell", "referral-thanks"]);
		assert.deepEqual(listed.body.templates.map(({ trigger }) => trigger.type), ["subscribed", "unengaged", "upgraded", "product_bought", "subscribed", "referral_credited"]);
		assert.equal(listed.body.templates.length, AUTOMATION_TEMPLATES.length);
		for (const template of listed.body.templates) {
			assert.ok(template.description.length > 40 && template.steps >= 2, template.id);
			assert.match(template.summary, / → /);
		}
		assert.match(listed.body.templates[1].summary, /Branch: matches or not/);
		assert.ok(!JSON.stringify(listed.body).match(/cheap|\bAI\b/i), "no word the owner avoids");
	});

	test("each makes a draft that can be activated, and nothing is sent until then", async () => {
		const user = await customer("v2-from-template@example.com");
		for (const template of AUTOMATION_TEMPLATES) {
			const before = sesEmails.length;
			const created = await t.api(user.key, "POST", "/automations/from-template", { template: template.id });
			assert.equal(created.status, 201, JSON.stringify(created.body));
			assert.deepEqual([created.body.status, created.body.name, created.body.trigger.type], ["draft", template.automationName, template.trigger.type]);
			assert.ok(created.body.steps.length > 0 && created.body.steps.every(({ id }) => id));
			assert.equal(sesEmails.length, before);
			const activated = await t.api(user.key, "POST", `/automations/${created.body.id}/activate`);
			assert.equal(activated.status, 200, `${template.id}: ${JSON.stringify(activated.body)}`);
			assert.equal(activated.body.status, "active");
		}
		const named = await t.api(user.key, "POST", "/automations/from-template", { template: "welcome-series", name: "Our welcome" });
		assert.equal(named.body.name, "Our welcome");
		t.assertError(await t.api(user.key, "POST", "/automations/from-template", { template: "nope" }), 400, "validation_failed");
	});

	test("the welcome series sends its first email to a new subscriber and goes on from there", async () => {
		const user = await customer("v2-welcome@example.com");
		const created = await t.api(user.key, "POST", "/automations/from-template", { template: "welcome-series" });
		await t.api(user.key, "POST", `/automations/${created.body.id}/activate`);
		const before = sesEmails.length;
		await subscribe(user, "ann");
		const start = new Date();
		await run(start);
		const mails = sesEmails.slice(before).filter(({ to }) => to === user.address("ann"));
		assert.equal(mails.length, 1);
		assert.match(mails[0].subject, /^Welcome, friend$/);
		await run(new Date(start.getTime() + 2 * DAY_MS + 1000));
		assert.equal(sesEmails.slice(before).filter(({ to }) => to === user.address("ann")).length, 2);
		await run(new Date(start.getTime() + 8 * DAY_MS));
		assert.equal(sesEmails.slice(before).filter(({ to }) => to === user.address("ann")).length, 3);
		assert.deepEqual(await tagsOf(user, "ann"), ["welcomed"]);
		assert.equal((await enrollmentsOf(user, created.body))[0].status, "completed");
	});

	test("the paid upgrade offer emails free readers only, once and then once more, and leaves out anyone who paid or left", async () => {
		const user = await customer("v2-upsell@example.com");
		const created = await t.api(user.key, "POST", "/automations/from-template", { template: "paid-upsell" });
		await t.api(user.key, "POST", `/automations/${created.body.id}/activate`);
		const before = sesEmails.length;
		await subscribe(user, "free");
		await subscribe(user, "payer");
		await subscribe(user, "leaver");
		const start = new Date();
		await run(start);
		assert.equal(sesEmails.slice(before).length, 0, "nothing on the first day");

		await t.m.Contact.updateOne({ accountId: user.accountId, email: user.address("payer") }, { $set: { tier: "paid", paidUntil: new Date(Date.now() + 90 * DAY_MS) } });
		await t.m.Contact.updateOne({ accountId: user.accountId, email: user.address("leaver") }, { $set: { status: "unsubscribed" } });
		await run(new Date(start.getTime() + 14 * DAY_MS + 1000));
		const first = sesEmails.slice(before);
		assert.deepEqual(first.map(({ to }) => to), [user.address("free")]);
		assert.equal(first[0].subject, "What paid readers get");

		await run(new Date(start.getTime() + 21 * DAY_MS + 5000));
		assert.deepEqual(sesEmails.slice(before).map(({ subject }) => subject), ["What paid readers get", "One last note about paid issues"]);
		assert.deepEqual(await tagsOf(user, "free"), ["upsold"]);
		assert.deepEqual(await tagsOf(user, "payer"), []);
	});

	test("the re-engagement template tags those who came back and those who stayed quiet", async () => {
		const user = await customer("v2-reengage@example.com");
		const created = await t.api(user.key, "POST", "/automations/from-template", { template: "re-engagement" });
		await t.api(user.key, "PATCH", `/automations/${created.body.id}`, { trigger: { type: "unengaged", days: 60, includeExisting: true } });
		await t.api(user.key, "POST", `/automations/${created.body.id}/activate`);
		const old = new Date(Date.now() - 90 * DAY_MS);
		const base = { accountId: user.accountId, newsletterId: user.newsletterId, status: "active", subscribedAt: old };
		await t.m.Contact.create({ ...base, email: user.address("returns") });
		await t.m.Contact.create({ ...base, email: user.address("stays") });
		const start = new Date();
		await run(start);
		await run(start);
		await t.m.Contact.updateOne({ accountId: user.accountId, email: user.address("returns") }, { $set: { lastOpenAt: new Date(start.getTime() + 2 * DAY_MS) } });
		await run(new Date(start.getTime() + 8 * DAY_MS));
		assert.deepEqual(await tagsOf(user, "returns"), ["re-engaged"]);
		assert.deepEqual(await tagsOf(user, "stays"), ["unengaged"]);
	});
});
