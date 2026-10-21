import "server-only";
import { scoped } from "@/lib/account-scope";
import { getSharedDomain } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { FREE_PLAN, PLANS } from "@/lib/plans";
import { isReservedSlug } from "@/lib/reserved-slugs";
import { slugify } from "@/lib/slug";
import Newsletter from "@/models/Newsletter";

// The list a new account says it has, in steps of the plans' subscribers, each of which also holds one issue a week
// (about 4.33 emails per subscriber a month): each size but the ends is the id of the plan the pricing shows first, and
// Over 100,000 gets the largest plan (Max: 400,000 subscribers). Under 2,500 fits Free. Accounts keep the id, so answers
// saved under earlier steps still name a plan.
export const LIST_SIZES = [
	{ id: "none", label: "Not yet" },
	{ id: "free", label: "Under 2,500" },
	{ id: "starter", label: "2,500 to 5,000" },
	{ id: "growth", label: "5,000 to 25,000" },
	{ id: "pro", label: "25,000 to 50,000" },
	{ id: "scale", label: "50,000 to 100,000" },
	{ id: "more", label: "Over 100,000" },
];

// Where the list is now: a button for each platform, and a link for any other. Accounts keep sources saved from
// earlier choices, like Kit.
export const LIST_SOURCES = ["beehiiv", "Mailchimp", "Substack"];
export const OTHER_LIST_SOURCE = "Somewhere else";

// The plan the list size names, the largest over the last size, else Free. plans: the ones on sale.
export function getRecommendedPlanId(account, plans = PLANS) {
	const size = account?.onboarding?.listSize;
	if (size === "more") return plans.at(-1).id;
	return plans.some(({ id }) => id === size) ? size : FREE_PLAN.id;
}

// With a shared domain, a new account's first stop is /welcome, which names its newsletter. Without one, a
// newsletter needs a from address on the account's own domain, so the dashboard opens and Add a newsletter asks for it.
export async function needsOnboarding(account, newsletters = null) {
	if (!getSharedDomain()) return false;
	// The dashboard has read the account's newsletters already (lib/selected-newsletter.js): no need to ask for them again.
	if (newsletters) return newsletters.length === 0;
	await connectDb();
	return !(await Newsletter.exists(scoped(account)));
}

// The slug made from the name, numbered when another account's newsletter has it or FlockStack keeps it.
export async function findFreeSlug(name) {
	const base = slugify(name, 37) || "newsletter";
	for (let number = 1; number < 100; number++) {
		const slug = number === 1 ? base : `${base}-${number}`;
		if (!isReservedSlug(slug) && !(await Newsletter.exists({ slug }).setOptions({ crossAccount: true }))) return slug;
	}
	return `${slugify(name, 30) || "newsletter"}-${Date.now().toString(36)}`;
}
