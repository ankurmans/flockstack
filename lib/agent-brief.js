import "server-only";
import { scoped } from "@/lib/account-scope";
import { findNewsletter } from "@/lib/actions/shared";
import { resolveTimeZone, shiftDateKey, toDateKey } from "@/lib/time-zone";
import Campaign from "@/models/Campaign";
import ContentItem from "@/models/ContentItem";

export async function getAgentBrief(account, input, now = new Date()) {
	const newsletter = await findNewsletter(account, input.newsletter);
	const timeZone = resolveTimeZone(input.timeZone || "UTC");
	const filter = scoped(account, { newsletterId: newsletter._id });
	const today = toDateKey(now, timeZone), lastDay = shiftDateKey(today, 6);
	const [recent, scheduled, items, planned] = await Promise.all([
		Campaign.find({ ...filter, status: "sent", source: { $ne: "import" } }).sort({ sentAt: -1 }).select("subject stats sentAt").limit(5).lean(),
		Campaign.find({ ...filter, status: "scheduled", scheduledAt: { $gte: now } }).sort({ scheduledAt: 1 }).select("subject scheduledAt").limit(20).lean(),
		ContentItem.find({ ...filter, plannedDate: null, state: { $ne: "delivered" } }).sort({ createdAt: -1 }).select("title state plannedDate").limit(25).lean(),
		ContentItem.find({ ...filter, plannedDate: { $gte: today, $lte: lastDay } }).select("plannedDate").limit(1000).lean(),
	]);
	const day = (date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
	const occupied = new Set([...planned.map((item) => item.plannedDate), ...scheduled.map((item) => day(item.scheduledAt))].filter(Boolean));
	const coverageLimited = planned.length === 1000 || scheduled.length === 20;
	const emptyDays = coverageLimited ? [] : Array.from({ length: 7 }, (_, index) => shiftDateKey(today, index)).filter((date) => !occupied.has(date));
	const nextSteps = [];
	if (coverageLimited) nextSteps.push("The sampled plan is incomplete. Read get_content_plan before assuming a day is empty.");
	if (!recent.length) nextSteps.push("There are no sent issues to learn from yet. Prepare the first issue for review.");
	if (emptyDays.length) nextSteps.push(`The next seven days have ${emptyDays.length} days without a planned item or a scheduled issue.`);
	if (items.some((item) => item.state === "changes_requested")) nextSteps.push("Address the owner's requested changes before proposing new work.");
	return { newsletterId: String(newsletter._id), name: newsletter.name, writingBrief: newsletter.agentBrief ?? null, description: newsletter.description || "", asOf: now.toISOString(), timeZone, coverageLimited,
		recent: recent.map((issue) => ({ id: String(issue._id), subject: issue.subject || "", sent: issue.stats?.sent ?? 0, opened: issue.stats?.opened ?? 0, clicked: issue.stats?.clicked ?? 0, openRate: issue.stats?.sent ? (issue.stats.opened ?? 0) / issue.stats.sent : null })),
		scheduled: scheduled.map((issue) => ({ id: String(issue._id), subject: issue.subject || "", at: new Date(issue.scheduledAt).toISOString() })),
		emptyDays, backlog: items.filter((item) => !item.plannedDate && item.state !== "delivered").slice(0, 25).map((item) => ({ id: String(item._id), title: item.title, state: item.state })), nextSteps };
}
