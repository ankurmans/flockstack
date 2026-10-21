import "server-only";
import { scoped } from "@/lib/account-scope";
import { getTargetOf } from "@/lib/action-scopes";
import { getAppUrl } from "@/lib/config";
import { formatNumber } from "@/lib/format";
import { isObjectIdString } from "@/lib/validation";
import Automation from "@/models/Automation";
import Campaign from "@/models/Campaign";
import Newsletter from "@/models/Newsletter";

const TEST_EMAIL = "send_test_email";
const CAMPAIGN_ACTIONS = ["schedule_campaign", "send_campaign", "send_campaign_to_more", "resend_campaign", "resume_campaign"];
const FINGERPRINT_MODELS = { Campaign, Automation };
const MAX_VALUE_LENGTH = 200;

function line(label, value) {
	return [label, String(value)];
}

async function findCampaign(account, id) {
	return isObjectIdString(id) ? Campaign.findOne(scoped(account, { _id: id })).lean() : null;
}

// What a pending request's target looked like: to notice if it changed before the owner decides. Campaigns and automations only.
export async function getFingerprint(account, actionName, input) {
	const target = getTargetOf(actionName);
	const Model = target?.kind === "model" ? FINGERPRINT_MODELS[target.model] : null;
	if (!Model || !isObjectIdString(input?.id)) return null;
	const doc = await Model.findOne(scoped(account, { _id: input.id })).select({ status: 1, updatedAt: 1 }).lean();
	return doc ? { model: target.model, id: String(doc._id), status: doc.status ?? null, updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null } : { model: target.model, id: String(input.id), status: null, updatedAt: null };
}

async function previewCampaign(account, action, input) {
	const campaign = await findCampaign(account, input.id);
	if (!campaign) return { lines: [line("Campaign", "not found")] };
	const newsletter = await Newsletter.findOne(scoped(account, { _id: campaign.newsletterId })).select({ name: 1 }).lean();
	const lines = [line("Subject", campaign.subject || "(no subject)")];
	if (campaign.previewText) lines.push(line("Preview text", campaign.previewText));
	if (newsletter) lines.push(line("Newsletter", newsletter.name));
	try {
		// The same count the dashboard's review step shows, so what the owner reads here is what Send would do.
		const { runAction } = await import("@/lib/actions/run-action");
		const counted = await runAction("preview_campaign_recipients", {
			account,
			via: "dashboard",
			input: { id: input.id, sample: 0, ...(input.audienceLimit && { audienceLimit: input.audienceLimit }) },
		});
		lines.push(line("Goes to", `${formatNumber(counted.recipients)} contacts${counted.lastChance ? ` and ${formatNumber(counted.lastChance)} last-chance emails` : ""}`));
		lines.push(line("Segment", counted.segment?.name ?? "No segment: the whole audience"));
		lines.push(line("Fits the plan", counted.fitsPlan ? "Yes" : `No: ${counted.emailsLeft === null ? "" : `${formatNumber(counted.emailsLeft)} emails left this month`}`));
	} catch (error) {
		lines.push(line("Goes to", `couldn't be counted (${error.message})`));
	}
	lines.push(line("Audience", input.audience ?? campaign.audience ?? "all"));
	if (input.audienceLimit) lines.push(line("Limited to", `${formatNumber(input.audienceLimit)} contacts, the most engaged first`));
	if (action.name === "send_campaign_to_more") lines.push(line("Sends to", `${formatNumber(input.additional)} more contacts`));
	if (input.scheduledAt) lines.push(line("When", `${input.scheduledAt} (UTC unless the time says otherwise)`));
	else lines.push(line("When", action.name === "resume_campaign" ? "Now, the rest of the send" : "Now"));
	return { lines, links: [{ label: "Open the draft", href: `${getAppUrl()}/campaigns/${campaign._id}` }] };
}

async function previewAutomation(account, input) {
	const automation = await Automation.findOne(scoped(account, { _id: input.id })).lean();
	if (!automation) return { lines: [line("Automation", "not found")] };
	const steps = Array.isArray(automation.steps) ? automation.steps : [];
	return {
		lines: [line("Automation", automation.name), line("Status", automation.status), line("Steps", steps.length)],
		links: [{ label: "Open the automation", href: `${getAppUrl()}/automations/${automation._id}` }],
	};
}

function describeInput(input) {
	return Object.entries(input ?? {}).flatMap(([key, value]) => {
		if (Array.isArray(value)) return [line(key, `${value.length} items`)];
		if (typeof value === "string" && value) return [line(key, value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value)];
		if (typeof value === "number" || typeof value === "boolean") return [line(key, value)];
		return [];
	});
}

// What the owner sees on the Approvals page beside the exact inputs: the plain facts of what would happen.
export async function buildPreview(account, action, input) {
	let preview;
	if (CAMPAIGN_ACTIONS.includes(action.name)) preview = await previewCampaign(account, action, input);
	else if (action.name === TEST_EMAIL) {
		const campaign = await findCampaign(account, input.id);
		preview = {
			lines: [line("Subject", `[Test] ${campaign?.subject ?? "(campaign not found)"}`), line("Goes to", (input.to ?? []).join(", ")), line("Not the list", "A test email never reaches the list")],
			links: campaign ? [{ label: "Open the draft", href: `${getAppUrl()}/campaigns/${campaign._id}` }] : [],
		};
	} else if (action.name === "activate_automation" || action.name === "enroll_contacts") {
		preview = await previewAutomation(account, input);
		if (action.name === "enroll_contacts") preview.lines.push(line("Contacts", Array.isArray(input.emails) ? input.emails.length : 0));
	} else if (action.name === "import_contacts") {
		preview = { lines: [line("Contacts in this call", Array.isArray(input.contacts) ? input.contacts.length : 0), ...(input.tags?.length ? [line("Tags added to all", input.tags.join(", "))] : []), line("Consent confirmed", input.consent === true ? "Yes" : "No")] };
	} else preview = { lines: describeInput(input) };
	return { title: action.title, ...preview, links: preview.links ?? [] };
}
