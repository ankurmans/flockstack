import "server-only";
import { scoped } from "@/lib/account-scope";
import { campaignContentHash } from "@/lib/campaign-content-hash";
import { CLAIM_CHECK, buildClaimReport, issueUnits, planChecks } from "@/lib/claim-check-rules";
import { getAppUrl } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { isRateLimited } from "@/lib/rate-limit";
import { publishJob } from "@/lib/sending";
import ClaimCheck from "@/models/ClaimCheck";

// The claim check (docs/CLAIM-CHECK.md) as the ready-to-send check asks for it: nothing to check, the kept result for these
// same words, or a check-claims job started (lib/claim-check-run.js reads the pages). It never runs inside a send: a send
// only reads the kept result, and only for a newsletter that requires the check to pass.
const STARTS = { name: "claim-check-starts", limit: 30, window: "1 h" };

const NEEDS_CHECK = "This newsletter needs the claim check to pass before a send, and it hasn't finished on these words: open the ready-to-send check (check_campaign) and wait for its result";

function describeFailures({ counts }) {
	const parts = [];
	if (counts.deadLinks) parts.push(`${counts.deadLinks === 1 ? "a link that doesn't" : `${counts.deadLinks} links that don't`} load`);
	if (counts.unmatchedFigures) parts.push(`${counts.unmatchedFigures === 1 ? "a figure that isn't" : `${counts.unmatchedFigures} figures that aren't`} on the page it links to`);
	if (counts.uncitedClaims) parts.push(`${counts.uncitedClaims === 1 ? "a paragraph" : `${counts.uncitedClaims} paragraphs`} with figures and no source`);
	return parts.join(", ");
}

function hasWork(units, plan) {
	return plan.total > 0 || units.some(({ figures }) => figures.length);
}

// { state: none | checking | done | error, required, total, report }.
export async function getClaimState({ account, campaign, newsletter, now = Date.now() }) {
	const required = Boolean(newsletter?.requireClaimCheck);
	const units = issueUnits(campaign);
	const plan = planChecks(units);
	if (!hasWork(units, plan)) return { state: "none", required };
	// With no link there is nothing to open: the figures are all without a source, and that is known now.
	if (plan.total === 0) return { state: "done", required, report: buildClaimReport({ units, checkedAt: now }) };
	const hash = campaignContentHash(campaign);
	await connectDb();
	const row = await ClaimCheck.findOne(scoped(account, { campaignId: campaign._id })).lean();
	if (row?.hash === hash) {
		const age = now - new Date(row.checkedAt ?? row.startedAt).getTime();
		if (row.status === "done" && age < CLAIM_CHECK.cacheMs) return { state: "done", required, report: row.report };
		if (row.status === "running" && age < CLAIM_CHECK.runningMs) return { state: "checking", required, total: plan.links.length };
	}
	if (await isRateLimited({ ...STARTS, key: String(account._id) })) return { state: "error", required };
	await ClaimCheck.updateOne(
		scoped(account, { campaignId: campaign._id }),
		{ $set: { hash, status: "running", startedAt: new Date(now) }, $unset: { checkedAt: 1, report: 1 } },
		{ upsert: true }
	);
	try {
		await publishJob({ url: `${getAppUrl()}/api/jobs/check-claims`, body: { accountId: String(account._id), campaignId: String(campaign._id), hash } });
	} catch (error) {
		console.error("[claim-check] Starting the check failed:", error.message);
		await ClaimCheck.deleteOne(scoped(account, { campaignId: campaign._id }));
		return { state: "error", required };
	}
	return { state: "checking", required, total: plan.links.length };
}

// Why a send must wait, for a newsletter that requires the claim check to pass: no finished check for the issue's words as
// they are, or one that found something. Null otherwise, and always for a newsletter that only warns (the default).
export async function getClaimSendProblem({ account, campaign, newsletter }) {
	if (!newsletter?.requireClaimCheck) return null;
	const units = issueUnits(campaign);
	const plan = planChecks(units);
	if (!hasWork(units, plan)) return null;
	let report;
	if (plan.total === 0) report = buildClaimReport({ units });
	else {
		const row = await ClaimCheck.findOne(scoped(account, { campaignId: campaign._id })).lean();
		if (row?.status !== "done" || row.hash !== campaignContentHash(campaign)) return NEEDS_CHECK;
		report = row.report;
	}
	return report.failures ? `This newsletter needs the claim check to pass before a send, and it found ${describeFailures(report)}` : null;
}

// What check_campaign answers about the claim check, the same shape in every state.
export function toClaimOutput(claims) {
	const report = claims?.state === "done" ? claims.report : null;
	return {
		state: claims?.state ?? "none",
		required: Boolean(claims?.required),
		passed: claims?.state === "none" ? true : report ? report.failures === 0 : null,
		deadLinks: report?.deadLinks ?? [],
		unsureLinks: report?.unsureLinks ?? [],
		unmatchedFigures: report?.unmatchedFigures ?? [],
		unconfirmedFigures: report?.unconfirmedFigures ?? [],
		uncitedClaims: report?.uncitedClaims ?? [],
		counts: report?.counts ?? { deadLinks: 0, unsureLinks: 0, unmatchedFigures: 0, unconfirmedFigures: 0, uncitedClaims: 0 },
		figuresChecked: report?.figuresChecked ?? 0,
		linksChecked: report?.linksChecked ?? 0,
		linksTotal: report?.linksTotal ?? claims?.total ?? 0,
		pagesRead: report?.pagesRead ?? 0,
		checkedAt: report?.checkedAt ?? null,
	};
}

// Results nobody looked at for a week, for the hourly job.
export async function purgeOldClaimChecks(now = Date.now()) {
	const cutoff = new Date(now - 7 * 24 * 60 * 60_000);
	return (await ClaimCheck.deleteMany({ $or: [{ checkedAt: { $lt: cutoff } }, { checkedAt: { $exists: false }, startedAt: { $lt: cutoff } }] }).setOptions({ crossAccount: true })).deletedCount ?? 0;
}
