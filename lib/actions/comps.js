import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, toIso } from "@/lib/actions/shared";
import { findCompContact, giveComp, readCompEnd, MAX_COMP_YEARS } from "@/lib/comps";
import { revokeGrant } from "@/lib/grant-access";
import { getActiveGrant, isGrantDriving } from "@/lib/grants";
import { findTier, getNewsletterTiers, getOfferedTiers } from "@/lib/tier-rules";
import { isPaidContact } from "@/lib/tiers";
import Contact from "@/models/Contact";

const GROUP = "Comps";
const newsletterId = z.string().trim().min(1).max(100).describe("The newsletter's ID or slug");

const CompSchema = z.object({
	contactId: z.string(),
	email: z.string(),
	tierId: z.string(),
	tierName: z.string(),
	endsAt: z.string().describe("When the comp ends, and the reader is free again unless they pay"),
	grantedAt: dateOutput,
	note: z.string().nullable().describe("Your private note on why"),
	alsoPays: z.boolean().describe("The reader also pays with a Stripe subscription, which counts first; the comp holds after it ends"),
});

function toCompOutput(contact, tiers) {
	const grant = contact.grant;
	return {
		contactId: String(contact._id),
		email: contact.email,
		tierId: grant.tierId,
		tierName: findTier(tiers, grant.tierId)?.name ?? grant.tierId,
		endsAt: new Date(grant.until).toISOString(),
		grantedAt: toIso(grant.at),
		note: grant.note ?? null,
		alsoPays: isPaidContact(contact) && !isGrantDriving(contact),
	};
}

const grantCompAccess = defineAction({
	name: "grant_comp_access",
	title: "Give comp access",
	group: GROUP,
	description: `Gives a contact paid access by hand until a day, in a paid tier: for press, partners or a favor. They get the paid issues like any paid reader, and the access shows apart from paying readers: it is counted as a comp, never as revenue. The contact has to be on the list already and active (add_contact). It ends on its day by itself; giving it again changes the tier or the day. A reader who pays with Stripe too keeps paying, and the comp holds after their subscription ends. It ends at most ${MAX_COMP_YEARS} years from now.`,
	http: { method: "POST", path: "/newsletters/{id}/comps", status: 201 },
	example: { contact: "press@example.com", endsAt: "2026-12-31T23:59:59Z", note: "Reviewer" },
	input: z.object({
		id: newsletterId,
		contact: z.string().trim().min(1).max(254).describe("The contact's email address or ID"),
		endsAt: z.string().max(40).describe("ISO 8601 date and time the access ends, in the future, e.g. 2026-12-31T23:59:59Z"),
		tier: z.string().trim().max(100).optional().describe("The paid tier's ID or name. Default: the lowest tier."),
		note: z.string().trim().max(200).optional().describe("A private note on why, for you. 200 characters at most."),
	}),
	output: CompSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const tiers = getNewsletterTiers(newsletter);
		const tier = input.tier
			? (findTier(tiers, input.tier.toLowerCase()) ?? tiers.find((candidate) => candidate.name.toLowerCase() === input.tier.toLowerCase()))
			: (getOfferedTiers(tiers)[0] ?? tiers[0]);
		if (!tier) throw actionError(input.tier ? "validation_failed" : "conflict", input.tier ? `tier: the newsletter has no paid tier ${JSON.stringify(input.tier)}` : "Give the newsletter a paid tier first (create_paid_tier)");
		const endsAt = readCompEnd(input.endsAt);
		const contact = await findCompContact(account, newsletter, input.contact);
		const updated = await giveComp({ account, newsletter, contact, tierId: tier.id, endsAt, note: input.note });
		return toCompOutput(updated, tiers);
	},
});

const revokeCompAccess = defineAction({
	name: "revoke_comp_access",
	title: "Take comp access away",
	group: GROUP,
	description: "Ends a contact's comp (or gift) access now. A reader it was the only paid access of is free from this moment; one who also pays with Stripe keeps paying. The contact stays on the list.",
	http: { method: "DELETE", path: "/newsletters/{id}/comps/{contactId}" },
	destructive: true,
	idempotent: true,
	input: z.object({ id: newsletterId, contactId: z.string().trim().min(1).max(254).describe("The contact's ID or email address") }),
	output: z.object({ contactId: z.string(), revoked: z.boolean().describe("false when they had no comp") }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const contact = await findCompContact(account, newsletter, input.contactId);
		if (!getActiveGrant(contact)) return { contactId: String(contact._id), revoked: false };
		await revokeGrant({ account, newsletter, contact });
		return { contactId: String(contact._id), revoked: true };
	},
});

const listComps = defineAction({
	name: "list_comps",
	title: "List comp access",
	group: GROUP,
	description: "Lists the contacts of a newsletter who have paid access by hand (comp), soonest to end first, 200 at most: when it ends, in which tier and your note. Gifts are not comps: list_gifts has those.",
	http: { method: "GET", path: "/newsletters/{id}/comps" },
	readOnly: true,
	input: z.object({ id: newsletterId }),
	output: z.object({ comps: z.array(CompSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.id);
		const contacts = await Contact.find(scoped(account, { newsletterId: newsletter._id, "grant.kind": "comp", "grant.until": { $gt: new Date() } }))
			.sort({ "grant.until": 1, _id: 1 })
			.limit(200)
			.lean();
		const tiers = getNewsletterTiers(newsletter);
		return { comps: contacts.map((contact) => toCompOutput(contact, tiers)) };
	},
});

export const compActions = [grantCompAccess, revokeCompAccess, listComps];
