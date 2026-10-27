import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter, newsletterInput } from "@/lib/actions/shared";
import { APPROVAL_BATCH, approveHeldContacts, rejectHeldContacts } from "@/lib/signup-approval";
import { isObjectIdString } from "@/lib/validation";

const GROUP = "Contacts";

const selection = {
	newsletter: newsletterInput,
	contactIds: z.array(z.string().trim().max(64)).max(APPROVAL_BATCH).optional().describe(`Contacts with the held status, ${APPROVAL_BATCH} at most. Send this or all.`),
	all: z.boolean().optional().describe(`Every held contact, oldest first, ${APPROVAL_BATCH} at a time: remaining says whether to call again. Send this or contactIds.`),
};

function readSelection(input) {
	if (input.all && input.contactIds?.length) throw actionError("validation_failed", "Send contactIds or all, not both");
	if (!input.all && !input.contactIds?.length) throw actionError("validation_failed", "Send contactIds, or all to take every held contact");
	const bad = (input.contactIds ?? []).find((id) => !isObjectIdString(id));
	if (bad) throw actionError("validation_failed", `contactIds: ${bad} isn't a contact ID`);
	return { contactIds: input.contactIds ?? [], all: Boolean(input.all) };
}

const approveHeldSignups = defineAction({
	name: "approve_held_signups",
	tryWithoutPlan: true,
	title: "Approve held signups",
	group: GROUP,
	description: "Lets people in whose signups the newsletter is holding for approval (update_newsletter signupApproval; list_contacts with status held). Each becomes an active subscriber as if they had just confirmed: automations that start on a subscription start, the welcome email goes out if it is on, and webhook endpoints hear subscriber.approved. A contact that is no longer held is skipped.",
	http: { method: "POST", path: "/contacts/approve" },
	openWorld: true,
	rateLimit: { limit: 60, window: "1 h" },
	example: { all: true },
	input: z.object(selection),
	output: z.object({
		approved: z.number().int().describe("Contacts let in by this call"),
		remaining: z.number().int().nullable().describe("With all: how many are still held, so a larger queue takes another call. null with contactIds"),
	}),
	handler: async ({ account, input }) => approveHeldContacts({ account, newsletter: await findNewsletter(account, input.newsletter), ...readSelection(input) }),
});

const rejectHeldSignups = defineAction({
	name: "reject_held_signups",
	tryWithoutPlan: true,
	title: "Reject held signups",
	group: GROUP,
	description: "Turns held signups down by deleting the contacts: nothing about them is kept and they can ask to join again. They are not emailed. It can't be undone.",
	http: { method: "POST", path: "/contacts/reject" },
	destructive: true,
	rateLimit: { limit: 60, window: "1 h" },
	example: { contactIds: ["6650f1c2e9b1d4a012345678"] },
	input: z.object(selection),
	output: z.object({
		rejected: z.number().int().describe("Contacts deleted by this call"),
		remaining: z.number().int().nullable().describe("With all: how many are still held. null with contactIds"),
	}),
	handler: async ({ account, input }) => rejectHeldContacts({ account, newsletter: await findNewsletter(account, input.newsletter), ...readSelection(input) }),
});

export const signupApprovalActions = [approveHeldSignups, rejectHeldSignups];
