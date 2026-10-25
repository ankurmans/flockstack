import "server-only";
import crypto from "node:crypto";
import { getSuppressionHashKeys } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { getDeliveryEmail } from "@/lib/email-aliases";
import { normalizeEmail } from "@/lib/validation";
import Contact from "@/models/Contact";
import GlobalSuppression from "@/models/GlobalSuppression";

// What imports, signups and sends say about a listed address, whichever account's email found it.
export const UNDELIVERABLE_MESSAGE = "This address can't receive email";
const BOUNCE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

// Keyed, since a plain hash of an email is easy to reverse with a list of emails. The current key first, then the previous
// ones (SUPPRESSION_HASH_KEY_PREVIOUS): entries made before a rotation are still found, and new ones are made with the first.
function getHashKeys() {
	return getSuppressionHashKeys().map((key) => Buffer.from(crypto.hkdfSync("sha256", key, "", "flockstack-global-suppression-v1", 32)));
}

function hashEmail(key, email) {
	const address = getDeliveryEmail(email) ?? String(email ?? "").trim().toLowerCase();
	return crypto.createHmac("sha256", key).update(address).digest("base64url");
}

// MongoDB's TTL monitor deletes an expired entry within a minute or so, not at once.
function isCurrent(now = new Date()) {
	return { expiresAt: { $not: { $lte: now } } };
}

// From one provider event (lib/email-events.js): addresses it says don't exist, or a spam trap's. A bounce leaves 180
// days after it and never shortens a trap's stay, which has no end.
export async function suppressGlobally({ emails, reason, detail, at = new Date() }) {
	if (emails.length === 0) return;
	await connectDb();
	const [key] = getHashKeys();
	const expiresAt = new Date(at.getTime() + BOUNCE_DAYS * DAY_MS);
	await GlobalSuppression.bulkWrite(
		emails.map((email) => ({
			updateOne: {
				filter: { emailHash: hashEmail(key, email) },
				update: reason === "trap" ? { $set: { reason, detail }, $unset: { expiresAt: 1 } } : { $setOnInsert: { reason, detail, expiresAt } },
				upsert: true,
			},
		}))
	);
}

// The ones of these addresses on the list, in one indexed read however many there are.
export async function findGloballySuppressed(emails) {
	const unique = [...new Set(emails)];
	if (unique.length === 0) return new Set();
	await connectDb();
	const keys = getHashKeys();
	const hashes = unique.map((email) => keys.map((key) => hashEmail(key, email)));
	const listed = new Set(await GlobalSuppression.distinct("emailHash", { emailHash: { $in: [...new Set(hashes.flat())] }, ...isCurrent() }));
	return new Set(unique.filter((_, index) => hashes[index].some((hash) => listed.has(hash))));
}

// A send skipped it: the contact shows as bounced, marked so its account sees why it got nothing.
export function markUndeliverable(accountId, contactId) {
	return Contact.updateOne({ accountId, _id: contactId, status: "active" }, { $set: { status: "bounced", undeliverableAt: new Date() } });
}

export async function getGlobalSuppression(email) {
	await connectDb();
	return GlobalSuppression.findOne({ emailHash: { $in: getHashKeys().map((key) => hashEmail(key, email)) }, ...isCurrent() })
		.select({ _id: 0, reason: 1, detail: 1, createdAt: 1, expiresAt: 1 })
		.lean();
}

export async function countGlobalSuppressions() {
	await connectDb();
	const [bounces, traps] = await Promise.all([
		GlobalSuppression.countDocuments({ reason: "bounce", ...isCurrent() }),
		GlobalSuppression.countDocuments({ reason: "trap" }),
	]);
	return { bounces, traps };
}

// An admin taking a wrong entry off. The contacts it stopped with this address, in every account, are active again.
// Null when it wasn't on the list.
export async function removeGlobalSuppression(email) {
	await connectDb();
	const { deletedCount } = await GlobalSuppression.deleteMany({ emailHash: { $in: getHashKeys().map((key) => hashEmail(key, email)) } });
	if (deletedCount === 0) return null;
	const emails = [...new Set([normalizeEmail(email), getDeliveryEmail(email)].filter(Boolean))];
	const { modifiedCount } = await Contact.updateMany(
		{ email: { $in: emails }, undeliverableAt: { $exists: true }, status: "bounced" },
		{ $set: { status: "active" }, $unset: { undeliverableAt: 1 } }
	).setOptions({ crossAccount: true });
	return { restored: modifiedCount };
}
