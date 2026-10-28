import "server-only";
import * as z from "zod";
import { CampaignSchema, EDITABLE_STATUSES, findCampaign } from "@/lib/actions/campaigns";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, idInput, toIso } from "@/lib/actions/shared";
import { CLAIM_CHECK } from "@/lib/claim-check-rules";
import { runReadyCheck } from "@/lib/ready-check-data";
import { CAMPAIGN_STATUSES } from "@/models/Campaign";

const GROUP = "Campaigns";
const campaignId = idInput("campaign");
const COUNT_KEYS = ["recipients", "sent", "delivered", "opened", "clicked", "bounced", "unsubscribed", "complained", "failed"];

const getCampaignProgress = defineAction({
	name: "get_campaign_progress",
	tryWithoutPlan: true,
	title: "Get a send's progress",
	group: GROUP,
	description:
		"The counters of a campaign as they are now, light enough to ask every few seconds while it goes out: emails to send, sent, delivered, opened, clicked, bounced, unsubscribed, complained and failed. isLive is true while it is held for its undo window or sending; ask until it is false.",
	http: { method: "GET", path: "/campaigns/{id}/progress" },
	readOnly: true,
	input: z.object({ id: campaignId }),
	output: z.object({
		id: z.string(),
		status: z.enum(CAMPAIGN_STATUSES),
		subject: z.string(),
		isLive: z.boolean().describe("Held for its undo window, or still sending: the counters are still moving"),
		counts: z.object(Object.fromEntries(COUNT_KEYS.map((key) => [key, z.number().int()]))).describe("recipients is the issues the send will make; the rest count what happened to them"),
		hold: CampaignSchema.shape.hold,
		sentAt: dateOutput,
		serverTime: z.string().describe("The server's clock, ISO 8601, to count down to hold.sendAfter against"),
	}),
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		const stats = campaign.stats ?? {};
		return {
			id: String(campaign._id),
			status: campaign.status,
			subject: campaign.subject ?? "",
			isLive: campaign.status === "held" || campaign.status === "sending",
			counts: Object.fromEntries(COUNT_KEYS.map((key) => [key, stats[key] ?? 0])),
			hold: campaign.status === "held" && campaign.hold?.sendAfter ? { sendAfter: toIso(campaign.hold.sendAfter), recipients: campaign.hold.recipients ?? 0 } : null,
			sentAt: toIso(campaign.sentAt),
			serverTime: new Date().toISOString(),
		};
	},
});

const ItemSchema = z.object({
	id: z.string().describe("subject, preview, content, spam, unsubscribe, size, address, sender, links, claims, images-alt, images-size, merge-tags, audience, plan, free-footer, paywall, test, sending or website"),
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

const LinkFinding = z.object({ url: z.string(), reason: z.string() });
const FigureFinding = z.object({
	figure: z.string().describe("The figure as the issue writes it, like $1.7 billion or 8%"),
	text: z.string().describe("The paragraph or list item it is in, cut at 120 characters"),
	urls: z.array(z.string()).describe("The pages it was looked for on: the ones its paragraph links to, the first 3"),
});

const ClaimsSchema = z
	.object({
		state: z.enum(["none", "checking", "done", "error"]).describe("none: no figure and no link to check. checking: ask again in a few seconds. error: it couldn't start (too many checks this hour); ask again later."),
		required: z.boolean().describe("The newsletter's requireClaimCheck: a send is refused until the check passes on the issue's words as they are"),
		passed: z.boolean().nullable().describe("No dead link, no figure missing from its pages and no figure without a source; null until it is done"),
		deadLinks: z.array(LinkFinding).describe("Links that don't load: gone (404, 410 or another 4xx), unreachable, a name that doesn't resolve, or an address inside a private network, which is never opened"),
		unsureLinks: z.array(LinkFinding).describe("Links the site wouldn't let the check confirm (401, 403, 429, a server error, too slow, or robots.txt): not counted as dead"),
		unmatchedFigures: z.array(FigureFinding).describe("Figures that are on none of the pages their paragraph links to, every one of which was read"),
		unconfirmedFigures: z.array(FigureFinding.extend({ reason: z.string() })).describe("Figures whose pages couldn't all be read (a file, a refusal, robots.txt, plain http, the check's limits), so they are neither found nor missing"),
		uncitedClaims: z.array(z.object({ text: z.string(), figures: z.array(z.string()) })).describe("Paragraphs and list items that state figures and link to no source"),
		counts: z.object({ deadLinks: z.number().int(), unsureLinks: z.number().int(), unmatchedFigures: z.number().int(), unconfirmedFigures: z.number().int(), uncitedClaims: z.number().int() }).describe("The totals; each list above has the first 20"),
		figuresChecked: z.number().int().describe("Figures that had a page to be looked for on"),
		linksChecked: z.number().int(),
		linksTotal: z.number().int(),
		pagesRead: z.number().int(),
		checkedAt: z.string().nullable(),
	})
	.describe(`The claim check, on any issue: dead links, figures not on the pages they link to, and figures with no source. Code only, no AI model. Up to ${CLAIM_CHECK.maxLinks} links and ${CLAIM_CHECK.maxPages} pages read a check, kept for the issue's words for a day. Its findings are warnings unless the newsletter has requireClaimCheck on.`);

const checkCampaign = defineAction({
	name: "check_campaign",
	tryWithoutPlan: true,
	title: "Check that a campaign is ready to send",
	group: GROUP,
	description:
		`Runs the dashboard's ready-to-send check on a draft or scheduled campaign, so an agent can look before it proposes a send: subject length and tone, preview text, content, the unsubscribe link and the postal address, the sender address, the links (up to 20, opened from FlockStack's servers by a short background job), the pictures' alt text and sizes, merge tags that some contacts have no value for, who it goes to, the plan's limits and a test email. It also runs the claim check (claims): links that don't load, figures in a paragraph or list item that aren't on any page it links to, and paragraphs that state figures with no source, from up to ${CLAIM_CHECK.maxPages} pages read by FlockStack's servers under robots.txt; dates, years, list numbers and numbers in addresses are left out, and $1.7 billion, 1.7bn and 1,700,000,000 count as the same figure. Each item is pass, warning, blocker or info with one sentence and where to fix it. A blocker is something the send itself would refuse; warnings never stop a send. The claim check's findings are warnings, or blockers when the newsletter has requireClaimCheck on. The links and the claim check come back as info with isChecking true on the first call (checking names which): ask again after a few seconds.`,
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
		isChecking: z.boolean().describe("The links or the claim check are still being opened: ask again in a few seconds for their result"),
		checking: z.array(z.enum(["links", "claims"])).describe("Which of them are still running"),
		claims: ClaimsSchema,
		checkedAt: z.string(),
	}),
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		if (!EDITABLE_STATUSES.includes(campaign.status)) throw actionError("conflict", `This campaign is ${campaign.status}: only drafts and scheduled campaigns are checked`);
		return { campaignId: String(campaign._id), ...(await runReadyCheck({ account, campaign })) };
	},
});

export const campaignCheckActions = [getCampaignProgress, checkCampaign];
