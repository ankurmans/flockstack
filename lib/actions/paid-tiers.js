import { emitRecordEvent } from "@/lib/record-events";
import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter } from "@/lib/actions/shared";
import { MAX_PRICE_CENTS, MIN_PRICE_CENTS } from "@/lib/payments/config";
import { retireTierProduct, updateTierProductDescription } from "@/lib/payments/tier-prices";
import { countTierReaders, hasTierHolders, requireTier, storeTiers, syncTierIfLive } from "@/lib/paid-tiers";
import { countFoundingMembers, listFoundingMembers } from "@/lib/supporters";
import { MAX_BENEFITS, MAX_PAID_TIERS, getNewsletterTiers, getOfferedTiers, makeTierId } from "@/lib/tier-rules";
import Contact from "@/models/Contact";

const GROUP = "Paid tiers";
const NO_CUT = "FlockStack takes no cut of what you earn: readers pay your own Stripe account, and only Stripe's own processing fee comes off.";
const newsletterId = z.string().trim().min(1).max(100).describe("The newsletter's ID or slug");

const priceInput = (what) =>
	z
		.number()
		.int()
		.min(0)
		.max(MAX_PRICE_CENTS)
		.describe(`The ${what} price in the currency's smallest unit, e.g. 800 for $8.00; at least ${MIN_PRICE_CENTS}, or 0 to not offer it`);

const TierSchema = z.object({
	id: z.string().describe("The tier's ID. A newsletter from before tiers has one tier with the ID paid."),
	name: z.string(),
	description: z.string(),
	benefits: z.array(z.string()).describe("What the tier includes, one line each"),
	rank: z.number().int().describe("0 is the lowest tier; a paid issue for a tier also reaches the tiers above it"),
	monthlyCents: z.number().int().describe("0: not offered"),
	quarterlyCents: z.number().int().describe("0: not offered. Billed every 3 months."),
	yearlyCents: z.number().int().describe("0: not offered"),
	lifetimeCents: z.number().int().describe("0: not offered. One payment that never renews."),
	payWhatYouWant: z
		.object({ minCents: z.number().int(), interval: z.enum(["month", "year"]) })
		.nullable()
		.describe("The reader names the price, at least minCents, billed on this interval; null when the tier doesn't offer it"),
	founding: z
		.object({
			enabled: z.boolean().describe("A founding or supporter tier: the same content for more money, shown as a way to back the writer"),
			cap: z.number().int().nullable().describe("The most founding members, or null for no limit"),
			taken: z.number().int().describe("Founding members now"),
			spotsLeft: z.number().int().nullable().describe("null without a cap"),
		})
		.describe("The founding member settings"),
	archived: z.boolean().describe("Hidden from the subscribe page: new readers can't pick it, its readers keep it"),
	offered: z.boolean().describe("Readers can pick it now: not archived, and it has a price"),
	stripeProductId: z.string().nullable().describe("The Product made on your Stripe account, once the tier is live"),
	readers: z.object({
		paid: z.number().int().describe("Active contacts paid in this tier now"),
		paying: z.number().int().describe("Of those, who pay (a trial counts)"),
		comp: z.number().int().describe("Of those, who have free access you gave them by hand"),
		gift: z.number().int().describe("Of those, who are on a gift"),
	}),
});

const TiersSchema = z.object({
	newsletterId: z.string(),
	enabled: z.boolean().describe("The newsletter's paid tiers are open to new subscribers"),
	currency: z.string().describe("The currency of every tier's prices"),
	tiers: z.array(TierSchema).describe("From the lowest tier to the highest"),
});

async function toTier(account, newsletter, tier, rank) {
	const readers = await countTierReaders(account, newsletter, tier.id);
	const taken = tier.founding.enabled ? await countFoundingMembers(account, newsletter, tier) : 0;
	return {
		id: tier.id,
		name: tier.name,
		description: tier.description,
		benefits: tier.benefits,
		rank,
		monthlyCents: tier.prices.month,
		quarterlyCents: tier.prices.quarter,
		yearlyCents: tier.prices.year,
		lifetimeCents: tier.prices.lifetime,
		payWhatYouWant: tier.pwyw.enabled ? { minCents: tier.pwyw.minCents, interval: tier.pwyw.interval } : null,
		founding: {
			enabled: tier.founding.enabled,
			cap: tier.founding.cap,
			taken,
			spotsLeft: tier.founding.enabled && tier.founding.cap ? Math.max(0, tier.founding.cap - taken) : null,
		},
		archived: tier.archived,
		offered: getOfferedTiers([tier]).length > 0,
		stripeProductId: tier.stripe?.productId ?? null,
		readers: { paid: readers.total, paying: readers.paying, comp: readers.comp, gift: readers.gift },
	};
}

export async function toTiersOutput(account, newsletter) {
	const tiers = getNewsletterTiers(newsletter);
	return {
		newsletterId: String(newsletter._id),
		enabled: Boolean(newsletter.paidTier?.enabled),
		currency: newsletter.paidTier?.currency ?? "usd",
		tiers: await Promise.all(tiers.map((tier, rank) => toTier(account, newsletter, tier, rank))),
	};
}

const pricesFields = {
	monthlyCents: priceInput("monthly").optional(),
	quarterlyCents: priceInput("quarterly (every 3 months)").optional(),
	yearlyCents: priceInput("yearly").optional(),
	lifetimeCents: priceInput("lifetime (one payment, never renews)").optional(),
};

const payWhatYouWantInput = z
	.object({
		minCents: z.number().int().min(MIN_PRICE_CENTS).max(MAX_PRICE_CENTS).describe(`The least a reader can pay, ${MIN_PRICE_CENTS} or more`),
		interval: z.enum(["month", "year"]).optional().describe("How often it bills. Default: year."),
	})
	.nullable()
	.optional()
	.describe("Let readers name their price, at least minCents, billed monthly or yearly. null stops offering it.");

const foundingInput = z
	.object({
		enabled: z.boolean().optional().describe("Make this a founding or supporter tier: readers pay more for the same content and it is shown as a way to back the writer"),
		cap: z.number().int().min(1).max(1_000_000).nullable().optional().describe("The most founding members; null for no limit"),
	})
	.optional()
	.describe("Founding member settings: enabled makes it a founding tier, cap limits how many members it takes");

const textFields = {
	name: z.string().trim().min(1).max(60).describe("The tier's name, 60 characters at most"),
	description: z.string().trim().max(300).describe("A line or two on what the tier is, 300 characters at most"),
	benefits: z
		.array(z.string().trim().min(1).max(120))
		.max(MAX_BENEFITS)
		.describe(`What the tier includes, one line each, ${MAX_BENEFITS} at most`),
};

function readPrices(input, current = {}) {
	const prices = {
		month: input.monthlyCents ?? current.month ?? 0,
		quarter: input.quarterlyCents ?? current.quarter ?? 0,
		year: input.yearlyCents ?? current.year ?? 0,
		lifetime: input.lifetimeCents ?? current.lifetime ?? 0,
	};
	for (const [name, cents] of Object.entries(prices)) {
		if (cents > 0 && cents < MIN_PRICE_CENTS) throw actionError("validation_failed", `${name}: at least ${MIN_PRICE_CENTS}, or 0 to not offer it`);
	}
	return prices;
}

function readPwyw(input, current) {
	if (input.payWhatYouWant === undefined) return current;
	if (input.payWhatYouWant === null) return { enabled: false, minCents: 0, interval: current?.interval ?? "year" };
	return { enabled: true, minCents: input.payWhatYouWant.minCents, interval: input.payWhatYouWant.interval ?? current?.interval ?? "year" };
}

function hasAPrice(tier) {
	return Object.values(tier.prices).some((cents) => cents > 0) || (tier.pwyw.enabled && tier.pwyw.minCents > 0);
}

function assertNameFree(tiers, name, exceptId) {
	if (tiers.some((tier) => tier.id !== exceptId && tier.name.toLowerCase() === name.toLowerCase())) {
		throw actionError("conflict", "Another tier of this newsletter has that name");
	}
}

// The newsletter is open to subscribers: at least one tier has to stay for them to pick.
function assertStillOffered(newsletter, tiers) {
	if (newsletter.paidTier?.enabled && getOfferedTiers(tiers).length === 0) {
		throw actionError("conflict", "The paid tier is open to subscribers, and this would leave nothing for them to pick: turn it off first with set_paid_tier");
	}
}

const listPaidTiers = defineAction({
	name: "list_paid_tiers",
	title: "List a newsletter's paid tiers",
	group: GROUP,
	description: `Lists a newsletter's paid tiers from the lowest to the highest, each with its name, benefits, prices (monthly, quarterly, yearly, lifetime, pay what you want), founding member settings and how many readers hold it. A newsletter can have 3. Tier order matters: a paid issue for a tier reaches the tiers above it too (update_campaign's paidTier). ${NO_CUT}`,
	http: { method: "GET", path: "/newsletters/{id}/tiers" },
	readOnly: true,
	input: z.object({ id: newsletterId }),
	output: TiersSchema,
	handler: async ({ account, input }) => toTiersOutput(account, await findNewsletter(account, input.id)),
});

const createPaidTier = defineAction({
	name: "create_paid_tier",
	title: "Add a paid tier",
	group: GROUP,
	description: `Adds a paid tier above the existing ones, up to ${MAX_PAID_TIERS} per newsletter. Give it a name and at least one price: monthly, quarterly (every 3 months), yearly, lifetime (one payment that never renews) or pay what you want. The prices are in the newsletter's currency (set_paid_tier). Once the paid tier is open and Stripe is ready, the tier's Product and Prices are made on your own Stripe account. A founding tier (founding.enabled) is the same content for more money, shown as a way to back the writer. ${NO_CUT}`,
	http: { method: "POST", path: "/newsletters/{id}/tiers", status: 201 },
	openWorld: true,
	limitDashboard: false,
	example: { name: "Supporter", description: "Back the writing", benefits: ["Every issue", "Your name on the supporters list"], yearlyCents: 12000, founding: { enabled: true, cap: 100 } },
	input: z.object({
		id: newsletterId,
		...textFields,
		description: textFields.description.optional(),
		benefits: textFields.benefits.optional(),
		...pricesFields,
		payWhatYouWant: payWhatYouWantInput,
		founding: foundingInput,
	}),
	output: TierSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const tiers = getNewsletterTiers(newsletter);
		if (tiers.length >= MAX_PAID_TIERS) throw actionError("conflict", `A newsletter has ${MAX_PAID_TIERS} paid tiers at most: archive or delete one first`);
		assertNameFree(tiers, input.name);
		const created = {
			id: makeTierId(),
			name: input.name,
			description: input.description ?? "",
			benefits: input.benefits ?? [],
			prices: readPrices(input),
			pwyw: readPwyw(input, { enabled: false, minCents: 0, interval: "year" }),
			founding: { enabled: input.founding?.enabled ?? false, cap: input.founding?.cap ?? null },
			archived: false,
			stripe: {},
		};
		if (!hasAPrice(created)) throw actionError("validation_failed", "Give the tier a price: monthlyCents, quarterlyCents, yearlyCents, lifetimeCents or payWhatYouWant");
		const live = await syncTierIfLive({ account, newsletter, tier: created });
		await storeTiers(account, newsletter, [...tiers, live]);
		await emitRecordEvent("paid_tier.created", { accountId: account._id, newsletterId: newsletter._id, id: live.id });
		return toTier(account, newsletter, live, tiers.length);
	},
});

const updatePaidTier = defineAction({
	name: "update_paid_tier",
	title: "Change a paid tier",
	group: GROUP,
	description: `Changes a paid tier's name, description, benefits, prices or founding member settings. Send only the fields to change; a price of 0 stops offering that plan. archived hides the tier from the subscribe page without touching its readers. A new price makes a new Price on your Stripe account: readers already subscribed keep what they pay. ${NO_CUT}`,
	http: { method: "PATCH", path: "/newsletters/{id}/tiers/{tierId}" },
	idempotent: true,
	openWorld: true,
	example: { yearlyCents: 9000 },
	input: z.object({
		id: newsletterId,
		tierId: z.string().trim().min(1).max(100).describe("The tier's ID or name"),
		name: textFields.name.optional(),
		description: textFields.description.optional(),
		benefits: textFields.benefits.optional(),
		...pricesFields,
		payWhatYouWant: payWhatYouWantInput,
		founding: foundingInput,
		archived: z.boolean().optional().describe("Hide the tier from the subscribe page. Its readers keep it."),
	}),
	output: TierSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const { tier, tiers } = requireTier(newsletter, input.tierId);
		if (input.name !== undefined) assertNameFree(tiers, input.name, tier.id);
		const next = {
			...tier,
			name: input.name ?? tier.name,
			description: input.description ?? tier.description,
			benefits: input.benefits ?? tier.benefits,
			prices: readPrices(input, tier.prices),
			pwyw: readPwyw(input, tier.pwyw),
			founding: { enabled: input.founding?.enabled ?? tier.founding.enabled, cap: input.founding?.cap === undefined ? tier.founding.cap : input.founding.cap },
			archived: input.archived ?? tier.archived,
		};
		if (!next.archived && !hasAPrice(next)) throw actionError("validation_failed", "A tier needs a price: archive it instead of removing them all");
		const live = await syncTierIfLive({ account, newsletter, tier: next });
		if (live.stripe?.productId && live.description !== tier.description) await updateTierProductDescription({ account, tier: live }).catch((error) => console.error("[tiers] Updating the product failed:", error.message));
		const updated = tiers.map((candidate) => (candidate.id === tier.id ? live : candidate));
		assertStillOffered(newsletter, updated);
		await storeTiers(account, newsletter, updated);
		await emitRecordEvent("paid_tier.updated", { accountId: account._id, newsletterId: newsletter._id, id: live.id });
		return toTier(account, newsletter, live, updated.findIndex((candidate) => candidate.id === tier.id));
	},
});

const deletePaidTier = defineAction({
	name: "delete_paid_tier",
	title: "Delete a paid tier",
	group: GROUP,
	description:
		"Deletes a paid tier nobody holds: its Prices are retired on your Stripe account and it leaves the subscribe page. A tier that readers hold, or that has ever had paid readers, answers conflict: archive it instead (update_paid_tier). It can't be undone.",
	http: { method: "DELETE", path: "/newsletters/{id}/tiers/{tierId}" },
	destructive: true,
	idempotent: true,
	openWorld: true,
	input: z.object({ id: newsletterId, tierId: z.string().trim().min(1).max(100).describe("The tier's ID or name") }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const { tier, tiers } = requireTier(newsletter, input.tierId);
		if (await hasTierHolders(account, newsletter, tier.id)) throw actionError("conflict", "Readers hold this tier: archive it instead, and they keep it");
		const remaining = tiers.filter((candidate) => candidate.id !== tier.id);
		assertStillOffered(newsletter, remaining);
		await retireTierProduct({ account, tier });
		await storeTiers(account, newsletter, remaining);
		await emitRecordEvent("paid_tier.deleted", { accountId: account._id, newsletterId: newsletter._id, id: tier.id });
		return { id: tier.id, deleted: true };
	},
});

const reorderPaidTiers = defineAction({
	name: "reorder_paid_tiers",
	title: "Order the paid tiers",
	group: GROUP,
	description: "Sets the order of the paid tiers, from the lowest to the highest: send every tier's ID once. A paid issue for a tier reaches the tiers above it, so the order says which tier includes which.",
	http: { method: "POST", path: "/newsletters/{id}/tiers/order" },
	idempotent: true,
	example: { tierIds: ["t_abc123", "paid"] },
	input: z.object({ id: newsletterId, tierIds: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_PAID_TIERS).describe("Every tier's ID, lowest first") }),
	output: TiersSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const tiers = getNewsletterTiers(newsletter);
		const ids = new Set(input.tierIds);
		if (ids.size !== input.tierIds.length || ids.size !== tiers.length || !tiers.every((tier) => ids.has(tier.id))) {
			throw actionError("validation_failed", "tierIds: list every tier of the newsletter once");
		}
		const ordered = input.tierIds.map((id) => tiers.find((tier) => tier.id === id));
		await storeTiers(account, newsletter, ordered);
		return toTiersOutput(account, { ...newsletter, paidTiers: ordered });
	},
});

const SupporterSchema = z.object({
	contactId: z.string(),
	email: z.string(),
	tierId: z.string(),
	name: z.string().nullable().describe("The name the member gave for the supporters list, null if they gave none or it was hidden"),
	since: z.string().nullable(),
	listed: z.boolean().describe("Shown on the public supporters list: the list is on and they gave a name"),
});

const listSupporters = defineAction({
	name: "list_supporters",
	title: "List the founding members",
	group: GROUP,
	description:
		"Lists a newsletter's founding members, the readers paid in a founding tier, oldest first, with the name each gave for the public supporters list (set_paid_tier's supportersPublic turns the list on; it is off by default). Only names ever appear publicly, never emails.",
	http: { method: "GET", path: "/newsletters/{id}/supporters" },
	readOnly: true,
	input: z.object({ id: newsletterId }),
	output: z.object({ publicList: z.boolean(), supporters: z.array(SupporterSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const publicList = Boolean(newsletter.paidTier?.supportersPublic);
		const members = await listFoundingMembers(account, newsletter);
		return {
			publicList,
			supporters: members.map((member) => ({
				contactId: String(member._id),
				email: member.email,
				tierId: member.paidTierId ?? "paid",
				name: member.supporterName ?? null,
				since: member.paidSince ? new Date(member.paidSince).toISOString() : null,
				listed: publicList && Boolean(member.supporterName),
			})),
		};
	},
});

const setSupporterName = defineAction({
	name: "set_supporter_name",
	title: "Set a supporter's listed name",
	group: GROUP,
	description: "Changes the name a founding member is listed under on the public supporters list, or takes them off it with null: for a name that doesn't belong on a public page.",
	http: { method: "PATCH", path: "/newsletters/{id}/supporters/{contactId}" },
	idempotent: true,
	example: { name: null },
	input: z.object({
		id: newsletterId,
		contactId: z.string().trim().min(1).max(100).describe("The contact's ID, from list_supporters"),
		name: z.string().trim().min(1).max(60).nullable().describe("The name to list them under, or null to take them off the list"),
	}),
	output: SupporterSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const member = (await listFoundingMembers(account, newsletter)).find(({ _id }) => String(_id) === input.contactId);
		if (!member) throw actionError("not_found", "Founding member not found");
		await Contact.updateOne(scoped(account, { _id: member._id }), input.name === null ? { $unset: { supporterName: 1 } } : { $set: { supporterName: input.name.replace(/[<>]/g, "") } });
		const name = input.name === null ? null : input.name.replace(/[<>]/g, "");
		return {
			contactId: String(member._id),
			email: member.email,
			tierId: member.paidTierId ?? "paid",
			name,
			since: member.paidSince ? new Date(member.paidSince).toISOString() : null,
			listed: Boolean(newsletter.paidTier?.supportersPublic) && Boolean(name),
		};
	},
});

export const paidTierActions = [listPaidTiers, createPaidTier, updatePaidTier, deletePaidTier, reorderPaidTiers, listSupporters, setSupporterName];
