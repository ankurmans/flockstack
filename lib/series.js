import "server-only";
import { scoped } from "@/lib/account-scope";
import { getAccountSendProblem, hasActiveSubscription } from "@/lib/account-state";
import { sendAlert } from "@/lib/alerts";
import { cleanRichHtml } from "@/lib/clean-html";
import { isSendingEnabled } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { fetchFeed } from "@/lib/feed-fetch";
import { renderFeedItems, selectFeedItems } from "@/lib/feed-render";
import { MAX_SEEN_IDS, fillSeriesTemplate, getNextRun } from "@/lib/series-rules";
import { queueCampaign } from "@/lib/sending";
import { firstImageUrl } from "@/lib/thumbnail";
import Account from "@/models/Account";
import Campaign from "@/models/Campaign";
import Newsletter from "@/models/Newsletter";
import SeriesPlan from "@/models/SeriesPlan";
import SeriesRun from "@/models/SeriesRun";

const DEFAULT_LIMIT = 25;

function describe(error) {
	return String(error?.message || error).slice(0, 300);
}

// The issue a run makes from the feed's new items: the intro, then the items as plain content.
function buildIssue({ series, items, now }) {
	const subject = fillSeriesTemplate(series.subject, { date: now, firstTitle: items[0].title, count: items.length, timeZone: series.schedule.timeZone });
	const previewText = fillSeriesTemplate(series.previewText, { date: now, firstTitle: items[0].title, count: items.length, timeZone: series.schedule.timeZone });
	const html = `${series.intro ? cleanRichHtml(series.intro) : ""}${renderFeedItems(items, series)}`;
	return { subject: subject.slice(0, 200), previewText: previewText.slice(0, 300), html };
}

// What a run did, for its record: { status, reason?, campaignId?, itemCount? }.
async function makeIssue({ account, series, newsletter, now, isManual }) {
	const feed = await fetchFeed({ account, url: series.feedUrl, now: now.getTime() });
	const items = selectFeedItems(feed.items, series, { since: series.lastItemAt ?? null, seenIds: series.seenIds ?? [] });
	if (items.length === 0) return { status: "skipped", reason: "No new items in the feed" };

	const issue = buildIssue({ series, items, now });
	const campaign = await Campaign.create({
		accountId: account._id,
		newsletterId: newsletter._id,
		subject: issue.subject,
		previewText: issue.previewText,
		format: "rich",
		html: issue.html,
		thumbnailUrl: firstImageUrl({ format: "rich", html: issue.html }) ?? undefined,
		source: "series",
		seriesId: series._id,
	});
	// Everything the feed has now counts as used, the items an issue left out for its limit included: the next issue is of
	// what is published after this one.
	const newest = feed.items.map(({ publishedAt }) => publishedAt).filter(Boolean).sort().at(-1);
	const lastItemAt = [series.lastItemAt, newest].filter(Boolean).map((value) => new Date(value)).sort((a, b) => b - a)[0];
	await SeriesPlan.updateOne(scoped(account, { _id: series._id }), {
		$set: { seenIds: [...new Set([...feed.items.map(({ id }) => id), ...(series.seenIds ?? [])])].slice(0, MAX_SEEN_IDS), ...(lastItemAt && { lastItemAt }) },
	});
	const done = { campaignId: campaign._id, itemCount: items.length };
	const path = `/campaigns/${campaign._id}`;

	if (series.mode === "send" && !isManual) {
		if (!isSendingEnabled()) return { ...done, status: "drafted", reason: "Sending is off on this server, so the issue waits as a draft" };
		try {
			await queueCampaign({ accountId: account._id, campaignId: String(campaign._id) });
			return { ...done, status: "sent" };
		} catch (error) {
			await sendAlert({
				accountId: account._id,
				key: `series-send-${series._id}`,
				title: "A series issue didn't go out",
				detail: `"${issue.subject}" from ${series.name}: ${describe(error).replace(/\.$/, "")}. It is a draft for you to look at.`,
				path,
				cooldownMinutes: 60,
			});
			return { ...done, status: "drafted", reason: `Not sent: ${describe(error)}` };
		}
	}
	if (!isManual) {
		await sendAlert({
			accountId: account._id,
			key: `series-draft-${series._id}`,
			title: "A draft is ready to review",
			detail: `"${issue.subject}" has ${items.length === 1 ? "1 new item" : `${items.length} new items`} from ${series.name}. Look it over and send it.`,
			path,
			cooldownMinutes: 60,
		});
	}
	return { ...done, status: "drafted" };
}

async function decideRun({ series, now, isManual }) {
	const account = await Account.findById(series.accountId).lean();
	if (!account || !hasActiveSubscription(account)) return { status: "skipped", reason: "The account has no active plan" };
	const problem = getAccountSendProblem(account);
	if (problem) return { status: "skipped", reason: problem.message };
	const newsletter = await Newsletter.findOne(scoped(account, { _id: series.newsletterId })).lean();
	if (!newsletter) return { status: "skipped", reason: "The newsletter is gone" };
	try {
		return await makeIssue({ account, series, newsletter, now, isManual });
	} catch (error) {
		await sendAlert({
			accountId: account._id,
			key: `series-feed-${series._id}`,
			title: "A series couldn't make its issue",
			detail: `${series.name}: ${describe(error).replace(/\.$/, "")}. It tries again at its next run.`,
			path: `/series/${series._id}`,
			cooldownMinutes: 24 * 60,
		});
		return { status: "failed", reason: describe(error) };
	}
}

// One run of a series for a slot, the moment it was due. A slot runs once however often a job is delivered: the record is
// the lock. A manual run (isManual) leaves a draft, whatever the series' mode.
export async function runSeries({ series, slot, now = new Date(), isManual = false }) {
	await connectDb();
	let run;
	try {
		run = await SeriesRun.create({ accountId: series.accountId, seriesId: series._id, newsletterId: series.newsletterId, slot, isManual });
	} catch (error) {
		if (error?.code === 11000) return { skipped: "this slot already ran" };
		throw error;
	}
	let outcome;
	try {
		outcome = await decideRun({ series, now, isManual });
	} catch (error) {
		console.error(`[series] ${series._id} failed:`, error);
		outcome = { status: "failed", reason: describe(error) };
	}
	const { modifiedCount } = await SeriesRun.updateOne(scoped(series.accountId, { _id: run._id }), { $set: { ...outcome, finishedAt: new Date() } });
	if (!modifiedCount) console.error(`[series] ${series._id}: run ${run._id} not saved`);
	return outcome;
}

// The job: every active series whose time has come. The series is claimed first by moving its next run on, in the same
// write that checks nobody else did, so a job delivered twice, or two at once, runs it once; after downtime a series
// runs once for what it missed, not once per missed day.
export async function runDueSeries({ now = new Date(), limit = DEFAULT_LIMIT } = {}) {
	await connectDb();
	const due = await SeriesPlan.find({ active: true, nextRunAt: { $lte: now } })
		.sort({ nextRunAt: 1 })
		.limit(limit)
		.setOptions({ crossAccount: true })
		.lean();
	const result = { due: due.length, ran: 0, hasMore: due.length === limit };
	for (const series of due) {
		const { modifiedCount } = await SeriesPlan.updateOne(
			{ accountId: series.accountId, _id: series._id, active: true, nextRunAt: series.nextRunAt },
			{ $set: { nextRunAt: getNextRun(series.schedule, now), lastRunAt: now } }
		);
		if (!modifiedCount) continue;
		try {
			await runSeries({ series, slot: series.nextRunAt.toISOString(), now });
			result.ran += 1;
		} catch (error) {
			console.error(`[series] ${series._id} could not run:`, error);
		}
	}
	return result;
}
