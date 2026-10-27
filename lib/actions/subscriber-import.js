import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { newsletterInput } from "@/lib/actions/shared";
export const subscriberImportActions = [defineAction({
	name: "import_stripe_subscribers", title: "Import paid subscribers from Stripe", group: "Payments", openWorld: true,
	description: "Reads up to 25 subscription IDs from your own connected Stripe account and maps their current paid or trial periods to existing newsletter tiers. Preview by default; apply: true and consent: true import them. Preserves opt-outs and suppressions, sends no welcome emails, enrolls no automations, creates no charges and changes nothing in Stripe. Single-price subscriptions only. Retries reuse subscription IDs. Future signed Stripe events keep the mapped access current.",
	http: { method: "POST", path: "/payments/import-subscribers" }, idempotent: true, rateLimit: { limit: 20, window: "1 h" },
	input: z.object({ newsletter: newsletterInput, subscriptions: z.array(z.string().regex(/^sub_[A-Za-z0-9]+$/)).min(1).max(25).describe("Existing Stripe subscription IDs"), prices: z.record(z.string().regex(/^price_[A-Za-z0-9]+$/), z.string().max(100)).describe("Source Stripe price ID to existing FlockStack tier ID"), apply: z.boolean().default(false).describe("False previews; true imports"), consent: z.boolean().default(false).describe("These readers agreed to receive this newsletter") }),
	output: z.object({ applied: z.boolean(), emailsSent: z.number(), chargesCreated: z.number(), rows: z.array(z.object({ id: z.string(), status: z.string(), priceId: z.string().nullable(), tierId: z.string().nullable(), paidUntil: z.string().nullable(), error: z.string().nullable() })) }),
	handler: async ({ account, input }) => (await import("@/lib/payments/subscriber-import")).importStripeSubscribers(account, input),
})];
