import "server-only";
import { ACCESS_FIELDS, hasActiveSubscription, isBlocked } from "@/lib/account-state";
import Account from "@/models/Account";
import Newsletter from "@/models/Newsletter";

// Signup forms and email links find a newsletter by its public slug or a signed id, whatever the account.
export function findNewsletterAnywhere(filter) {
	return Newsletter.findOne(filter).setOptions({ crossAccount: true }).lean();
}

async function findWithAccount(filter) {
	const newsletter = await findNewsletterAnywhere(filter);
	if (!newsletter) return {};
	const account = await Account.findById(newsletter.accountId).select({ ...ACCESS_FIELDS, status: 1 }).lean();
	return { newsletter, account };
}

// The newsletters of an account waiting for its deletion take no signups.
export async function findOpenNewsletter(filter) {
	const { newsletter, account } = await findWithAccount(filter);
	return newsletter && hasActiveSubscription(account) ? newsletter : null;
}

// New signups also wait while the account is blocked; its archive stays online and pending readers can confirm.
export async function findSignupNewsletter(filter) {
	const { newsletter, account } = await findWithAccount(filter);
	return newsletter && hasActiveSubscription(account) && !isBlocked(account) ? newsletter : null;
}

// Standalone reader pages (polls, surveys and token links) need only the publication's public interface language.
export async function getPublicReaderLanguage(newsletterId) {
	const id = String(newsletterId ?? "");
	if (!/^[a-f0-9]{24}$/.test(id)) return "en";
	const newsletter = await Newsletter.findOne({ _id: id }).setOptions({ crossAccount: true }).select({ language: 1 }).lean();
	return ["en", "es", "fr", "de", "it", "pt"].includes(newsletter?.language) ? newsletter.language : "en";
}
