import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { findNewsletter, newsletterInput } from "@/lib/actions/shared";
import { BREAKDOWNS, DEFAULT_REPORT_DAYS, GRANULARITIES, MAX_GROUPS, MAX_REPORT_DAYS } from "@/lib/report-rules";
import { REPORT_TABLES, getGrowthCsv, getIssuesCsv, getSiteCsv } from "@/lib/report-csv";
import { MAX_COMPARED, compareIssues, getGrowthReport } from "@/lib/reports";
import { getSiteReport } from "@/lib/web-analytics";
import { isObjectIdString } from "@/lib/validation";

const GROUP = "Reports";
const MAX_SITE_DAYS = 365;

const daysInput = (max) => z.number().int().min(1).max(max).optional().describe(`Days to look back, ${DEFAULT_REPORT_DAYS} by default, ${max} at most. Days are UTC.`);

const GrowthSchema = z.object({
	from: z.string().describe("First day of the range, YYYY-MM-DD"),
	to: z.string().describe("Last day, today"),
	days: z.number().int(),
	granularity: z.enum(GRANULARITIES),
	by: z.enum(BREAKDOWNS),
	buckets: z.array(
		z.object({
			key: z.string().describe("The day, the Monday of the week or the month (YYYY-MM)"),
			label: z.string(),
			new: z.number().int().describe("Subscribers who signed up in it and are not waiting to confirm"),
			left: z.number().int().describe("Who unsubscribed, bounced or complained in it, imports left out"),
			net: z.number().int(),
			total: z.number().int().describe("Active subscribers at its end, worked back from today's"),
		})
	),
	groups: z
		.array(
			z.object({
				key: z.string(),
				label: z.string(),
				new: z.number().int().describe("Subscribers from this group who joined in the range"),
				active: z.number().int().describe("Of them, still subscribed"),
				retention: z.number().nullable().describe("active over new, 0 to 1"),
				series: z.array(z.number().int()).describe("new in each bucket, in order"),
			})
		)
		.describe(`The ${MAX_GROUPS} biggest groups of the breakdown and the rest as Other; empty for by none`),
	totals: z.object({
		new: z.number().int(),
		left: z.number().int(),
		net: z.number().int(),
		active: z.number().int().describe("Active subscribers now"),
		pending: z.number().int().describe("Signed up and waiting to confirm, whenever they did"),
		startingActive: z.number().int().describe("Active subscribers when the range began"),
	}),
});

const IssueSchema = z.object({
	id: z.string(),
	subject: z.string(),
	sentAt: z.string().nullable(),
	audience: z.string(),
	sent: z.number().int(),
	delivered: z.number().int(),
	opened: z.number().int(),
	openRate: z.number().nullable().describe("opened over delivered (sent when delivery isn't known), 0 to 1"),
	clicked: z.number().int(),
	clickRate: z.number().nullable(),
	unsubscribed: z.number().int(),
	unsubscribeRate: z.number().nullable(),
	bounced: z.number().int(),
	complained: z.number().int(),
	webViews: z.number().int().describe("Views of its page on the website, once per browser and day"),
	topLink: z.object({ url: z.string(), uniqueClicks: z.number().int() }).nullable().describe("Its most clicked link"),
});

const SiteSchema = z.object({
	from: z.string(),
	to: z.string(),
	days: z.number().int(),
	daily: z.array(z.object({ date: z.string(), views: z.number().int(), visitors: z.number().int() })),
	totals: z.object({ views: z.number().int(), visitors: z.number().int().describe("The days' visitors added up: someone who comes back on another day counts again") }),
	referrers: z.array(z.object({ referrer: z.string(), views: z.number().int() })).describe("The 20 biggest. Direct or unknown is a visit with no referring website"),
	countries: z.array(z.object({ country: z.string(), code: z.string(), views: z.number().int() })).describe("From Cloudflare's country for the visitor's network; XX is unknown"),
	devices: z.array(z.object({ device: z.enum(["desktop", "mobile", "tablet"]), views: z.number().int() })).describe("Views by kind of device, from the browser on arrival; only the kind is kept. Visits from before this was counted have none"),
	pages: z.array(z.object({ slug: z.string(), title: z.string(), views: z.number().int() })).describe("Issues by views"),
});

function parseDate(value, name) {
	if (!value) return null;
	const date = new Date(`${value}T00:00:00.000Z`);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime())) throw actionError("validation_failed", `${name}: use a date like 2026-10-31`);
	return date;
}

function parseIds(value) {
	if (!value) return null;
	const ids = [...new Set(value.split(",").map((id) => id.trim().toLowerCase()).filter(Boolean))];
	const bad = ids.find((id) => !isObjectIdString(id));
	if (bad) throw actionError("validation_failed", `ids: ${bad} isn't an issue ID`);
	if (ids.length > 10) throw actionError("validation_failed", "ids: 10 issues at most");
	return ids;
}

async function runGrowth({ account, input }) {
	const newsletter = await findNewsletter(account, input.newsletter, { _id: 1, name: 1, slug: 1 });
	return getGrowthReport({ account, newsletter, days: input.days ?? DEFAULT_REPORT_DAYS, granularity: input.granularity, by: input.by ?? "source" });
}

async function runIssues({ account, input }) {
	const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
	const from = parseDate(input.from, "from");
	const to = input.to ? new Date(parseDate(input.to, "to").getTime() + 86_400_000) : null;
	return compareIssues({ account, newsletter, ids: parseIds(input.ids), limit: input.limit ?? 10, from, to });
}

async function runSite({ account, input }) {
	const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
	return getSiteReport({ account, newsletter, days: input.days ?? 30 });
}

const issueFilters = {
	ids: z.string().trim().max(400).optional().describe("Compare these issues, their IDs separated by commas (10 at most), instead of the newest ones"),
	limit: z.number().int().min(1).max(MAX_COMPARED).optional().describe(`How many of the newest issues, 10 by default, ${MAX_COMPARED} at most`),
	from: z.string().trim().max(10).optional().describe("Only issues sent from this date, YYYY-MM-DD"),
	to: z.string().trim().max(10).optional().describe("Only issues sent up to this date, YYYY-MM-DD, that day included"),
};

const getGrowth = defineAction({
	name: "get_growth_report",
	tryWithoutPlan: true,
	title: "Get the growth report",
	group: GROUP,
	description: `How a newsletter grew, for any range up to ${MAX_REPORT_DAYS} days by day, week or month: subscribers who joined, who left, the net and the total, and the joins split by where they came from (by source, channel, campaign or form). Source is the signup's own (website, popup, gate, a form, magic-link, api, recommendation:<slug>); channel is direct, search, social, email, paid, website, recommendation, referral, import, manual or api; campaign is utm_campaign. A contact from before FlockStack recorded where signups came from has the channel its source says, and no campaign. Days are UTC. export_report has it as CSV.`,
	http: { method: "GET", path: "/reports/growth" },
	readOnly: true,
	example: { days: 90, by: "channel" },
	input: z.object({
		newsletter: newsletterInput,
		days: daysInput(MAX_REPORT_DAYS),
		granularity: z.enum(GRANULARITIES).optional().describe("day, week or month. Default: day up to 60 days, week up to a year, month beyond."),
		by: z.enum(BREAKDOWNS).optional().describe("source (default), channel, campaign, form or none"),
	}),
	output: GrowthSchema,
	handler: runGrowth,
});

const getIssues = defineAction({
	name: "compare_issues",
	tryWithoutPlan: true,
	title: "Compare issues",
	group: GROUP,
	description:
		"Sent issues side by side, newest first: how many went out, opens, clicks and unsubscribes with their rates, bounces, complaints, views of the issue's web page and its most clicked link. Pass ids to compare chosen issues, or a date range and a count for the newest. Imported issues have no stats and are left out. Rates are fractions from 0 to 1 of delivered emails. export_report has it as CSV.",
	http: { method: "GET", path: "/reports/issues" },
	readOnly: true,
	example: { limit: 5 },
	input: z.object({ newsletter: newsletterInput, ...issueFilters }),
	output: z.object({ issues: z.array(IssueSchema) }),
	handler: async (context) => ({ issues: await runIssues(context) }),
});

const getSite = defineAction({
	name: "get_site_report",
	tryWithoutPlan: true,
	title: "Get the website report",
	group: GROUP,
	description: `Visits to a newsletter's website over the last days (up to ${MAX_SITE_DAYS}): page views and distinct visitors for each day, the websites that sent them, their countries, desktop, mobile and tablet views and the issues read most. Counted without cookies or third-party scripts: a visitor is a hash of their network address and browser that changes every day and is never stored, so visitors are counted for each day and someone back tomorrow counts again. Visitors whose browser sends Do Not Track or Global Privacy Control, and crawlers, aren't counted. export_report has it as CSV.`,
	http: { method: "GET", path: "/reports/site" },
	readOnly: true,
	example: { days: 30 },
	input: z.object({ newsletter: newsletterInput, days: daysInput(MAX_SITE_DAYS) }),
	output: SiteSchema,
	handler: runSite,
});

const exportReport = defineAction({
	name: "export_report",
	tryWithoutPlan: true,
	title: "Export a report",
	group: GROUP,
	description: `Any report as CSV, with the same inputs: report growth (table series, one row for each day, week or month, or breakdown, one row for each group with a column for each period), issues, or site (table daily, referrers, devices, countries or pages). Rates are fractions from 0 to 1; cells that a spreadsheet would run as a formula are quoted as text.`,
	http: { method: "GET", path: "/reports/export" },
	readOnly: true,
	rateLimit: { limit: 60, window: "1 h" },
	example: { report: "growth", days: 90, by: "source" },
	input: z.object({
		report: z.enum(Object.keys(REPORT_TABLES)).describe("growth, issues or site"),
		table: z.string().trim().max(20).optional().describe("Which table of the report: growth series (default) or breakdown; site daily (default), referrers, devices, countries or pages"),
		newsletter: newsletterInput,
		days: daysInput(MAX_REPORT_DAYS),
		granularity: z.enum(GRANULARITIES).optional().describe("growth: day, week or month"),
		by: z.enum(BREAKDOWNS).optional().describe("growth: source, channel, campaign, form or none"),
		...issueFilters,
	}),
	output: z.object({ filename: z.string(), csv: z.string(), rows: z.number().int().describe("Rows in the table, the header left out") }),
	handler: async (context) => {
		const { report, table } = context.input;
		const tables = REPORT_TABLES[report];
		const chosen = table ?? tables[0];
		if (!tables.includes(chosen)) throw actionError("validation_failed", `table: ${report} has ${tables.join(", ")}`);
		if (report === "growth") return getGrowthCsv(await runGrowth(context), chosen);
		if (report === "issues") return getIssuesCsv(await runIssues(context));
		return getSiteCsv(await runSite({ ...context, input: { ...context.input, days: Math.min(context.input.days ?? 30, MAX_SITE_DAYS) } }), chosen);
	},
});

export const reportActions = [getGrowth, getIssues, getSite, exportReport];
