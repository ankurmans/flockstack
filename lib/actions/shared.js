import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { findOwnerEmail } from "@/lib/accounts";
import { actionError } from "@/lib/actions/errors";
import { isSendingEnabled } from "@/lib/config";
import { getUsage } from "@/lib/usage";
import { isObjectIdString } from "@/lib/validation";
import Newsletter from "@/models/Newsletter";

export const idInput = (thing) => z.string().trim().min(1).max(100).describe(`The ${thing}'s ID`);
const newsletterReference = z.string().trim().min(1).max(100).optional();
export const newsletterInput = newsletterReference.describe(
	"The newsletter's ID or slug. Default: the account's first newsletter, the one it has had longest."
);
export const newsletterFilterInput = newsletterReference.describe("Only this newsletter's: its ID or slug. Default: every newsletter.");

export const dateOutput = z.string().nullable();
const NO_LIMIT = "null on a self-hosted server without billing: no limit";
export const UsageSchema = z.object({
	emailsSent: z.number().int().describe("Emails sent this month, every kind counted"),
	emailsLimit: z.number().int().nullable().describe(`The plan's emails a month. ${NO_LIMIT}`),
	extraEmailsSent: z.number().int().describe("Campaign, welcome and automation emails sent this month past the plan's emails, billed as extra emails"),
	extraEmailsLimit: z
		.number()
		.int()
		.nullable()
		.describe(`How many extra emails the account may send this month past the plan's: 0 when it can't (a free plan, or a plan without extra emails). ${NO_LIMIT}`),
	emailsLeft: z.number().int().nullable().describe(`What the month has left, extra emails included. ${NO_LIMIT}`),
	subscribers: z.number().int().describe("Active contacts"),
	subscribersLimit: z.number().int().nullable().describe(NO_LIMIT),
	periodStart: dateOutput,
	periodEnd: dateOutput.describe("When the email count starts over"),
	welcomeEmailsPaused: z
		.boolean()
		.describe(
			"This month's emails are used up: new subscribers get no welcome email until the count starts over or the plan grows, and don't get it later. Confirmation emails still go out."
		),
});

export function toIso(value) {
	return value ? new Date(value).toISOString() : null;
}

export function toId(value) {
	return value ? String(value) : null;
}

export { afterCursor, encodeCursor } from "@/lib/actions/cursor";

export async function getUsageOutput(account) {
	const usage = await getUsage(account);
	return {
		...usage,
		emailsLeft: usage.emailsLimit === null ? null : Math.max(0, usage.emailsLimit + usage.extraEmailsLimit - usage.emailsSent),
		periodStart: toIso(usage.periodStart),
		periodEnd: toIso(usage.periodEnd),
	};
}

export function findFirstNewsletter(account, select) {
	const query = Newsletter.findOne(scoped(account)).sort({ createdAt: 1, _id: 1 });
	return (select ? query.select(select) : query).lean();
}

// By ID or slug. Without one, the account's first newsletter: a site's signup form or an agent set up while the
// account had one keeps reaching that one once there are more.
export async function findNewsletter(account, reference, select) {
	const value = reference?.trim().toLowerCase();
	if (!value) {
		const first = await findFirstNewsletter(account, select);
		if (!first) throw actionError("not_found", "Create a newsletter first");
		return first;
	}
	const query = Newsletter.findOne(scoped(account, isObjectIdString(value) ? { $or: [{ _id: value }, { slug: value }] } : { slug: value }));
	const found = await (select ? query.select(select) : query).lean();
	if (!found) throw actionError("not_found", "Newsletter not found");
	return found;
}

// Test emails go to the signed-in user, or to the account's owner when an API key asks.
export async function findTestRecipient({ account, user }) {
	return user?.email ?? (await findOwnerEmail(account._id));
}

export function assertSendingEnabled() {
	if (!isSendingEnabled()) throw actionError("sending_disabled", "Sending is off");
}

export function readPositiveInteger(value) {
	return Number.isInteger(value) && value > 0 ? value : undefined;
}
