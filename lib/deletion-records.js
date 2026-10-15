import "server-only";
import crypto from "node:crypto";
import { sendAlert } from "@/lib/alerts";
import { getAppSecret } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { normalizeEmail } from "@/lib/validation";
import DeletionRecord from "@/models/DeletionRecord";

// Keyed with a key derived from BETTER_AUTH_SECRET: a plain hash of an email is easy to reverse with a list of emails.
function getHashKey() {
	return Buffer.from(crypto.hkdfSync("sha256", getAppSecret(), "", "mailcheap-deleted-email-v1", 32));
}

export function hashEmail(email) {
	const value = normalizeEmail(email) ?? String(email ?? "").trim().toLowerCase();
	return crypto.createHmac("sha256", getHashKey()).update(value).digest("base64url");
}

// The first request's date stays, and a purge that runs again finds the record there.
export async function recordDeletion({ account, email, requestedAt }) {
	await DeletionRecord.updateOne(
		{ accountId: account._id },
		{ $setOnInsert: { emailHash: hashEmail(email), accountCreatedAt: account.createdAt, requestedAt } },
		{ upsert: true }
	);
}

// A restored account wasn't deleted after all.
export function forgetDeletion(accountId) {
	return DeletionRecord.deleteOne({ accountId });
}

export function markPurged(accountId) {
	return DeletionRecord.updateOne({ accountId }, { $set: { purgedAt: new Date() } });
}

// A new account whose email deleted one before: the admins hear of it, so abuse can be noticed. Never throws.
export async function noticeDeletedBefore(email) {
	try {
		await connectDb();
		const record = await DeletionRecord.findOne({ emailHash: hashEmail(email) }).sort({ requestedAt: -1 }).lean();
		if (!record) return;
		await sendAlert({
			accountId: null,
			key: `deleted-email-signup:${record.accountId}`,
			title: "A deleted account's email signed up again",
			detail: `${email} deleted account ${record.accountId} on ${record.requestedAt.toISOString().slice(0, 10)}.`,
			path: "/admin",
		});
	} catch (error) {
		console.error("[account] Could not check deletion records:", error.message);
	}
}
