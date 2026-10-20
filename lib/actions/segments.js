import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, idInput, newsletterFilterInput, newsletterInput, toIso } from "@/lib/actions/shared";
import { MAX_SEGMENTS_PER_NEWSLETTER, describeRules } from "@/lib/segment-rules";
import { SegmentRulesSchema, findSegmentByReference, previewRules, validateRules } from "@/lib/segments";
import Automation from "@/models/Automation";
import Campaign from "@/models/Campaign";
import Segment from "@/models/Segment";

const GROUP = "Segments";
const segmentId = idInput("segment");
const nameInput = z.string().trim().min(1).max(80).describe("The segment's name, unique in the newsletter");
const descriptionInput = z.string().trim().max(300).describe("What the segment is for, 300 characters at most");
const IN_USE_STATUSES = ["draft", "scheduled", "sending", "paused"];

const SegmentSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	rules: SegmentRulesSchema,
	summary: z.string().describe("The rules in words"),
	createdAt: dateOutput,
	updatedAt: dateOutput,
});
const CountsSchema = z.object({
	contacts: z.number().int().describe("Contacts the rules match now, whatever their status"),
	active: z.number().int().describe("The active ones: the contacts a send to the segment can reach"),
});
const PreviewSchema = z.object({
	matching: z.number().int().describe("Contacts the rules match now, whatever their status"),
	active: z.number().int().describe("The active ones"),
	sendable: z
		.number()
		.int()
		.describe("The active ones whose address the account never suppressed: who a send would reach, before the list cleanup and the warm-up"),
	sample: z
		.array(z.object({ id: z.string(), email: z.string(), status: z.string(), tags: z.array(z.string()) }))
		.describe("The newest matching contacts"),
});

function toSegment(segment) {
	return {
		id: String(segment._id),
		newsletterId: String(segment.newsletterId),
		name: segment.name,
		description: segment.description ?? null,
		rules: segment.rules,
		summary: describeRules(segment.rules),
		createdAt: toIso(segment.createdAt),
		updatedAt: toIso(segment.updatedAt),
	};
}

async function findSegment(account, id) {
	return findSegmentByReference(account, id);
}

async function withCounts(account, segment) {
	const { matching, active } = await previewRules(account, segment.newsletterId, segment.rules, { sample: 0 });
	return { ...toSegment(segment), contacts: matching, active };
}

const listSegments = defineAction({
	name: "list_segments",
	tryWithoutPlan: true,
	title: "List segments",
	group: GROUP,
	description:
		"Lists a newsletter's saved segments, each with its rules and live counts: how many contacts it matches now and how many of those are active. A segment is a saved audience: send a campaign to it (update_campaign's segment) or start an automation from it.",
	http: { method: "GET", path: "/segments" },
	readOnly: true,
	input: z.object({ newsletter: newsletterFilterInput.describe("The newsletter's ID or slug. Default: the account's first newsletter.") }),
	output: z.object({ segments: z.array(SegmentSchema.extend(CountsSchema.shape)) }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const segments = await Segment.find(scoped(account, { newsletterId: newsletter._id })).sort({ name: 1 }).lean();
		return { segments: await Promise.all(segments.map((segment) => withCounts(account, segment))) };
	},
});

const getSegment = defineAction({
	name: "get_segment",
	tryWithoutPlan: true,
	title: "Get a segment",
	group: GROUP,
	description: "Gets a segment with its rules, live counts and the newest contacts it matches.",
	http: { method: "GET", path: "/segments/{id}" },
	readOnly: true,
	input: z.object({ id: segmentId }),
	output: SegmentSchema.extend({ preview: PreviewSchema }),
	handler: async ({ account, input }) => {
		const segment = await findSegment(account, input.id);
		return { ...toSegment(segment), preview: await previewRules(account, segment.newsletterId, segment.rules) };
	},
});

const previewSegment = defineAction({
	name: "preview_segment",
	tryWithoutPlan: true,
	title: "Preview a segment",
	group: GROUP,
	description:
		"Counts the contacts some rules match, live, without saving them: send either rules or the ID or name of a saved segment. matching is every status, active the contacts that can get email, sendable those the account never suppressed. The list cleanup and the account's warm-up still apply when a campaign goes out (preview_campaign_recipients).",
	http: { method: "POST", path: "/segments/preview" },
	readOnly: true,
	rateLimit: { limit: 600, window: "1 h" },
	example: { rules: { match: "all", conditions: [{ type: "tag", op: "has", value: "vip" }] } },
	input: z.object({
		newsletter: newsletterFilterInput.describe("The newsletter's ID or slug. Default: the account's first newsletter."),
		segment: z.string().trim().max(100).optional().describe("A saved segment's ID or name, instead of rules"),
		rules: SegmentRulesSchema.optional().describe("Rules to count, instead of a saved segment"),
		sample: z.number().int().min(0).max(25).optional().describe("How many matching contacts to list, 10 by default"),
	}),
	output: PreviewSchema,
	handler: async ({ account, input }) => {
		if (Boolean(input.segment) === Boolean(input.rules)) throw actionError("validation_failed", "Send either segment or rules");
		if (input.segment) {
			const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
			const segment = await findSegmentByReference(account, input.segment, newsletter?._id);
			return previewRules(account, segment.newsletterId, segment.rules, { sample: input.sample });
		}
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const rules = await validateRules(account, newsletter._id, input.rules);
		return previewRules(account, newsletter._id, rules, { sample: input.sample });
	},
});

const createSegment = defineAction({
	name: "create_segment",
	tryWithoutPlan: true,
	title: "Create a segment",
	group: GROUP,
	description: `Saves rules as a segment, up to ${MAX_SEGMENTS_PER_NEWSLETTER} a newsletter. Rules combine conditions with all (and) or any (or), and a condition can be a group with its own all or any, one level deep. Conditions: status, tag (has or has_not), field (a custom field compared with eq, neq, gt, gte, lt, lte, contains, starts_with, is_set, is_not_set), signup_date (from, to), source, engagement (opened, clicked, opened_or_clicked or dormant over days, or never_opened) and imported. Text comparisons are case sensitive. It follows the list: contacts are matched each time it's counted or sent to.`,
	http: { method: "POST", path: "/segments", status: 201 },
	rateLimit: { limit: 60, window: "1 h" },
	example: { name: "Engaged readers", rules: { match: "all", conditions: [{ type: "engagement", kind: "opened_or_clicked", days: 30 }] } },
	input: z.object({
		newsletter: newsletterInput,
		name: nameInput,
		description: descriptionInput.optional(),
		rules: SegmentRulesSchema.describe("The rules"),
	}),
	output: SegmentSchema.extend(CountsSchema.shape),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const rules = await validateRules(account, newsletter._id, input.rules);
		if ((await Segment.countDocuments(scoped(account, { newsletterId: newsletter._id }))) >= MAX_SEGMENTS_PER_NEWSLETTER) {
			throw actionError("validation_failed", `A newsletter has up to ${MAX_SEGMENTS_PER_NEWSLETTER} segments`);
		}
		try {
			const segment = await Segment.create({
				accountId: account._id,
				newsletterId: newsletter._id,
				name: input.name,
				...(input.description && { description: input.description }),
				rules,
			});
			return withCounts(account, segment.toObject());
		} catch (error) {
			if (error?.code === 11000) throw actionError("conflict", `The newsletter already has a segment called ${input.name}`);
			throw error;
		}
	},
});

const updateSegment = defineAction({
	name: "update_segment",
	tryWithoutPlan: true,
	title: "Update a segment",
	group: GROUP,
	description:
		"Changes a segment's name, description or rules. Campaigns not yet sent and automations that use it follow the change; a campaign already sending keeps the audience it started with.",
	http: { method: "PATCH", path: "/segments/{id}" },
	idempotent: true,
	example: { name: "Engaged this month" },
	input: z.object({
		id: segmentId,
		name: nameInput.optional(),
		description: descriptionInput.nullable().optional().describe("What the segment is for. null clears it."),
		rules: SegmentRulesSchema.optional().describe("The new rules, which replace the old ones"),
	}),
	output: SegmentSchema.extend(CountsSchema.shape),
	handler: async ({ account, input }) => {
		const segment = await findSegment(account, input.id);
		const rules = input.rules ? await validateRules(account, segment.newsletterId, input.rules) : null;
		const set = {
			...(input.name !== undefined && { name: input.name }),
			...(input.description && { description: input.description }),
			...(rules && { rules }),
		};
		const unset = input.description === null ? { description: 1 } : null;
		if (Object.keys(set).length > 0 || unset) {
			try {
				await Segment.updateOne(scoped(account, { _id: segment._id }), {
					...(Object.keys(set).length > 0 && { $set: set }),
					...(unset && { $unset: unset }),
				});
			} catch (error) {
				if (error?.code === 11000) throw actionError("conflict", `The newsletter already has a segment called ${input.name}`);
				throw error;
			}
		}
		return withCounts(account, await Segment.findOne(scoped(account, { _id: segment._id })).lean());
	},
});

const deleteSegment = defineAction({
	name: "delete_segment",
	tryWithoutPlan: true,
	title: "Delete a segment",
	group: GROUP,
	description:
		"Deletes a saved segment. It can't be undone. A segment that a draft, scheduled or sending campaign, or an automation, still uses answers conflict: pick another audience for them first. Campaigns already sent keep the audience they went to.",
	http: { method: "DELETE", path: "/segments/{id}" },
	destructive: true,
	idempotent: true,
	input: z.object({ id: segmentId }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const segment = await findSegment(account, input.id);
		const inUse = await Campaign.exists(
			scoped(account, {
				status: { $in: IN_USE_STATUSES },
				$or: [{ segmentId: segment._id }, { segmentIds: segment._id }, { excludeSegmentIds: segment._id }],
			})
		);
		if (inUse) throw actionError("conflict", "A campaign that hasn't finished sending goes to this segment: pick another audience for it first");
		const automations = await Automation.find(scoped(account, { status: { $ne: "deleted" } })).select({ name: 1, trigger: 1 }).lean();
		const startedBy = automations.find((automation) => automation.trigger?.segmentId === String(segment._id));
		if (startedBy) throw actionError("conflict", `The automation ${startedBy.name} starts from this segment: change or delete it first`);
		await Segment.deleteOne(scoped(account, { _id: segment._id }));
		return { id: String(segment._id), deleted: true };
	},
});

export const segmentActions = [listSegments, getSegment, previewSegment, createSegment, updateSegment, deleteSegment];
