import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, idInput, newsletterFilterInput, newsletterInput, toId, toIso } from "@/lib/actions/shared";
import { FEED_BLOCK } from "@/lib/editor-blocks";
import { feedUrlInput } from "@/lib/actions/feeds";
import { textToRich } from "@/lib/rich-text";
import { runSeries } from "@/lib/series";
import {
	DEFAULT_SCHEDULE,
	MAX_SERIES_INTRO_LENGTH,
	MAX_SERIES_PER_NEWSLETTER,
	SERIES_FREQUENCIES,
	SERIES_MODES,
	SERIES_RUN_STATUSES,
	describeSchedule,
	getNextRun,
	getSeriesProblem,
	normalizeTimeZone,
} from "@/lib/series-rules";
import { isObjectIdString } from "@/lib/validation";
import Newsletter from "@/models/Newsletter";
import SeriesPlan from "@/models/SeriesPlan";
import SeriesRun from "@/models/SeriesRun";

const GROUP = "Series";
const HOW_IT_WORKS = `A series makes an issue from a feed on a schedule. Each time it is due, FlockStack reads the feed, takes the items that are new since the last issue (the first issue has the newest ones) and makes a rich campaign of the intro and those items, with the subject and preview text filled in. mode draft leaves it as a draft campaign and emails the account owner that it is ready to review; mode send sends it at once, to the whole list, with no review. A run with no new items sends nothing and is recorded as skipped. A feed that can't be read records a failed run and tries again at the next one. The subject and preview text can use {{date}} (the day, in the series' time zone), {{first_title}} (the first item's title) and {{count}} (how many items). Runs happen within about 5 minutes of the time, and a series that was missed (downtime) runs once for what it missed.`;

const ScheduleSchema = z.object({
	frequency: z.enum(SERIES_FREQUENCIES),
	days: z.array(z.number().int()).describe("For weekly: the days of the week, 0 (Sunday) to 6 (Saturday). Empty otherwise."),
	dayOfMonth: z.number().int().nullable().describe("For monthly: the day, 1 to 28. null otherwise."),
	hour: z.number().int().describe("The hour it runs, 0 to 23, in timeZone"),
	timeZone: z.string().describe("An IANA time zone like Europe/Paris, UTC by default"),
});
const RunSchema = z.object({
	id: z.string(),
	seriesId: z.string(),
	status: z.enum(SERIES_RUN_STATUSES).describe("running; drafted (a campaign is waiting for review, or a send that couldn't start left it so, see reason); sent; skipped (nothing new, or the account can't send); failed (the feed couldn't be read, see reason)"),
	reason: z.string().nullable(),
	campaignId: z.string().nullable().describe("The campaign it made"),
	itemCount: z.number().int().describe("The new items in it"),
	isManual: z.boolean().describe("Started by run_series, not by the schedule"),
	dueAt: dateOutput.describe("The time the run was due; a manual run's start"),
	finishedAt: dateOutput,
});
const SeriesSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	name: z.string(),
	feedUrl: z.string(),
	active: z.boolean().describe("Off, it makes nothing and has no next run"),
	mode: z.enum(SERIES_MODES),
	schedule: ScheduleSchema,
	scheduleSummary: z.string().describe("The schedule in words"),
	subject: z.string(),
	previewText: z.string(),
	count: z.number().int(),
	order: z.enum(["newest", "oldest"]),
	image: z.boolean(),
	excerpt: z.boolean(),
	date: z.boolean(),
	intro: z.string().describe("Rich text above the items"),
	nextRunAt: dateOutput.describe("When it is due next; null while it is off"),
	lastRunAt: dateOutput,
	lastRun: RunSchema.nullable(),
	createdAt: dateOutput,
	updatedAt: dateOutput,
});

function toRun(run) {
	return {
		id: String(run._id),
		seriesId: String(run.seriesId),
		status: run.status,
		reason: run.reason ?? null,
		campaignId: toId(run.campaignId),
		itemCount: run.itemCount ?? 0,
		isManual: Boolean(run.isManual),
		dueAt: run.isManual ? toIso(run.createdAt) : toIso(run.slot),
		finishedAt: toIso(run.finishedAt),
	};
}

function toSchedule(schedule) {
	return {
		frequency: schedule.frequency,
		days: schedule.days ?? [],
		dayOfMonth: schedule.dayOfMonth ?? null,
		hour: schedule.hour,
		timeZone: schedule.timeZone || "UTC",
	};
}

function toSeries(series, lastRun = null) {
	const schedule = toSchedule(series.schedule);
	return {
		id: String(series._id),
		newsletterId: String(series.newsletterId),
		name: series.name,
		feedUrl: series.feedUrl,
		active: Boolean(series.active),
		mode: series.mode ?? "draft",
		schedule,
		scheduleSummary: describeSchedule(schedule),
		subject: series.subject,
		previewText: series.previewText ?? "",
		count: series.count ?? FEED_BLOCK.defaultCount,
		order: series.order ?? "newest",
		image: series.image !== false,
		excerpt: series.excerpt !== false,
		date: series.date !== false,
		intro: series.intro ?? "",
		nextRunAt: toIso(series.nextRunAt),
		lastRunAt: toIso(series.lastRunAt),
		lastRun: lastRun ? toRun(lastRun) : null,
		createdAt: toIso(series.createdAt),
		updatedAt: toIso(series.updatedAt),
	};
}

async function findSeries(account, id) {
	const series = isObjectIdString(id) ? await SeriesPlan.findOne(scoped(account, { _id: id })).lean() : null;
	if (!series) throw actionError("not_found", "Series not found");
	return series;
}

async function withLastRun(account, series) {
	const [lastRun] = await SeriesRun.find(scoped(account, { seriesId: series._id })).sort({ createdAt: -1, _id: -1 }).limit(1).lean();
	return toSeries(series, lastRun);
}

// The settings of a series as the rules read them: what is stored, with the changes on top.
function toSettings(current, changes) {
	const schedule = { ...(current ? toSchedule(current.schedule) : DEFAULT_SCHEDULE), ...changes.schedule };
	if (changes.schedule?.frequency && changes.schedule.frequency !== current?.schedule?.frequency) {
		// A frequency's own fields start from the defaults.
		Object.assign(schedule, { days: changes.schedule.days ?? DEFAULT_SCHEDULE.days, dayOfMonth: changes.schedule.dayOfMonth ?? DEFAULT_SCHEDULE.dayOfMonth });
	}
	return { ...DEFAULTS, ...current, ...changes, schedule: { ...schedule, timeZone: normalizeTimeZone(schedule.timeZone) ?? schedule.timeZone } };
}

const DEFAULTS = { mode: "draft", previewText: "", count: FEED_BLOCK.defaultCount, order: "newest", image: true, excerpt: true, date: true, intro: "", active: false };

function toDocument(settings) {
	const { schedule } = settings;
	return {
		name: settings.name.trim(),
		feedUrl: new URL(settings.feedUrl.trim()).href,
		schedule: {
			frequency: schedule.frequency,
			hour: schedule.hour,
			timeZone: schedule.timeZone || "UTC",
			...(schedule.frequency === "weekly" && { days: [...new Set(schedule.days)].sort((a, b) => a - b) }),
			...(schedule.frequency === "monthly" && { dayOfMonth: schedule.dayOfMonth }),
		},
		mode: settings.mode,
		subject: settings.subject.trim(),
		previewText: (settings.previewText ?? "").trim(),
		count: settings.count,
		order: settings.order,
		image: settings.image,
		excerpt: settings.excerpt,
		date: settings.date,
		intro: textToRich(settings.intro),
		active: settings.active,
	};
}

const scheduleInput = z
	.object({
		frequency: z.enum(SERIES_FREQUENCIES).optional().describe(`daily, weekly or monthly. Default: ${DEFAULT_SCHEDULE.frequency}.`),
		days: z.array(z.number().int().min(0).max(6)).max(7).optional().describe("For weekly: the days of the week, 0 (Sunday) to 6 (Saturday). Default: Monday."),
		dayOfMonth: z.number().int().min(1).max(28).optional().describe("For monthly: the day of the month, 1 to 28, which every month has. Default 1."),
		hour: z.number().int().min(0).max(23).optional().describe(`The hour it runs, 0 to 23, in timeZone. Default ${DEFAULT_SCHEDULE.hour}.`),
		timeZone: z.string().trim().max(64).optional().describe("An IANA time zone like Europe/Paris. Default UTC."),
	})
	.describe("When it runs");

const fields = {
	name: z.string().trim().min(1).max(100).describe("What the series is called in the dashboard"),
	feedUrl: feedUrlInput,
	mode: z.enum(SERIES_MODES).describe("draft (the default): each issue waits for review. send: each issue goes out by itself, to the whole list."),
	subject: z.string().trim().min(1).max(200).describe("The subject line, 200 characters at most. {{date}}, {{first_title}} and {{count}} are filled in."),
	previewText: z.string().trim().max(300).describe("The preview text, 300 characters at most; the same tags work"),
	count: z.number().int().min(1).max(FEED_BLOCK.maxCount).describe(`The most items an issue shows, ${FEED_BLOCK.defaultCount} by default, ${FEED_BLOCK.maxCount} at most`),
	order: z.enum(["newest", "oldest"]).describe("The items newest first (the default) or oldest first"),
	image: z.boolean().describe("Show each item's picture. On by default."),
	excerpt: z.boolean().describe("Show each item's excerpt. On by default."),
	date: z.boolean().describe("Show each item's date. On by default."),
	intro: z.string().max(MAX_SERIES_INTRO_LENGTH).describe("Text above the items, 20,000 characters at most: HTML, or plain paragraphs separated by a blank line"),
	active: z.boolean().describe("Turn the schedule on. Off by default: a new series makes nothing until it is turned on."),
};

const listSeries = defineAction({
	name: "list_series",
	title: "List series",
	group: GROUP,
	description: `Lists the account's recurring series, oldest first, each with its schedule, when it is due next and its latest run. ${HOW_IT_WORKS}`,
	http: { method: "GET", path: "/series" },
	readOnly: true,
	input: z.object({ newsletter: newsletterFilterInput }),
	output: z.object({ series: z.array(SeriesSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
		const series = await SeriesPlan.find(scoped(account, newsletter ? { newsletterId: newsletter._id } : {})).sort({ createdAt: 1, _id: 1 }).lean();
		return { series: await Promise.all(series.map((one) => withLastRun(account, one))) };
	},
});

const createSeries = defineAction({
	name: "create_series",
	title: "Create a series",
	group: GROUP,
	description: `Creates a recurring series for a newsletter, ${MAX_SERIES_PER_NEWSLETTER} at most. It is off until active is true. ${HOW_IT_WORKS}`,
	http: { method: "POST", path: "/series", status: 201 },
	rateLimit: { limit: 60, window: "1 h" },
	example: { name: "Weekly links", feedUrl: "https://example.com/feed.xml", subject: "This week: {{first_title}}", schedule: { frequency: "weekly", days: [1], hour: 8, timeZone: "Europe/Paris" } },
	input: z.object({
		newsletter: newsletterInput,
		name: fields.name,
		feedUrl: fields.feedUrl,
		schedule: scheduleInput.optional(),
		mode: fields.mode.optional(),
		subject: fields.subject,
		previewText: fields.previewText.optional(),
		count: fields.count.optional(),
		order: fields.order.optional(),
		image: fields.image.optional(),
		excerpt: fields.excerpt.optional(),
		date: fields.date.optional(),
		intro: fields.intro.optional(),
		active: fields.active.optional(),
	}),
	output: SeriesSchema,
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const { newsletter: _reference, ...changes } = input;
		const settings = toSettings(null, changes);
		const problem = getSeriesProblem(settings);
		if (problem) throw actionError("validation_failed", problem);
		if ((await SeriesPlan.countDocuments(scoped(account, { newsletterId: newsletter._id }))) >= MAX_SERIES_PER_NEWSLETTER) {
			throw actionError("conflict", `A newsletter has ${MAX_SERIES_PER_NEWSLETTER} series at most`);
		}
		const document = toDocument(settings);
		const series = await SeriesPlan.create({
			accountId: account._id,
			newsletterId: newsletter._id,
			...document,
			...(document.active && { nextRunAt: getNextRun(document.schedule) }),
		});
		return toSeries(series.toObject());
	},
});

const updateSeries = defineAction({
	name: "update_series",
	title: "Update a series",
	group: GROUP,
	description: `Changes a series' schedule, feed, subject, items or mode, or turns it on or off with active. Send only the fields to change; schedule keeps the fields you leave out (changing the frequency starts that frequency's days from their defaults). Turning it on, or changing its schedule while it is on, sets its next run from now. Items already used stay used. ${HOW_IT_WORKS}`,
	http: { method: "PATCH", path: "/series/{id}" },
	idempotent: true,
	example: { active: true, mode: "send" },
	input: z.object({
		id: idInput("series"),
		name: fields.name.optional(),
		feedUrl: fields.feedUrl.optional(),
		schedule: scheduleInput.optional(),
		mode: fields.mode.optional(),
		subject: fields.subject.optional(),
		previewText: fields.previewText.optional(),
		count: fields.count.optional(),
		order: fields.order.optional(),
		image: fields.image.optional(),
		excerpt: fields.excerpt.optional(),
		date: fields.date.optional(),
		intro: fields.intro.optional(),
		active: fields.active.optional(),
	}),
	output: SeriesSchema,
	handler: async ({ account, input }) => {
		const current = await findSeries(account, input.id);
		const { id: _id, ...changes } = input;
		const settings = toSettings(current, changes);
		const problem = getSeriesProblem(settings);
		if (problem) throw actionError("validation_failed", problem);
		const document = toDocument(settings);
		const rescheduled = changes.schedule !== undefined || !current.active || !current.nextRunAt;
		const set = { ...document, ...(document.active && rescheduled && { nextRunAt: getNextRun(document.schedule) }) };
		// Another feed's items have their own dates and IDs, so what was used from the old one says nothing about them.
		const unset = { ...(!document.active && { nextRunAt: 1 }), ...(document.feedUrl !== current.feedUrl && { lastItemAt: 1, seenIds: 1 }) };
		const { matchedCount } = await SeriesPlan.updateOne(scoped(account, { _id: current._id }), {
			$set: set,
			...(Object.keys(unset).length > 0 && { $unset: unset }),
		});
		if (!matchedCount) throw actionError("not_found", "Series not found");
		return withLastRun(account, await findSeries(account, input.id));
	},
});

const deleteSeries = defineAction({
	name: "delete_series",
	title: "Delete a series",
	group: GROUP,
	description: "Deletes a series and its run history. The campaigns it made stay.",
	http: { method: "DELETE", path: "/series/{id}" },
	destructive: true,
	idempotent: true,
	input: z.object({ id: idInput("series") }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const series = await findSeries(account, input.id);
		await SeriesPlan.deleteOne(scoped(account, { _id: series._id }));
		await SeriesRun.deleteMany(scoped(account, { seriesId: series._id }));
		return { id: input.id, deleted: true };
	},
});

const runSeriesNow = defineAction({
	name: "run_series",
	title: "Run a series now",
	group: GROUP,
	description: "Makes the series' next issue now, whatever its schedule and whether it is on: the feed's new items become a draft campaign, never a send, and the run goes in the history. Everything the feed has then counts as used, so the next scheduled issue is of what is published after. With no new items nothing is made and the run is recorded as skipped.",
	http: { method: "POST", path: "/series/{id}/run" },
	openWorld: true,
	rateLimit: { limit: 30, window: "1 h" },
	limitDashboard: true,
	input: z.object({ id: idInput("series") }),
	output: RunSchema,
	handler: async ({ account, input }) => {
		const series = await findSeries(account, input.id);
		const now = new Date();
		const outcome = await runSeries({ series, slot: `manual:${now.toISOString()}`, now, isManual: true });
		const run = await SeriesRun.findOne(scoped(account, { seriesId: series._id, slot: `manual:${now.toISOString()}` })).lean();
		if (!run) throw actionError("conflict", outcome.skipped ?? "The series couldn't run");
		return toRun(run);
	},
});

const listSeriesRuns = defineAction({
	name: "list_series_runs",
	title: "List a series' runs",
	group: GROUP,
	description: "Lists a series' latest runs, newest first, with what each did: the campaign it made, how many new items it had, and why it was skipped or failed.",
	http: { method: "GET", path: "/series/{id}/runs" },
	readOnly: true,
	input: z.object({ id: idInput("series"), limit: z.number().int().min(1).max(100).optional().describe("Runs to list, 30 by default, 100 at most") }),
	output: z.object({ runs: z.array(RunSchema) }),
	handler: async ({ account, input }) => {
		const series = await findSeries(account, input.id);
		const runs = await SeriesRun.find(scoped(account, { seriesId: series._id })).sort({ createdAt: -1, _id: -1 }).limit(input.limit ?? 30).lean();
		return { runs: runs.map(toRun) };
	},
});

export const seriesActions = [listSeries, createSeries, updateSeries, deleteSeries, runSeriesNow, listSeriesRuns];
