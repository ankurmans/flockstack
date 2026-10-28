import "server-only";
import { createFetcher, mapLimited } from "@/lib/briefings/fetch";
import { fullPageText } from "@/lib/briefings/readable";
import { campaignContentHash } from "@/lib/campaign-content-hash";
import { CLAIM_CHECK, buildClaimReport, issueUnits, pageValues, planChecks } from "@/lib/claim-check-rules";
import { connectDb } from "@/lib/db";
import { judgeStatus } from "@/lib/link-check-rules";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import ClaimCheck from "@/models/ClaimCheck";

// The check-claims job (docs/CLAIM-CHECK.md): every request goes through the briefings engine's fetcher (lib/briefings/fetch.js),
// so it is held to the same guards: public addresses only, each name resolved and every address checked, again on each
// redirect, robots.txt for FlockStack's user agent, 1 MB and 8 s a request, two at a time per host, no cookies. On top of that,
// CLAIM_CHECK's caps on links, pages, requests and time for one check.
const READABLE = /html|xml|text\/plain|json/;

// A page read whole: the link's state, and the figures on the page or why it couldn't be read. A failure that isn't the
// page's own answer (a refused address, a redirect to plain http, no answer) is judged again as a link, by the link rules.
async function readPage(fetcher, url) {
	if (!/^https:/i.test(url)) return { link: await fetcher.checkLink(url), page: { problem: "only https pages are read" } };
	try {
		const page = await fetcher.get(url);
		const type = page.contentType.toLowerCase();
		if (type && !READABLE.test(type)) return { link: { state: "ok" }, page: { problem: `it is a file (${type.split(";")[0]}), not a page` } };
		return { link: { state: "ok" }, page: { values: pageValues(/html|xml/.test(type) || !type ? fullPageText(page.text) : page.text) } };
	} catch (error) {
		const problem = error?.message ?? "it couldn't be read";
		if (error?.status) return { link: judgeStatus(error.status), page: { problem } };
		if (error?.robots) return { link: { state: "unsure", reason: "robots.txt asks FlockStack not to open it" }, page: { problem } };
		if (/over 1 MB/.test(problem)) return { link: { state: "ok" }, page: { problem } };
		if (/too long/.test(problem)) return { link: { state: "unsure", reason: problem }, page: { problem } };
		if (/reached its/.test(problem)) return { link: { state: "unsure", reason: "not checked: the check reached its request limit" }, page: { problem: "not read: the check reached its request limit" } };
		return { link: await fetcher.checkLink(url), page: { problem } };
	}
}

// The check itself, from the issue's units: the links to judge, CLAIM_CHECK.concurrency at a time, the ones a paragraph's figures need
// read whole. No request starts after CLAIM_CHECK.timeMs; what wasn't reached is reported as not checked.
export async function checkIssue({ units, fetchImpl = globalThis.fetch, resolveHost, now = () => Date.now() }) {
	const { links, pages, total } = planChecks(units);
	const deadline = now() + CLAIM_CHECK.timeMs;
	const fetcher = createFetcher({ fetchImpl, resolveHost, perRun: CLAIM_CHECK.maxRequests, now });
	const toRead = new Set(pages);
	const linkStates = {};
	const read = {};
	await mapLimited(links, CLAIM_CHECK.concurrency, async (url) => {
		if (now() >= deadline) {
			if (toRead.has(url)) read[url] = { problem: "not read: the check reached its time limit" };
			return;
		}
		if (toRead.has(url)) {
			const { link, page } = await readPage(fetcher, url);
			linkStates[url] = { state: link.state, reason: link.reason ?? null };
			read[url] = page;
		} else {
			const link = await fetcher.checkLink(url);
			linkStates[url] = { state: link.state, reason: link.reason ?? null };
		}
	});
	return { report: buildClaimReport({ units, linkStates, pages: read, total, checkedAt: now() }), requests: fetcher.count };
}

// Runs when QStash delivers the job. A job for words the issue no longer has, or whose result is kept already, does nothing.
// fetchImpl and resolveHost are for tests; in production they are the Worker's fetch and its DNS over HTTPS.
export async function runClaimCheck({ accountId, campaignId, hash }, { fetchImpl, resolveHost, now } = {}) {
	if (!isObjectIdString(String(accountId)) || !isObjectIdString(String(campaignId)) || typeof hash !== "string") return { skipped: "invalid job" };
	await connectDb();
	const row = await ClaimCheck.findOne({ accountId, campaignId }).lean();
	if (row?.status !== "running" || row.hash !== hash) return { skipped: "not waiting for this check" };
	const campaign = await Campaign.findOne({ accountId, _id: campaignId }).lean();
	if (!campaign || campaignContentHash(campaign) !== hash) {
		await ClaimCheck.deleteOne({ accountId, campaignId });
		return { skipped: "the issue changed" };
	}
	const { report, requests } = await checkIssue({ units: issueUnits(campaign), fetchImpl, resolveHost, now });
	await ClaimCheck.updateOne({ accountId, campaignId, hash, status: "running" }, { $set: { status: "done", checkedAt: new Date(), report } });
	return { checked: report.linksChecked, pagesRead: report.pagesRead, failures: report.failures, requests };
}
