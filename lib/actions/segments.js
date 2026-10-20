import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, idInput, newsletterFilterInput, newsletterInput, toIso } from "@/lib/actions/shared";
import { MAX_SEGMENTS_PER_NEWSLETTER, collectLookups, describeRules } from "@/lib/segment-rules";
import { createSnapshot, deleteSnapshotMembers, nudgeStaleSnapshots } from "@/lib/segment-snapshots";
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
	kind: z.enum(["dynamic", "static"]).describe("dynamic: follows the list, matched each time it's counted or sent to. static: a saved list of the contacts a segment matched when it was saved."),
	status: z.enum(["ready", "building", "failed"]).describe("A saved list of a large segment fills in over a few minutes (building) and can't be sent to until it's ready. Dynamic segments are always ready."),
	members: z.number().int().nullable().describe("A saved list's contacts, when ready; null for a dynamic segment"),
	savedAt: dateOutput.describe("When a saved list was made; null for a dynamic segment"),
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
		kind: segment.kind ?? "dynamic",
		status: segment.buildStatus ?? "ready",
		members: segment.kind === "static" && segment.buildStatus === "ready" ? (segment.memberCount ?? 0) : null,
		savedAt: toIso(segment.snapshotAt),
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
		await nudgeStaleSnapshots(account, segments);
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
	description: `Saves rules as a segment, up to ${MAX_SEGMENTS_PER_NEWSLETTER} a newsletter. Rules combine conditions with all (and) or any (or), and a condition can be a group with its own all or any, one level deep. Conditions: status, tag (has, has_not, is_any_of, is_none_of), field (a custom field compared with eq, neq, gt, gte, lt, lte, contains, starts_with, includes, excludes, is_any_of, is_none_of, is_set, is_not_set), signup_date (from, to), source, country (a two-letter code, kept at signup when the request carries Cloudflare's cf-ipcountry), tier (free or paid), referrals (how many credited), engagement (opened, clicked, opened_or_clicked or dormant over days, or never_opened), poll (an answer), issue (opened or clicked an issue, or a link in it, or got it and didn't) and imported. Status, source and country also take is_any_of and is_none_of. Text comparisons are case sensitive. It follows the list: contacts are matched each time it's counted or sent to. create_segment_snapshot saves a list that doesn't follow.`,
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
		if (input.rules && segment.kind === "static") throw actionError("conflict", "A saved list's contacts can't change: save a new list instead");
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
		"Deletes a segment or a saved list. It can't be undone. A segment that a draft, scheduled or sending campaign, an automation or another segment still uses answers conflict: pick another audience for them first. Campaigns already sent keep the audience they went to.",
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
		const automations = await Automation.find(scoped(account, { status: { $ne: "deleted" } })).select({ name: 1, trigger: 1, steps: 1 }).lean();
		const id = String(segment._id);
		const startedBy = automations.find((automation) => automation.trigger?.segmentId === id);
		if (startedBy) throw actionError("conflict", `The automation ${startedBy.name} starts from this segment: change or delete it first`);
		if (segment.kind === "static") {
			const others = await Segment.find(scoped(account, { newsletterId: segment.newsletterId, _id: { $ne: segment._id } })).select({ name: 1, rules: 1 }).lean();
			const using = others.find(({ rules }) => collectLookups(rules).some(({ condition }) => condition.segment === id));
			if (using) throw actionError("conflict", `The segment ${using.name} has a condition on this saved list: change or delete it first`);
		}
		await Segment.deleteOne(scoped(account, { _id: segment._id }));
		if (segment.kind === "static") await deleteSnapshotMembers(account, segment._id);
		return { id: String(segment._id), deleted: true };
	},
});

const createSegmentSnapshot = defineAction({
	name: "create_segment_snapshot",
	tryWithoutPlan: true,
	title: "Save a segment as a list",
	group: GROUP,
	description: `Saves the contacts a segment (or some rules) matches right now as a list that doesn't follow the newsletter afterwards: people who join later aren't on it, and nobody leaves it except by being deleted. Use it for a launch audience, the readers of one campaign, or a clean-up you want to keep still. Send exactly one of segment (a saved segment's ID or name) and rules. A list counts as one of the newsletter's ${MAX_SEGMENTS_PER_NEWSLETTER} segments; send a campaign to it or start an automation from it like any other. A list of a few thousand contacts is ready at once; a large one fills in over a few minutes (status building) and can't be sent to until it's ready. Contacts who unsubscribe or bounce stay on the list, and a send still skips them.`,
	http: { method: "POST", path: "/segments/snapshots", status: 201 },
	rateLimit: { limit: 30, window: "1 h" },
	example: { name: "Launch list", rules: { match: "all", conditions: [{ type: "tag", op: "has", value: "vip" }] } },
	input: z.object({
		newsletter: newsletterInput,
		name: nameInput,
		description: descriptionInput.optional(),
		segment: z.string().trim().max(100).optional().describe("A saved segment's ID or name, instead of rules"),
		rules: SegmentRulesSchema.optional().describe("Rules to save the matching contacts of, instead of a saved segment"),
	}),
	output: SegmentSchema.extend(CountsSchema.shape),
	handler: async ({ account, input }) => {
		if (Boolean(input.segment) === Boolean(input.rules)) throw actionError("validation_failed", "Send either segment or rules");
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const source = input.segment ? await findSegmentByReference(account, input.segment, newsletter._id) : null;
		if (source?.buildStatus && source.buildStatus !== "ready") throw actionError("conflict", "That list is still being saved: try again once it's ready");
		const rules = source ? source.rules : await validateRules(account, newsletter._id, input.rules);
		if ((await Segment.countDocuments(scoped(account, { newsletterId: newsletter._id }))) >= MAX_SEGMENTS_PER_NEWSLETTER) {
			throw actionError("validation_failed", `A newsletter has up to ${MAX_SEGMENTS_PER_NEWSLETTER} segments`);
		}
		try {
			const segment = await createSnapshot(account, { newsletterId: newsletter._id, name: input.name, description: input.description, rules });
			return withCounts(account, segment);
		} catch (error) {
			if (error?.code === 11000) throw actionError("conflict", `The newsletter already has a segment called ${input.name}`);
			throw error;
		}
	},
});

export const segmentActions = [listSegments, getSegment, previewSegment, createSegment, createSegmentSnapshot, updateSegment, deleteSegment];
