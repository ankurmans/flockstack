import "server-only";
import { scoped } from "@/lib/account-scope";
import { getAppUrl } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { LINK_CHECK, getLinkProblem, hashLinks, judgeStatus } from "@/lib/link-check-rules";
import { findLinks } from "@/lib/ready-check";
import { isRateLimited } from "@/lib/rate-limit";
import { markdownToHtml } from "@/lib/markdown";
import { publishJob } from "@/lib/sending";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import LinkCheck from "@/models/LinkCheck";

// A started check per account and hour at most: a writer who keeps changing links can't turn the check into a way to make
// FlockStack open pages over and over.
const STARTS = { name: "link-check-starts", limit: 30, window: "1 h" };
const USER_AGENT = "FlockStack link check (+https://flockstack.io)";

// The addresses an issue links to, in the order the issue has them.
export function getCampaignLinks(campaign) {
	const html = campaign.format === "markdown" ? markdownToHtml(campaign.markdown ?? "") : (campaign.html ?? "");
	return findLinks(html);
}

async function request(url, method) {
	return fetch(url, {
		method,
		redirect: "manual",
		headers: { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.8", ...(method === "GET" && { range: "bytes=0-0" }) },
		signal: AbortSignal.timeout(LINK_CHECK.timeoutMs),
	});
}

// One address: asked for its head, then for its first byte when the site doesn't take that, following a few redirects by
// hand and judging each address on the way by the same rule as the first.
export async function checkLink(link) {
	let url = link;
	let method = "HEAD";
	for (let hops = 0; hops <= LINK_CHECK.redirects; ) {
		const problem = getLinkProblem(url);
		if (problem) return { url: link, state: "broken", reason: hops === 0 ? problem : `redirects to an address that ${problem}` };
		let response;
		try {
			response = await request(url, method);
		} catch (error) {
			if (error?.name === "TimeoutError" || error?.name === "AbortError") return { url: link, state: "unsure", reason: "took too long to answer" };
			return { url: link, state: "broken", reason: "the site couldn't be reached" };
		}
		await response.body?.cancel();
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			try {
				url = new URL(location, url).href;
			} catch {
				return { url: link, state: "broken", reason: "redirects to a bad address" };
			}
			hops += 1;
			continue;
		}
		if (method === "HEAD" && response.status >= 400 && response.status !== 404 && response.status !== 410) {
			method = "GET";
			continue;
		}
		return { url: link, ...judgeStatus(response.status) };
	}
	return { url: link, state: "broken", reason: "redirects too many times" };
}

async function checkAll(urls) {
	const results = new Array(urls.length);
	let next = 0;
	async function worker() {
		while (next < urls.length) {
			const index = next++;
			results[index] = await checkLink(urls[index]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(LINK_CHECK.concurrency, urls.length) }, worker));
	return results;
}

// What the review step shows of a kept check.
function toState(row, total) {
	if (row.status === "running") return { state: "checking", total };
	const results = row.results ?? [];
	return {
		state: "done",
		total,
		checked: results.length,
		broken: results.filter(({ state }) => state === "broken").map(({ url, reason }) => ({ url, reason })),
		unsure: results.filter(({ state }) => state === "unsure").length,
	};
}

// The state of a draft's links for the ready-to-send check: none to open, the kept result for these same addresses, or a
// check just started (a job, so the review step can say "checking…" and ask again).
export async function getLinkState({ account, campaign, now = Date.now() }) {
	const urls = getCampaignLinks(campaign);
	if (urls.length === 0) return { state: "none" };
	const hash = hashLinks(urls.slice(0, LINK_CHECK.maxLinks));
	await connectDb();
	const row = await LinkCheck.findOne(scoped(account, { campaignId: campaign._id })).lean();
	if (row?.hash === hash) {
		const age = now - new Date(row.checkedAt ?? row.startedAt).getTime();
		if (row.status === "done" && age < LINK_CHECK.cacheMs) return toState(row, urls.length);
		if (row.status === "running" && age < LINK_CHECK.runningMs) return toState(row, urls.length);
	}
	if (await isRateLimited({ ...STARTS, key: String(account._id) })) return { state: "error" };
	await LinkCheck.updateOne(
		scoped(account, { campaignId: campaign._id }),
		{ $set: { hash, status: "running", total: urls.length, startedAt: new Date(now), results: [] }, $unset: { checkedAt: 1 } },
		{ upsert: true }
	);
	try {
		await publishJob({ url: `${getAppUrl()}/api/jobs/check-links`, body: { accountId: String(account._id), campaignId: String(campaign._id), hash } });
	} catch (error) {
		console.error("[link-check] Starting the check failed:", error.message);
		await LinkCheck.deleteOne(scoped(account, { campaignId: campaign._id }));
		return { state: "error" };
	}
	return { state: "checking", total: urls.length };
}

// Results nobody looked at for a week, for the hourly job.
export async function purgeOldLinkChecks(now = Date.now()) {
	const cutoff = new Date(now - 7 * 24 * 60 * 60_000);
	return (await LinkCheck.deleteMany({ $or: [{ checkedAt: { $lt: cutoff } }, { checkedAt: { $exists: false }, startedAt: { $lt: cutoff } }] }).setOptions({ crossAccount: true })).deletedCount ?? 0;
}

// Runs when QStash delivers the job: opens the draft's first addresses and keeps what it found. A job for addresses the draft
// no longer has, or whose result is kept already, does nothing.
export async function runLinkCheck({ accountId, campaignId, hash }) {
	if (!isObjectIdString(String(accountId)) || !isObjectIdString(String(campaignId)) || typeof hash !== "string") return { skipped: "invalid job" };
	await connectDb();
	const row = await LinkCheck.findOne({ accountId, campaignId }).lean();
	if (row?.status !== "running" || row.hash !== hash) return { skipped: "not waiting for this check" };
	const campaign = await Campaign.findOne({ accountId, _id: campaignId }).lean();
	const urls = campaign ? getCampaignLinks(campaign).slice(0, LINK_CHECK.maxLinks) : [];
	if (hashLinks(urls) !== hash) {
		await LinkCheck.deleteOne({ accountId, campaignId });
		return { skipped: "the links changed" };
	}
	const results = await checkAll(urls);
	await LinkCheck.updateOne({ accountId, campaignId, hash, status: "running" }, { $set: { status: "done", checkedAt: new Date(), results } });
	return { checked: results.length, broken: results.filter(({ state }) => state === "broken").length };
}
