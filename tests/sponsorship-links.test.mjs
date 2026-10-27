import assert from "node:assert/strict";
import { test } from "node:test";
import { getSponsorshipManagerLink, getSponsorshipVerificationLink, readSponsorshipToken } from "../lib/sponsorship-links.js";
process.env.BETTER_AUTH_SECRET = "synthetic-sponsorship-link-secret-only-for-tests";
const booking = { _id: "1".repeat(24), accountId: "2".repeat(24), newsletterId: "3".repeat(24), email: "private-sponsor@example.com", verificationVersion: 4, managerVersion: 7 };
const token = value => new URL(value).searchParams.get("token");

test("sponsor verification and manager capabilities are role-separated and contain no advertiser email", () => {
	const verify = token(getSponsorshipVerificationLink(booking)), manager = token(getSponsorshipManagerLink(booking));
	assert.equal(readSponsorshipToken(verify, "verify").version, 4); assert.equal(readSponsorshipToken(manager, "manager").version, 7);
	assert.equal(readSponsorshipToken(verify, "manager"), null); assert.equal(readSponsorshipToken(manager, "verify"), null);
	for (const value of [verify, manager]) assert.equal(Buffer.from(value.split(".")[0], "base64url").toString().includes(booking.email), false);
});

test("sponsor capabilities reject expiry, future dates, tampering and unbounded input", () => {
	const now = Date.parse("2026-10-25T12:00:00Z");
	const verify = token(getSponsorshipVerificationLink(booking, now));
	assert.equal(readSponsorshipToken(verify, "verify", now + 86400001), null);
	assert.equal(readSponsorshipToken(verify, "verify", now - 61000), null);
	const manager = token(getSponsorshipManagerLink(booking, now));
	assert.equal(readSponsorshipToken(manager, "manager", now + 7 * 86400000 + 1), null);
	assert.equal(readSponsorshipToken(`${manager}x`, "manager", now), null);
	assert.equal(readSponsorshipToken("a".repeat(10000), "verify", now), null);
});
