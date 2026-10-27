import assert from "node:assert/strict";
import { test } from "node:test";
import { withEnv } from "./helpers/app.mjs";
import { getGroupManagerLink, getGroupSeatLink, readGroupToken, GROUP_LINK_MAX_AGE_MS } from "../lib/group-links.js";
const A = "group-link-test-secret-A-0123456789abcdef", B = "group-link-test-secret-B-fedcba9876543210";
const NOW = Date.parse("2026-10-25T12:00:00Z");
const group = { _id: "6650f1c2e9b1d4a012345678", accountId: "6650f1c2e9b1d4a012345679", newsletterId: "6650f1c2e9b1d4a01234567a", managerVersion: 2, buyerEmail: "private-buyer@example.com" };
const seat = { id: "bd655060-2153-42dd-9fe0-4e29dbe37c77", invitationVersion: 3, email: "private-reader@example.com" };
const token = url => new URL(url).searchParams.get("token");

test("manager and seat capabilities have separate signing keys and carry no email address", async () => {
	await withEnv({ BETTER_AUTH_SECRET: A, BETTER_AUTH_SECRET_PREVIOUS: "", APP_URL: "https://eu.flockstack.io" }, () => {
		const manager = getGroupManagerLink(group, NOW), invitation = getGroupSeatLink(group, seat, NOW);
		assert.equal(new URL(manager).origin, "https://eu.flockstack.io");
		assert.deepEqual(readGroupToken(token(manager), "manager", NOW), { accountId: group.accountId, newsletterId: group.newsletterId, groupId: group._id, version: 2 });
		assert.equal(readGroupToken(token(invitation), "seat", NOW).seatId, seat.id);
		assert.equal(readGroupToken(token(manager), "seat", NOW), null); assert.equal(readGroupToken(token(invitation), "manager", NOW), null);
		for (const value of [manager, invitation]) assert.doesNotMatch(Buffer.from(token(value).split(".")[0], "base64url").toString(), /private-|example\.com|email/);
	});
});

test("group capabilities reject tampering, old and future dates and malformed references", async () => {
	await withEnv({ BETTER_AUTH_SECRET: A, BETTER_AUTH_SECRET_PREVIOUS: "" }, () => {
		const value = token(getGroupManagerLink(group, NOW));
		const changed = `${value[0] === "a" ? "b" : "a"}${value.slice(1)}`;
		assert.equal(readGroupToken(changed, "manager", NOW), null);
		assert.equal(readGroupToken(value, "manager", NOW + GROUP_LINK_MAX_AGE_MS + 1000), null);
		assert.equal(readGroupToken(value, "manager", NOW - 61000), null);
		assert.equal(readGroupToken("x".repeat(5000), "manager", NOW), null);
		assert.equal(readGroupToken(value, "unknown", NOW), null);
		assert.throws(() => getGroupManagerLink({ ...group, _id: "wrong" }, NOW));
	});
});

test("rotation verifies old links with the previous key and signs new links only with the current one", async () => {
	const old = await withEnv({ BETTER_AUTH_SECRET: A, BETTER_AUTH_SECRET_PREVIOUS: "" }, () => token(getGroupManagerLink(group, NOW)));
	const fresh = await withEnv({ BETTER_AUTH_SECRET: B, BETTER_AUTH_SECRET_PREVIOUS: A }, () => { assert.ok(readGroupToken(old, "manager", NOW)); return token(getGroupManagerLink(group, NOW)); });
	await withEnv({ BETTER_AUTH_SECRET: A, BETTER_AUTH_SECRET_PREVIOUS: "" }, () => assert.equal(readGroupToken(fresh, "manager", NOW), null));
	await withEnv({ BETTER_AUTH_SECRET: B, BETTER_AUTH_SECRET_PREVIOUS: "" }, () => { assert.equal(readGroupToken(old, "manager", NOW), null); assert.ok(readGroupToken(fresh, "manager", NOW)); });
});
