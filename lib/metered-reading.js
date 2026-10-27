import "server-only";
import { scoped } from "@/lib/account-scope";
import { PUBLISHED_STATUSES } from "@/lib/archive-issues";
import { connectDb } from "@/lib/db";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { isRateLimited } from "@/lib/rate-limit";
import { limitKey } from "@/lib/reader-links";
import { findSessionReader } from "@/lib/reader-session";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { isInPaidTiers, isPaidContact } from "@/lib/tiers";
import Campaign from "@/models/Campaign";
import MeteredRead from "@/models/MeteredRead";

export function meterPeriod(now = new Date()) {
	return { period: now.toISOString().slice(0, 7), resetsAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)), expiresAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 8)) };
}
export function meterLimit(newsletter) {
	const limit = newsletter.meteredReadsPerMonth;
	return Number.isInteger(limit) && limit >= 1 && limit <= 20 ? limit : 0;
}
function eligible(newsletter, issue, reader, now) {
	return meterLimit(newsletter) > 0 && reader?.status === "active" && !isPaidContact(reader, +now) && issue.audience === "paid" && !issue.audienceTiers?.length && !/\sdata-min-tier\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>]+)/i.test(issue.html ?? "") && PUBLISHED_STATUSES.includes(issue.status) && issue.publishTo !== "email";
}
const reference = (newsletter, reader, period) => scoped(newsletter.accountId, { newsletterId: newsletter._id, contactId: reader._id, period });
export async function meteredReadStatus(newsletter, issue, reader, now = new Date()) {
	if (!eligible(newsletter, issue, reader, now)) return null;
	const { period, resetsAt } = meterPeriod(now);
	const record = await MeteredRead.findOne(reference(newsletter, reader, period)).lean();
	return { allowed: Boolean(record?.issueIds?.includes(String(issue._id))), remaining: Math.max(0, meterLimit(newsletter) - (record?.count ?? 0)), resetsAt: resetsAt.toISOString() };
}
export async function readerIssueEntitlement(newsletter, issue, reader, now = new Date()) {
	const paid = reader?.status === "active" && isPaidContact(reader, +now) && (issue.audience !== "paid" || isInPaidTiers(reader, issue.audienceTiers));
	const meter = paid ? null : await meteredReadStatus(newsletter, issue, reader, now);
	return { paid: Boolean(paid), canReadFull: Boolean(paid || meter?.allowed), meter };
}

// Only the explicit reader action calls this function. Page loads and translation requests cannot spend a free read.
export async function claimMeteredIssue({ slug, post, confirmed, now = new Date() }) {
	if (confirmed !== true) return { error: "Confirm that you want to use a free read." };
	if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(String(slug ?? "")) || !ARCHIVE_SLUG_PATTERN.test(String(post ?? ""))) return { error: "This issue is not available for a free read." };
	await connectDb();
	const newsletter = await findOpenNewsletter({ slug, archiveEnabled: true });
	const reader = newsletter && await findSessionReader(newsletter);
	if (!reader) return { error: "Your session ended. Sign in again." };
	if (await isRateLimited({ name: "metered-read-claim", key: limitKey(`${newsletter._id}:${reader._id}`), limit: 60, window: "1 h" })) return { error: "Free reads are busy. Try again." };
	const issue = await Campaign.findOne(scoped(newsletter.accountId, { newsletterId: newsletter._id, archiveSlug: post, status: { $in: PUBLISHED_STATUSES }, publishTo: { $ne: "email" } })).lean();
	if (!issue || !eligible(newsletter, issue, reader, now)) return { error: "This issue is not available for a free read." };
	const { period, expiresAt } = meterPeriod(now); const filter = reference(newsletter, reader, period); const issueId = String(issue._id);
	// A concurrent first read can create this same unique month row. Never retry with a different identity.
	if (!await MeteredRead.exists(filter)) {
		try { await MeteredRead.create({ ...filter, count: 0, issueIds: [], expiresAt }); } catch (error) { if (error?.code !== 11000) throw error; }
	}
	try {
		await MeteredRead.updateOne({ ...filter, count: { $lt: meterLimit(newsletter) }, issueIds: { $ne: issueId } }, { $inc: { count: 1 }, $addToSet: { issueIds: issueId } });
	} catch (error) {
		if (error.message !== "MeteredRead: could not update, the document kept changing") throw error;
		if (!(await meteredReadStatus(newsletter, issue, reader, now))?.allowed) return { error: "Free reads are busy. Try again." };
	}
	const current = await meteredReadStatus(newsletter, issue, reader, now);
	if (!current?.allowed) return { error: "You have used your free reads for this month." };
	return { ok: true };
}
