import { emitRecordEvent } from "@/lib/record-events";
import "server-only";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter, newsletterInput } from "@/lib/actions/shared";
import { revalidateArchive } from "@/lib/archive-data";
import { getNewsletterTiers, findTier } from "@/lib/tier-rules";
import { isObjectIdString } from "@/lib/validation";
import Newsletter from "@/models/Newsletter";
import Product from "@/models/Product";
const perkSchema = z.object({ id: z.string(), title: z.string(), description: z.string(), url: z.string(), code: z.string(), productId: z.string().nullable(), tierId: z.string().nullable(), archived: z.boolean() });
const output = z.object({ revision: z.number().int(), perks: z.array(perkSchema) });
const dto = (newsletter) => ({ revision: newsletter.perksRevision ?? 0, perks: newsletter.perks ?? [] });
const savePerk = defineAction({
	name: "upsert_subscriber_perk", title: "Save a subscriber perk", group: "Perks", idempotent: false,
	description: "Creates or changes a private perk for paid subscribers: text, a link, a code or access to a product file. Up to 50 per newsletter. A product reference uses the current private file and must be from this newsletter. No Stripe charge, file copy or email is created. Archived perks and downloads become unavailable to readers immediately.",
	http: { method: "POST", path: "/perks" },
	input: z.object({ newsletter: newsletterInput, id: z.string().max(64).optional().describe("Existing perk ID; omit to create"), title: z.string().trim().min(1).max(120).describe("Perk name, visible to entitled subscribers"), description: z.string().trim().max(2000).default("").describe("Plain-text instructions"), url: z.union([z.literal(""), z.string().url().regex(/^https:\/\//).max(1000)]).default("").describe("Optional https destination; FlockStack does not fetch it"), code: z.string().trim().max(500).default("").describe("Optional code, shown only to entitled subscribers"), productId: z.string().nullable().default(null).describe("Product with a private file in this newsletter; null for none"), tierId: z.string().max(64).nullable().default(null).describe("Minimum paid tier, or null for all paid subscribers"), archived: z.boolean().default(false).describe("Hide the perk and refuse its downloads") }), output,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		const perks = [...(newsletter.perks ?? [])]; const index = input.id ? perks.findIndex(({ id }) => id === input.id) : -1;
		if (input.id && index < 0) throw actionError("not_found", "Perk not found");
		if (index < 0 && perks.length >= 50) throw actionError("conflict", "A newsletter can have 50 perks");
		if (input.tierId && !findTier(getNewsletterTiers(newsletter), input.tierId)) throw actionError("validation_failed", "Choose a paid tier from this newsletter");
		if (input.productId) {
			const product = isObjectIdString(input.productId) && await Product.findOne(scoped(account, { _id: input.productId, newsletterId: newsletter._id })).lean();
			if (!product?.file?.key) throw actionError("validation_failed", "Choose a product with a private file in this newsletter");
		}
		const previous = perks[index];
		const perk = { id: input.id ?? randomUUID(), title: input.title, description: input.description, url: input.url, code: input.code, productId: input.productId, tierId: input.tierId, archived: input.archived };
		if (index < 0) perks.push(perk); else perks[index] = perk;
		const revision = newsletter.perksRevision ?? 0; const version = revision ? { perksRevision: revision } : { $or: [{ perksRevision: 0 }, { perksRevision: { $exists: false } }] };
		const saved = await Newsletter.updateOne(scoped(account, { _id: newsletter._id, ...version }), { $set: { perks, perksRevision: revision + 1 } });
		if (!saved.matchedCount) throw actionError("conflict", "The perks changed. Reload and try again.");
		await emitRecordEvent(index < 0 ? "subscriber_perk.created" : input.archived && !previous.archived ? "subscriber_perk.archived" : "subscriber_perk.updated", { accountId: account._id, newsletterId: newsletter._id, id: perk.id });
		revalidateArchive(newsletter.slug); return dto({ ...newsletter, perks, perksRevision: revision + 1 });
	},
});
export const perkActions = [
	defineAction({ name: "list_subscriber_perks", title: "List subscriber perks", group: "Perks", readOnly: true, description: "The newsletter's private paid-reader perks, including archived ones. The dashboard and agents can manage them; readers get only the perks their current tier allows.", http: { method: "GET", path: "/perks" }, input: z.object({ newsletter: newsletterInput }), output, handler: async ({ account, input }) => dto(await findNewsletter(account, input.newsletter)) }),
	savePerk,
];
