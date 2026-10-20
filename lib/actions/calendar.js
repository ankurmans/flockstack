import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { findNewsletter, newsletterFilterInput } from "@/lib/actions/shared";
import { getCalendar, isMonthKey } from "@/lib/calendar";
import { CAMPAIGN_STATUSES } from "@/models/Campaign";

const getContentCalendar = defineAction({
	name: "get_content_calendar",
	tryWithoutPlan: true,
	title: "Get the content calendar",
	group: "Campaigns",
	description:
		"Lists a month's scheduled and sent issues by day, in a timezone: scheduled ones on the day they go out, sent ones on the day they were sent. Drafts have no day and aren't in it. Use it to see what is planned, and to find a free day.",
	http: { method: "GET", path: "/calendar" },
	readOnly: true,
	example: { month: "2026-11" },
	input: z.object({
		month: z
			.string()
			.refine(isMonthKey, "Use YYYY-MM")
			.optional()
			.describe("The month, YYYY-MM. Default: the current month in the timezone."),
		timeZone: z.string().max(64).optional().describe("An IANA timezone such as Europe/Paris, for which day an issue falls on. Default UTC."),
		newsletter: newsletterFilterInput,
	}),
	output: z.object({
		month: z.string(),
		timeZone: z.string(),
		issues: z.array(
			z.object({
				id: z.string(),
				newsletterId: z.string(),
				subject: z.string(),
				status: z.enum(CAMPAIGN_STATUSES).describe("scheduled, sending, paused or sent"),
				date: z.string().describe("The day it falls on in the timezone, YYYY-MM-DD"),
				at: z.string().describe("When it goes out (scheduled) or went out"),
				publishTo: z.enum(["both", "email", "web"]),
				recipients: z.number().int().describe("Emails it went to, 0 until it is sent"),
			})
		),
	}),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
		const calendar = await getCalendar(account, { month: input.month, timeZone: input.timeZone, newsletterId: newsletter?._id });
		return {
			month: calendar.month,
			timeZone: calendar.timeZone,
			issues: calendar.entries.map(({ at, ...entry }) => ({ ...entry, at: at.toISOString() })),
		};
	},
});

export const calendarActions = [getContentCalendar];
