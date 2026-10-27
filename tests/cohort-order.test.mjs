import assert from "node:assert/strict";
import { test } from "node:test";
import { getCohortRank, isRandomOrder, orderByCohort } from "../lib/cohort-order.js";

// Random cohort sends (parity item S8): the order a campaign takes its audience in when it isn't the most engaged first.
const CAMPAIGN = "6650f1c2e9b1d4a012345678";
const OTHER_CAMPAIGN = "6650f1c2e9b1d4a0123456ff";
// Ids in creation order, as ObjectIds from one import are: most of the characters are shared and the end counts up.
const ids = Array.from({ length: 20_000 }, (_, index) => `6650f1c2e9b1d4a0${(0x10000000 + index).toString(16)}`);

test("a rank is a number from 0 up to 1, the same every time for the same campaign and contact", () => {
	for (const id of ids.slice(0, 500)) {
		const rank = getCohortRank(CAMPAIGN, id);
		assert.ok(rank >= 0 && rank < 1, String(rank));
		assert.equal(rank, getCohortRank(CAMPAIGN, id));
	}
	assert.notEqual(getCohortRank(CAMPAIGN, ids[0]), getCohortRank(OTHER_CAMPAIGN, ids[0]));
});

test("ranks are spread evenly: every tenth of them holds about a tenth of the contacts", () => {
	const buckets = new Array(10).fill(0);
	for (const id of ids) buckets[Math.floor(getCohortRank(CAMPAIGN, id) * 10)] += 1;
	for (const count of buckets) assert.ok(Math.abs(count - 2000) < 160, buckets.join(" "));
});

test("fair: a cohort doesn't favor early or late sign-ups, or the most engaged", () => {
	// ids[0] is the oldest contact and the most engaged: engagement order is the array's order.
	const order = orderByCohort(CAMPAIGN, ids);
	const cohort = order.slice(0, 2000);
	const position = new Map(ids.map((id, index) => [id, index]));
	const mean = cohort.reduce((total, id) => total + position.get(id), 0) / cohort.length;
	assert.ok(Math.abs(mean - ids.length / 2) < ids.length * 0.03, `mean position ${mean}`);
	const quarters = [0, 0, 0, 0];
	for (const id of cohort) quarters[Math.floor((position.get(id) / ids.length) * 4)] += 1;
	for (const count of quarters) assert.ok(Math.abs(count - 500) < 90, quarters.join(" "));
	const topEngaged = cohort.filter((id) => position.get(id) < 2000).length;
	assert.ok(Math.abs(topEngaged - 200) < 60, `${topEngaged} of the 2000 most engaged are in a cohort of 2000`);
});

test("a different campaign takes a different cohort, overlapping about as much as chance does", () => {
	const first = new Set(orderByCohort(CAMPAIGN, ids).slice(0, 2000));
	const second = orderByCohort(OTHER_CAMPAIGN, ids).slice(0, 2000);
	const shared = second.filter((id) => first.has(id)).length;
	assert.ok(shared > 100 && shared < 300, `${shared} shared, 200 expected`);
});

test("every contact is in the order exactly once, and the same list gives the same order whatever order it came in", () => {
	const order = orderByCohort(CAMPAIGN, ids);
	assert.equal(order.length, ids.length);
	assert.equal(new Set(order).size, ids.length);
	const shuffled = ids.toSorted((a, b) => getCohortRank("x", a) - getCohortRank("x", b));
	assert.deepEqual(orderByCohort(CAMPAIGN, shuffled), order);
});

test("a larger cohort contains the smaller one, so a later step adds to what went out", () => {
	const order = orderByCohort(CAMPAIGN, ids);
	const early = new Set(order.slice(0, 1000));
	const later = new Set(order.slice(0, 5000));
	for (const id of early) assert.ok(later.has(id));
	// Contacts who joined after the first step can't push out anyone already sent to: the earlier ones stay in the lowest ranks
	// of the grown list unless a newcomer's rank is lower, and then it is the newcomer who is added.
	const grown = orderByCohort(CAMPAIGN, [...ids, "6650f1c2e9b1d4a0ffffffff"]);
	const missing = order.slice(0, 1000).filter((id) => !grown.slice(0, 1001).includes(id));
	assert.deepEqual(missing, []);
});

test("an empty or tiny list is fine, and only random asks for a random order", () => {
	assert.deepEqual(orderByCohort(CAMPAIGN, []), []);
	assert.deepEqual(orderByCohort(CAMPAIGN, ["6650f1c2e9b1d4a012345601"]), ["6650f1c2e9b1d4a012345601"]);
	assert.equal(isRandomOrder({ audienceOrder: "random" }), true);
	for (const campaign of [{}, { audienceOrder: "engaged" }, null, undefined]) assert.equal(isRandomOrder(campaign), false);
});
