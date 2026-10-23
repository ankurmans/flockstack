import "server-only";
import * as z from "zod";
import { EDITABLE_STATUSES, findCampaign } from "@/lib/actions/campaigns";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { idInput } from "@/lib/actions/shared";
import { runReadyCheck } from "@/lib/ready-check-data";

const GROUP = "Campaigns";
const campaignId = idInput("campaign");

const ItemSchema = z.object({
	id: z.string().describe("subject, preview, content, spam, unsubscribe, size, address, sender, links, images-alt, images-size, merge-tags, audience, plan, free-footer, paywall, test, sending or website"),
	status: z.enum(["pass", "warning", "blocker", "info"]).describe("blocker: sending is refused until it's fixed. warning: worth a look, never stops a send. info: something to know."),
	title: z.string(),
	message: z.string().describe("One plain sentence"),
	fix: z
		.object({
			label: z.string(),
			target: z.enum(["subject", "previewText", "body", "send", "test", "settings", "billing"]).describe("What to change: a field of the draft, the send step, a test email, the newsletter's settings or the plans"),
			url: z.string().describe("A dashboard page where it can be done"),
		})
		.nullable(),
});

const checkCampaign = defineAction({
	name: "check_campaign",
	tryWithoutPlan: true,
	title: "Check that a campaign is ready to send",
	group: GROUP,
	description:
		"Runs the dashboard's ready-to-send check on a draft or scheduled campaign, so an agent can look before it proposes a send: subject length and tone, preview text, content, the unsubscribe link and the postal address, the sender address, the links (up to 20, opened from FlockStack's servers by a short background job), the pictures' alt text and sizes, merge tags that some contacts have no value for, who it goes to, the plan's limits and a test email. Each item is pass, warning, blocker or info with one sentence and where to fix it. A blocker is something the send itself would refuse; warnings never stop a send. The links come back as info with isChecking true on the first call: ask again after a few seconds.",
	http: { method: "GET", path: "/campaigns/{id}/check" },
	readOnly: true,
	openWorld: true,
	limitDashboard: false,
	rateLimit: { limit: 60, window: "1 h" },
	input: z.object({ id: campaignId }),
	output: z.object({
		campaignId: z.string(),
		items: z.array(ItemSchema),
		blockers: z.number().int(),
		warnings: z.number().int(),
		canSend: z.boolean().describe("No blocker: a send would not be refused for these reasons"),
		isChecking: z.boolean().describe("The links are still being opened: ask again in a few seconds for their result"),
		checkedAt: z.string(),
	}),
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		if (!EDITABLE_STATUSES.includes(campaign.status)) throw actionError("conflict", `This campaign is ${campaign.status}: only drafts and scheduled campaigns are checked`);
		return { campaignId: String(campaign._id), ...(await runReadyCheck({ account, campaign })) };
	},
});

export const campaignCheckActions = [checkCampaign];
