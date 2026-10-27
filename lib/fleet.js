import "server-only";
import { scoped } from "@/lib/account-scope";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getBrandZones } from "@/lib/brand-domains";
import { listNewslettersWithActiveCounts } from "@/lib/contacts";
import { connectDb } from "@/lib/db";
import { getNewsletterLimit } from "@/lib/newsletters";
import { getNewsletterSendProblem, newsletterHealthPipeline } from "@/lib/newsletter-health";
import { getRateLimits } from "@/lib/rate-levels";
import { getWarmup } from "@/lib/send-spread";
import { ACCOUNT_CHECK_DAYS } from "@/lib/sending-rules";
import Campaign from "@/models/Campaign";
import Message from "@/models/Message";

export async function getBrandFleet(account, now = new Date()) {
	await connectDb();
	const [newsletters, health, sends] = await Promise.all([
		listNewslettersWithActiveCounts(account, "name slug fromEmail archiveEnabled archiveHost sharedSender sendingBrake spreadUntil senderChangedAt"),
		Message.aggregate(newsletterHealthPipeline(account, { now })),
		Campaign.aggregate([
			{ $match: scoped(account, { status: "sent", sentAt: { $ne: null } }) },
			{ $project: { newsletterId: 1, sentAt: 1 } },
			{ $group: { _id: "$newsletterId", sentAt: { $max: "$sentAt" } } },
		]),
	]);
	const byId = (rows) => new Map(rows.map((row) => [String(row._id), row]));
	const counts = byId(health), last = byId(sends);
	return {
		asOf: now.toISOString(), periodDays: ACCOUNT_CHECK_DAYS, newsletterLimit: getNewsletterLimit(account),
		limits: getRateLimits(account).pause,
		domains: getBrandZones(account).map(({ domain }) => domain),
		newsletters: newsletters.map((newsletter) => {
			const id = String(newsletter._id);
			const { sent = 0, bounced = 0, complained = 0 } = counts.get(id) ?? {};
			return {
				id, name: newsletter.name, slug: newsletter.slug, fromEmail: newsletter.fromEmail,
				archiveUrl: newsletter.archiveEnabled ? getArchiveUrls(newsletter).siteIndex : null,
				subscribers: newsletter.activeCount, lastSentAt: last.get(id)?.sentAt ? new Date(last.get(id).sentAt).toISOString() : null,
				health: { sent, bounced, complained, bounceRate: sent ? bounced / sent : null, complaintRate: sent ? complained / sent : null },
				paused: Boolean(newsletter.sendingBrake?.at), reason: getNewsletterSendProblem(newsletter),
				warmup: getWarmup(newsletter, { now }),
			};
		}),
	};
}
