import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { runAction } from "@/lib/actions/run-action";
import { getAppUrl } from "@/lib/config";
import Newsletter from "@/models/Newsletter";
import BootstrapRun from "@/models/BootstrapRun";

export async function bootstrapNewsletter(account, input, user = null) {
	const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
	const filter = scoped(account, { externalId: input.externalId });
	await BootstrapRun.updateOne(filter, { $setOnInsert: { ...filter, fingerprint, steps: {} } }, { upsert: true });
	let run = await BootstrapRun.findOne(filter).lean();
	if (run.fingerprint !== fingerprint) throw actionError("conflict", "This bootstrap key already belongs to a different brief");
	const lease = randomUUID(), now = new Date();
	const claimed = await BootstrapRun.updateOne({ ...filter, $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] }, { $set: { lease, leaseUntil: new Date(now.getTime() + 180_000) } });
	if (!claimed.modifiedCount) throw actionError("conflict", "This bootstrap is already running. Retry the same key shortly");
	const call = (name, payload) => runAction(name, { account, user, input: payload, via: "bootstrap" });
	async function step(name, build) {
		if (run.steps?.[name]) return run.steps[name];
		const value = await build();
		await BootstrapRun.updateOne({ ...filter, lease }, { $set: { [`steps.${name}`]: value } });
		run = { ...run, steps: { ...run.steps, [name]: value } };
		return value;
	}
	try {
		const prefix = `bootstrap:${input.externalId}`;
		const newsletter = await step("newsletter", () => call("create_newsletter", {
			externalId: prefix, name: input.name, ...(input.slug && { slug: input.slug }),
			description: input.description ?? "", ...(input.fromEmail && { fromEmail: input.fromEmail }),
			requireConfirmation: true, archiveEnabled: false,
			welcome: { enabled: false, subject: input.welcomeSubject || `Welcome to ${input.name}`, markdown: input.welcomeContent || `Thanks for joining ${input.name}.` },
		}));
		await Newsletter.updateOne(scoped(account, { _id: newsletter.id, agentBrief: { $exists: false } }), { $set: { agentBrief: input.brief } });
		const target = { newsletter: newsletter.id };
		const form = await step("form", () => call("create_form", { ...target, externalId: `${prefix}:form`, name: "Newsletter signup", buttonText: "Subscribe" }));
		const linkPage = await step("linkPage", () => call("update_link_page", { ...target, enabled: false, title: input.name.slice(0, 80), bio: input.description ?? "", links: input.links ?? [] }));
		const batch = await step("batch", () => call("create_editorial_batch", { ...target, name: "First four issues", description: input.brief.slice(0, 1000), externalId: `${prefix}:plan` }));
		const drafts = input.drafts ?? ["Welcome", "A practical guide", "Common questions", "Next steps"].map((subject) => ({ subject, content: "" }));
		const campaigns = [];
		for (let index = 0; index < 4; index++) {
			const draft = drafts[index];
			const campaign = await step(`draft${index}`, () => call("create_campaign", { ...target, externalId: `${prefix}:issue:${index}`, subject: draft.subject, ...(draft.content && { format: "markdown", content: draft.content }) }));
			await step(`item${index}`, () => call("create_content_item", { ...target, channel: "newsletter", title: draft.subject, campaign: campaign.id, batch: batch.batch.id, externalId: `${prefix}:item:${index}`, notes: "Draft for review. No publication or sending is planned yet." }));
			campaigns.push({ id: campaign.id, subject: campaign.subject, status: campaign.status });
		}
		await BootstrapRun.updateOne({ ...filter, lease }, { $set: { completedAt: new Date() } });
		return { newsletterId: newsletter.id, slug: newsletter.slug, formId: form.id, batchId: batch.batch.id, linkPageUrl: linkPage.url, reviewUrl: `${getAppUrl()}/campaigns/calendar/batches/${batch.batch.id}`, drafts: campaigns, domainSteps: input.domain ? [{ domain: input.domain, action: "add_domain", status: "not_started" }] : [], sent: false, published: false };
	} finally {
		await BootstrapRun.updateOne({ ...filter, lease }, { $unset: { lease: 1, leaseUntil: 1 } });
	}
}
