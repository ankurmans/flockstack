import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { LIMITS, isDateKey } from "@/lib/content-rules";
import { getCampaignTime, getCampaigns, presentSummary } from "@/lib/content-items";
import { getAppUrl } from "@/lib/config";
import { resolveTimeZone, shiftDateKey, startOfDateKey, toDateKey, toTimeKey } from "@/lib/time-zone";
import Campaign from "@/models/Campaign";
import ContentItem from "@/models/ContentItem";

// One range of the calendar: the planned items on their days, the campaigns that really go out or went out at the time they do,
// and the backlog of items with no day. A planned item is only intent. A linked issue shows as planned while it is a draft and
// as scheduled, sending, paused or sent from the moment it is one, so the two are never mixed up.

const DELIVERY_STATUSES = ["scheduled", "sending", "paused", "sent"];
const MAX_BACKLOG = 200;

export const BACKLOG_ORDER = { createdAt: -1, _id: -1 };

// The filters on items that the plan and the item list share.
export function buildItemFilter({ newsletterId, channel, funnelStage, pillar, batchId, state } = {}) {
	return {
		...(newsletterId && { newsletterId }),
		...(channel && { channel }),
		...(funnelStage && { funnelStage }),
		...(pillar && { pillar }),
		...(batchId && { batchId }),
		...(state && { state }),
	};
}

export function checkRange(from, to) {
	if (!isDateKey(from) || !isDateKey(to)) throw actionError("validation_failed", "from and to: use YYYY-MM-DD");
	if (to < from) throw actionError("validation_failed", "to: it can't be before from");
	if (shiftDateKey(from, LIMITS.rangeDays) <= to) throw actionError("validation_failed", `A range is up to ${LIMITS.rangeDays} days`);
}

function planned(summary, item) {
	return {
		kind: "planned",
		date: item.plannedDate,
		plannedDate: item.plannedDate,
		time: item.plannedTime ?? null,
		at: summary.plannedAt,
		timeZone: item.timeZone ?? null,
		slot: summary.slot,
		itemId: summary.id,
		campaignId: summary.campaign?.id ?? null,
		channel: summary.channel,
		title: summary.title,
		funnelStage: summary.funnelStage,
		pillar: summary.pillar,
		state: summary.state,
		batchId: summary.batchId,
		deliveryStatus: summary.delivery.status,
		isManual: summary.delivery.mode === "manual",
		canApprove: summary.canApprove,
		editedAfterApproval: summary.review.editedAfterApproval,
		url: summary.url,
	};
}

function delivered(campaign, zone, summary = null, item = null) {
	const at = getCampaignTime(campaign);
	return {
		kind: campaign.status,
		date: toDateKey(at, zone),
		time: toTimeKey(at, zone),
		at: at.toISOString(),
		timeZone: zone,
		slot: null,
		itemId: summary?.id ?? null,
		campaignId: String(campaign._id),
		channel: "newsletter",
		title: summary?.title || campaign.subject || "",
		funnelStage: summary?.funnelStage ?? null,
		pillar: summary?.pillar ?? null,
		state: summary?.state ?? null,
		batchId: summary?.batchId ?? null,
		deliveryStatus: campaign.status,
		isManual: false,
		canApprove: summary?.canApprove ?? null,
		editedAfterApproval: summary?.review.editedAfterApproval ?? false,
		// An item's planned day, when the issue goes out on another.
		plannedDate: item?.plannedDate ?? null,
		url: summary?.url ?? `${getAppUrl()}/campaigns/${campaign._id}`,
	};
}

function byPlace(a, b) {
	if (a.date !== b.date) return a.date < b.date ? -1 : 1;
	const isDelivery = (entry) => (entry.kind === "planned" ? 0 : 1);
	if (isDelivery(a) !== isDelivery(b)) return isDelivery(a) - isDelivery(b);
	if (a.kind === "planned") return (a.slot ?? 0) - (b.slot ?? 0);
	return a.at < b.at ? -1 : 1;
}

// from and to are days (YYYY-MM-DD), both included. Issues are placed on their day in timeZone; a planned item stays on the
// day it was planned for, in its own timezone. includeDeliveries false leaves campaigns out; includeBacklog adds the items with no day.
export async function getContentPlan(account, { from, to, timeZone, filters = {}, includeBacklog = false, includeDeliveries = true } = {}) {
	checkRange(from, to);
	const zone = resolveTimeZone(timeZone);
	const start = startOfDateKey(from, zone);
	const end = startOfDateKey(shiftDateKey(to, 1), zone);
	const { newsletterId } = filters;
	const itemFilter = buildItemFilter(filters);
	// A campaign no item links has no stage, pillar, batch or editorial state: those filters leave it out.
	const hasItemFilter = Boolean(filters.funnelStage || filters.pillar || filters.batchId || filters.state);
	const deliveredCampaigns = includeDeliveries && (!filters.channel || filters.channel === "newsletter")
		? await Campaign.find(
				scoped(account, {
					...(newsletterId && { newsletterId }),
					$or: [
						{ status: "scheduled", scheduledAt: { $gte: start, $lt: end } },
						{ status: { $in: ["sending", "paused", "sent"] }, sentAt: { $gte: start, $lt: end } },
						{ status: { $in: ["sending", "paused", "sent"] }, sentAt: { $exists: false }, startedAt: { $gte: start, $lt: end } },
					],
				})
			)
				.select({ subject: 1, status: 1, scheduledAt: 1, startedAt: 1, sentAt: 1, newsletterId: 1 })
				.sort({ _id: 1 })
				.limit(LIMITS.planEntries)
				.lean()
		: [];
	const deliveredIds = deliveredCampaigns.map((campaign) => campaign._id);
	const [items, links] = await Promise.all([
		ContentItem.find(
			scoped(account, {
				...itemFilter,
				$or: [{ plannedDate: { $gte: from, $lte: to } }, ...(deliveredIds.length > 0 ? [{ channel: "newsletter", campaignId: { $in: deliveredIds } }] : [])],
			})
		)
			.sort({ plannedDate: 1, slotOrder: 1, createdAt: 1 })
			.limit(LIMITS.planEntries)
			.lean(),
		deliveredIds.length > 0 ? ContentItem.find(scoped(account, { channel: "newsletter", campaignId: { $in: deliveredIds } })).select({ campaignId: 1 }).lean() : [],
	]);
	const linked = new Set(links.map((link) => String(link.campaignId)));
	const campaigns = await getCampaigns(account, items.map((item) => item.campaignId));
	for (const campaign of deliveredCampaigns) campaigns.set(String(campaign._id), campaign);

	const entries = [];
	for (const item of items) {
		const campaign = campaigns.get(String(item.campaignId)) ?? null;
		const summary = presentSummary(item, { campaign });
		const isOut = item.channel === "newsletter" && campaign && DELIVERY_STATUSES.includes(campaign.status) && getCampaignTime(campaign);
		if (!isOut) {
			if (item.plannedDate && item.plannedDate >= from && item.plannedDate <= to) entries.push(planned(summary, item));
			continue;
		}
		const entry = delivered(campaign, zone, summary, item);
		if (entry.date >= from && entry.date <= to) entries.push(entry);
	}
	if (!hasItemFilter) for (const campaign of deliveredCampaigns) if (!linked.has(String(campaign._id))) entries.push(delivered(campaign, zone));
	entries.sort(byPlace);

	let backlog = [];
	if (includeBacklog) {
		const undated = await ContentItem.find(scoped(account, { ...itemFilter, plannedDate: { $exists: false } })).sort(BACKLOG_ORDER).limit(MAX_BACKLOG).lean();
		const backlogCampaigns = await getCampaigns(account, undated.map((item) => item.campaignId));
		backlog = undated.map((item) => presentSummary(item, { campaign: backlogCampaigns.get(String(item.campaignId)) ?? null }));
	}
	return {
		from,
		to,
		timeZone: zone,
		entries,
		backlog,
		counts: { planned: entries.filter(({ kind }) => kind === "planned").length, delivery: entries.filter(({ kind }) => kind !== "planned").length, backlog: backlog.length },
	};
}
