import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { GROUP, IssueSkeletonSchema, ItemSummarySchema, PatternOutputSchema, PatternSchema, channelInput } from "@/lib/actions/content-shared";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter, idInput, newsletterFilterInput, newsletterInput } from "@/lib/actions/shared";
import { applyPattern, countByState, createBatch, deleteBatch, findBatch, presentBatch, presentBatchWithItems, requestBatchReview, updateBatch } from "@/lib/content-batches";
import { describeActor } from "@/lib/content-items";
import { LIMITS, isDateKey } from "@/lib/content-rules";
import { isObjectIdString } from "@/lib/validation";
import EditorialBatch from "@/models/EditorialBatch";

const batchId = idInput("batch");

const BatchSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	name: z.string(),
	description: z.string(),
	externalId: z.string().nullable(),
	status: z.enum(["active", "archived"]),
	pattern: PatternOutputSchema.nullable().describe("The recurring pattern saved on the batch, or null"),
	itemCount: z.number().int(),
	counts: z.record(z.string(), z.number().int()).describe("How many items are in each editorial state"),
	reviewRequestedAt: z.string().nullable(),
	reviewUrl: z.string().describe("The batch in the dashboard, where the owner reviews all of it"),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});

const patternInput = PatternSchema.describe(
	"A recurring pattern: the funnel stages in the order they repeat and when slots fall, or a Briefing issue (issue: briefing), whose slots are sectioned issues. Applied only by apply_editorial_pattern; it never runs by itself."
);
const nameInput = z.string().trim().min(1).max(LIMITS.name).describe("The batch's name, such as a launch or a month");
const descriptionInput = z.string().trim().max(LIMITS.description).describe("What the batch is for");

const createEditorialBatch = defineAction({
	name: "create_editorial_batch",
	tryWithoutPlan: true,
	title: "Create an editorial batch",
	group: GROUP,
	description:
		"Makes a batch to group content items that belong together: a campaign, a launch, a month of posts. It can carry a recurring pattern (for example TOFU, MOFU, BOFU, TOFU, TOFU on Monday, Wednesday and Friday at 09:00) that only apply_editorial_pattern uses. Send externalId to make it safe to repeat: the batch that has it comes back with created false. Planning only: nothing is sent, scheduled or published.",
	http: { method: "POST", path: "/editorial-batches", status: (output) => (output.created ? 201 : 200) },
	idempotent: true,
	example: { name: "November launch", externalId: "plan-2026-11" },
	input: z.object({
		newsletter: newsletterInput,
		name: nameInput,
		description: descriptionInput.optional(),
		externalId: z.string().trim().min(1).max(LIMITS.externalId).optional().describe("Your own key for the batch, unique in the account. The same key again returns the batch that has it, with created false."),
		pattern: patternInput.optional(),
	}),
	output: z.object({ created: z.boolean(), batch: BatchSchema }),
	handler: async ({ account, input, apiKey, connection }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const { batch, created } = await createBatch(account, newsletter, input, describeActor({ apiKey, connection }));
		return { created, batch: presentBatch(batch, (await countByState(account, [batch._id])).get(String(batch._id))) };
	},
});

const listEditorialBatches = defineAction({
	name: "list_editorial_batches",
	tryWithoutPlan: true,
	title: "List editorial batches",
	group: GROUP,
	description: "Lists the account's editorial batches, newest first, up to 100, each with how many items are in each editorial state and the dashboard link to review it. Filter by newsletter or status.",
	http: { method: "GET", path: "/editorial-batches" },
	readOnly: true,
	input: z.object({
		newsletter: newsletterFilterInput,
		status: z.enum(["active", "archived"]).optional().describe("Only active or only archived batches. Default: both."),
		limit: z.number().int().min(1).max(100).optional().describe("How many, 50 by default, 100 at most"),
	}),
	output: z.object({ batches: z.array(BatchSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
		const batches = await EditorialBatch.find(scoped(account, { ...(newsletter && { newsletterId: newsletter._id }), ...(input.status && { status: input.status }) }))
			.sort({ createdAt: -1, _id: -1 })
			.limit(input.limit ?? 50)
			.lean();
		const counts = await countByState(account, batches.map((batch) => batch._id));
		return { batches: batches.map((batch) => presentBatch(batch, counts.get(String(batch._id)))) };
	},
});

const getEditorialBatch = defineAction({
	name: "get_editorial_batch",
	tryWithoutPlan: true,
	title: "Get an editorial batch",
	group: GROUP,
	description: "Reads a batch with its items in order, a line each (editorial state, planned day, whether it can be approved, delivery), the count in each state, its pattern and the dashboard link where the owner reviews everything.",
	http: { method: "GET", path: "/editorial-batches/{id}" },
	readOnly: true,
	input: z.object({ id: batchId }),
	output: BatchSchema.extend({ items: z.array(ItemSummarySchema) }),
	handler: async ({ account, input }) => presentBatchWithItems(account, await findBatch(account, input.id)),
});

const updateEditorialBatch = defineAction({
	name: "update_editorial_batch",
	tryWithoutPlan: true,
	title: "Update an editorial batch",
	group: GROUP,
	description: "Renames a batch, changes its description, archives it or brings it back, or sets or clears its recurring pattern (null). Only the fields sent change. Items keep their planned days.",
	http: { method: "PATCH", path: "/editorial-batches/{id}" },
	idempotent: true,
	example: { name: "November launch, final" },
	input: z.object({
		id: batchId,
		name: nameInput.optional(),
		description: descriptionInput.optional(),
		status: z.enum(["active", "archived"]).optional().describe("active, or archived to put it away"),
		pattern: patternInput.nullable().optional().describe("The recurring pattern to save on the batch, or null to remove it"),
	}),
	output: z.object({ batch: BatchSchema }),
	handler: async ({ account, input }) => {
		const batch = await updateBatch(account, await findBatch(account, input.id), input);
		return { batch: presentBatch(batch, (await countByState(account, [batch._id])).get(String(batch._id))) };
	},
});

const deleteEditorialBatch = defineAction({
	name: "delete_editorial_batch",
	tryWithoutPlan: true,
	title: "Delete an editorial batch",
	group: GROUP,
	description: "Deletes a batch. Its items stay, outside any batch, with their planned days and states. Can't be undone.",
	http: { method: "DELETE", path: "/editorial-batches/{id}" },
	destructive: true,
	input: z.object({ id: batchId }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		await deleteBatch(account, await findBatch(account, input.id));
		return { id: input.id, deleted: true };
	},
});

const applyEditorialPattern = defineAction({
	name: "apply_editorial_pattern",
	tryWithoutPlan: true,
	title: "Apply a pattern to a batch",
	group: GROUP,
	description:
		"Gives the batch's items planned days from a recurring pattern, starting on a day: the n-th item takes the n-th slot, and an item whose funnel stage differs from the pattern's for that slot is listed in mismatches. matchStages picks, for each slot, the next item with the stage the pattern wants. By default only items with no planned day are placed; includePlanned moves the others too. dryRun shows the result without changing anything. Planning only: it never sends, schedules or publishes, and the pattern is never applied by itself. Uses the batch's pattern unless one is passed. A Briefing issue pattern (issue: briefing, with or without stages) also answers the issue's sections and its Markdown skeleton, and gives each newsletter item it places that has no body and no linked issue the skeleton as its body (listed in skeletonFor); an item with words, in review or approved keeps them.",
	http: { method: "POST", path: "/editorial-batches/{id}/pattern" },
	idempotent: true,
	example: { startDate: "2026-11-02", dryRun: true, pattern: { stages: ["TOFU", "MOFU", "BOFU", "TOFU", "TOFU"], cadence: { weekdays: [1, 3, 5], time: "09:00", timeZone: "Europe/Paris" } } },
	input: z.object({
		id: batchId,
		startDate: z.string().refine(isDateKey, "Use YYYY-MM-DD").describe("The first day slots may fall on, YYYY-MM-DD"),
		pattern: patternInput.optional().describe("The pattern to use instead of the batch's own"),
		matchStages: z.boolean().optional().describe("Give each slot the next item with the stage the pattern wants there. Default false: items keep the batch's order."),
		channel: channelInput.optional().describe("Only place this channel's items"),
		itemIds: z.array(idInput("content item")).min(1).max(LIMITS.itemsPerBatch).optional().describe("Only place these items of the batch. Default: the batch's items with no planned day."),
		includePlanned: z.boolean().optional().describe("Also place items that already have a planned day. Default false."),
		timeZone: z.string().trim().max(64).optional().describe("The timezone of the slots when the pattern names none. Default UTC."),
		dryRun: z.boolean().optional().describe("Return the assignment without writing it"),
	}),
	output: z.object({
		dryRun: z.boolean(),
		applied: z.number().int().describe("Items given a planned day"),
		assignments: z.array(
			z.object({
				id: z.string(),
				title: z.string(),
				channel: z.string(),
				funnelStage: z.string().nullable(),
				patternStage: z.string().nullable().describe("The stage the pattern wants in that slot, or null for a pattern without stages"),
				date: z.string(),
				time: z.string().nullable(),
				timeZone: z.string(),
				slot: z.number().int(),
				url: z.string(),
			})
		),
		mismatches: z.array(z.object({ id: z.string(), has: z.string(), wants: z.string() })).describe("Items whose funnel stage is not the pattern's for their slot"),
		unassigned: z.array(z.string()).describe("Items left without a slot"),
		issue: IssueSkeletonSchema.describe("The Briefing issue's sections and skeleton, or null for a pattern of stages only"),
		skeletonFor: z.array(z.string()).describe("Newsletter items given the skeleton as their body (on a dry run, the ones that would be)"),
	}),
	handler: async ({ account, input, apiKey, connection }) => {
		if (input.itemIds && !input.itemIds.every(isObjectIdString)) throw actionError("validation_failed", "itemIds: use IDs from get_editorial_batch");
		return applyPattern(account, await findBatch(account, input.id), input, describeActor({ apiKey, connection }));
	},
});

const requestBatchReviewAction = defineAction({
	name: "request_batch_review",
	tryWithoutPlan: true,
	title: "Request a review of a batch",
	group: GROUP,
	description:
		"Asks the owner to review a batch: every item that can be approved becomes ready_for_review, and the ones that can't are listed with what is missing. Items already in review, approved or delivered stay as they are. Returns the batch's dashboard link, one page where the owner reviews and approves everything. Only the owner approves; nothing is sent, scheduled or published.",
	http: { method: "POST", path: "/editorial-batches/{id}/review" },
	idempotent: true,
	input: z.object({ id: batchId }),
	output: z.object({
		batch: BatchSchema,
		reviewUrl: z.string().describe("The page where the owner reviews the whole batch"),
		requested: z.array(z.object({ id: z.string(), title: z.string() })),
		alreadyInReview: z.array(z.object({ id: z.string(), title: z.string(), state: z.string() })),
		blocked: z.array(z.object({ id: z.string(), title: z.string(), state: z.string(), blockers: z.array(z.object({ code: z.string(), message: z.string() })) })).describe("Items that can't be reviewed yet, and why"),
	}),
	handler: async ({ account, input, apiKey, connection }) => {
		const batch = await findBatch(account, input.id);
		const result = await requestBatchReview(account, batch, describeActor({ apiKey, connection }));
		const fresh = await findBatch(account, input.id);
		const presented = presentBatch(fresh, (await countByState(account, [batch._id])).get(String(batch._id)));
		return { batch: presented, reviewUrl: presented.reviewUrl, ...result };
	},
});

export const contentBatchActions = [createEditorialBatch, listEditorialBatches, getEditorialBatch, updateEditorialBatch, deleteEditorialBatch, applyEditorialPattern, requestBatchReviewAction];
