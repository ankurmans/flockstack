import "server-only";
import { summarizeCall } from "@/lib/agent-activity-rules";
import { scoped } from "@/lib/account-scope";
import { loadAction } from "@/lib/actions/lazy";
import { runAction } from "@/lib/actions/run-action";
import { sendAlert } from "@/lib/alerts";
import { BRIEFING_ACTOR_PREFIX, proposeApproval } from "@/lib/approvals";
import { createPauseToken, getPauseLinkUrl } from "@/lib/briefing-pause-links";
import { AUTO_SEND, READY_CHECK_WAIT_MS } from "@/lib/briefing-rules";
import { createVerdictToken, getVerdictLinkUrl } from "@/lib/briefing-verdict-links";
import { findOwnerEmail } from "@/lib/accounts";
import { getAppUrl } from "@/lib/config";
import { LIMITS } from "@/lib/content-rules";
import { connectDb } from "@/lib/db";
import { storeBriefingTranslations } from "@/lib/briefing-translations";
import { isOnFreeTier } from "@/lib/plans";
import Account from "@/models/Account";
import Briefing from "@/models/Briefing";
import BriefingRun from "@/models/BriefingRun";
import Campaign from "@/models/Campaign";
import Newsletter from "@/models/Newsletter";
import TeamSeat from "@/models/TeamSeat";

// Step 9 of a briefing run (docs/BRIEFINGS-DESIGN.md, "The run"): the issue becomes a draft campaign, with its
// translations kept for readers who choose them; the content calendar gets the issue with its sources; a test email goes to the
// briefing's test address; and the owner gets a note with the checks, the cost and a keep or drop link per story. Everything goes through runAction, as the dashboard's
// own writes do, with via "briefing". The briefings Worker reaches this through the API Worker's BriefingsDelivery entrypoint; a
// self-hosted server's hourly cron calls it directly. Every step is safe to repeat: a run cut off mid-delivery is delivered again on
// the next tick and finds what it already made.
//
// The one send in here is a briefing whose owner turned on sending by itself (docs/BRIEFINGS-DESIGN.md, Auto-send). The engine's
// own verdict (no thin run, no unfinished step, no check that is not a pass) is only the first condition: this module reads the
// briefing, the plan, the newsletter and the issue again, runs the ready-to-send check with its claim check, and sends through
// send_campaign, so the plan's limits, the Free plan's guards and the send blockers apply as for any send. Anything that fails
// leaves the draft, with the reason in heldReason and in the owner's note.
const VIA = "briefing";
const SUBJECT_MAX = 200;
const PREVIEW_MAX = 300;
// A note for one run is sent once, however often its delivery is retried.
const RUN_NOTE_COOLDOWN_MINUTES = 7 * 24 * 60;

const clip = (value, max) => String(value ?? "").trim().slice(0, max);

async function loadAccount(accountId) {
	await connectDb();
	const account = await Account.findById(accountId).lean();
	if (!account) throw new Error("The briefing's account is gone");
	return account;
}

// One newsletter item per issue, linked to the draft: an issue belongs to one newsletter item (the unique (accountId, campaignId)
// index), and an item per story would fill a newsletter's 5,000-item calendar within a year of daily runs. The stories' own pages
// come first in its references, then what they cite, up to the calendar's limit.
export function issueReferences(stories = []) {
	const seen = new Set();
	const references = [];
	const add = (reference) => {
		const url = clip(reference?.url, LIMITS.url);
		if (!/^https?:\/\//i.test(url) || seen.has(url) || references.length >= LIMITS.references) return;
		seen.add(url);
		references.push({ url, label: clip(reference.label, LIMITS.label), kind: reference.kind === "evidence" ? "evidence" : "reference" });
	};
	for (const story of stories) add({ url: story.url, label: story.title, kind: "reference" });
	for (const story of stories) for (const reference of story.references ?? []) add(reference);
	return references;
}

function issueBody(stories = []) {
	return stories
		.map((story) => `- ${clip(story.title, 300)}`)
		.join("\n")
		.slice(0, LIMITS.body);
}

const HELD = {
	review_mode: "Kept as a draft for your review.",
	thin: "Kept as a draft: discovery found less than usual.",
	checks: "Kept as a draft: a check did not pass.",
	partial: "Kept as a draft: part of the run did not finish.",
	agent_approval: "Waiting for your approval: the newsletter asks before an agent sends, so it is on the Approvals page and nothing has gone out.",
	daily_cap: "Kept as a draft: this briefing already sent its allowance of issues today.",
};
// The ready-to-send items that do not describe the issue: the test email is sent beside the draft, and is not a reason to hold it.
const NOT_ABOUT_THE_ISSUE = new Set(["test"]);

// The keep and drop links of each story, to the confirmation page. They are plain links in a plain-text email: sendAlert sends text
// only, through lib/platform-email.js, and nothing there rewrites links or counts clicks.
export function verdictLinks({ accountId, runId, stories = [], appUrl = getAppUrl(), now = Date.now() }) {
	return stories
		.filter((story) => /^[A-Za-z0-9_-]{1,100}$/.test(String(story?.storyKey ?? "")))
		.map((story) => ({
			title: clip(story.title, 200),
			kind: story.kind === "brief" ? "brief" : "full",
			sourceKind: story.sourceKind ?? null,
			keep: getVerdictLinkUrl(appUrl, createVerdictToken({ accountId, runId, storyKey: story.storyKey, verdict: "keep" }, now)),
			drop: getVerdictLinkUrl(appUrl, createVerdictToken({ accountId, runId, storyKey: story.storyKey, verdict: "drop" }, now)),
		}));
}

// The owner's note on the run: checks, cost (per section too), what discovery could not do and why it was held. It is never part
// of the issue.
const SECTION_MISSING = { empty: "empty: no story for it, so it isn't in the issue", skipped_budget: "skipped: its share of the budget ran out", failed: "failed" };

// One line per section: what it cost, and why one is missing from the issue.
export function describeSections(sections = []) {
	if (!Array.isArray(sections) || sections.length === 0) return [];
	const lines = ["", "Sections:"];
	for (const section of sections.slice(0, 20)) {
		const missing = SECTION_MISSING[section.status];
		const items = Number(section.items) || 0;
		lines.push(`- ${clip(section.title || section.id, 60)}: ${missing ?? `${items} ${items === 1 ? "story" : "stories"}`}, $${Number(section.costUsd || 0).toFixed(4)}${section.status === "failed" && section.problem ? ` (${clip(section.problem, 200)})` : ""}`);
	}
	return lines;
}

export function describeRun({ checks = [], costUsd = 0, testEmail, testResult, thin = false, heldReason = null, holdDetail = [], sent = false, discoveryNotes = [], redirected = null, sections = [] }) {
	const count = (status) => checks.filter((check) => check.status === status).length;
	const lines = [];
	if (sent) lines.push("Sent to your audience by itself, because every check passed. A send can't be taken back; the pause link below stops the next ones.");
	if (heldReason && HELD[heldReason]) lines.push(HELD[heldReason]);
	for (const line of holdDetail.slice(0, 12)) lines.push(`- ${clip(line, 300)}`);
	if (thin) lines.push("This run was thin: discovery found fewer candidates than it needs for a full issue.");
	lines.push(`Checks: ${count("pass")} passed, ${count("warning")} ${count("warning") === 1 ? "warning" : "warnings"}, ${count("blocker")} ${count("blocker") === 1 ? "blocker" : "blockers"}.`);
	for (const check of checks.filter(({ status }) => status !== "pass")) lines.push(`${check.status === "blocker" ? "Blocker" : "Warning"}: ${clip(check.message, 300)}`);
	lines.push(`Model cost of this run: $${Number(costUsd || 0).toFixed(4)}.`);
	if (redirected) lines.push(`${redirected} is no longer you or a member of your team, so the test email went to ${testEmail} instead.`);
	if (testResult === "sent") lines.push(`A test email went to ${testEmail}.`);
	else if (testResult === "already") lines.push(`A test email was already sent for this draft.`);
	else if (testResult) lines.push(`The test email to ${testEmail || "the test address"} was not sent: ${testResult}`);
	lines.push(...describeSections(sections));
	if (discoveryNotes.length > 0) {
		lines.push("", "What discovery could not do:");
		for (const note of discoveryNotes.slice(0, 20)) lines.push(`- ${clip(note.provider, 40)}: ${clip(note.problem, 300)}${note.until ? ` (until ${new Date(note.until).toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""}`);
	}
	return lines.join("\n");
}

// The keep and drop links of the note: emailed only, never logged (sendAlert's emailOnly), since each records a verdict without a
// sign-in.
export function describeLinks(links = []) {
	if (links.length === 0) return "";
	const lines = ["Keep or drop each story, so later issues pick more of what you want. Each link opens a page that asks before it records anything."];
	for (const link of links) lines.push("", `${link.title}${link.kind === "brief" ? " (brief)" : ""}${link.sourceKind === "press_release" ? " (press release)" : ""}`, `Keep: ${link.keep}`, `Drop: ${link.drop}`);
	return lines.join("\n");
}

// The pause link of the note after an auto-send, emailed only: it pauses the briefing without a sign-in.
export function describePause(url) {
	return url ? `If this should not have gone out, pause the briefing so the next issue waits for you. The link opens a page that asks before it pauses anything:\n${url}` : "";
}

// Where the test email goes: the briefing's address while it is still the owner's or an active team member's (checked when it was
// saved, and again now, since people leave teams), else the owner's. redirected: the address it no longer goes to.
async function findTestAddress(account, testEmail) {
	if (!testEmail) return { to: null, redirected: null };
	const owner = (await findOwnerEmail(account._id))?.toLowerCase() ?? null;
	const wanted = String(testEmail).trim().toLowerCase();
	if (wanted === owner || (await TeamSeat.exists(scoped(account, { email: wanted, status: "active" })))) return { to: wanted, redirected: null };
	return { to: owner, redirected: wanted };
}

async function sendTest(account, campaignId, testEmail) {
	if (!testEmail) return "the briefing has no test address.";
	const campaign = await Campaign.findOne(scoped(account, { _id: campaignId })).select({ status: 1, testSentAt: 1 }).lean();
	if (campaign?.testSentAt) return "already";
	if (campaign?.status !== "draft") return "the campaign is no longer a draft.";
	try {
		await runAction("send_test_email", { account, input: { id: campaignId, to: [testEmail] }, via: VIA });
		return "sent";
	} catch (error) {
		return `${error?.message ?? "it failed"}`.replace(/\.?$/, ".");
	}
}

const startOfUtcDay = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

// The ready-to-send items worth holding an issue for: every blocker and warning (a warning never stops a send by hand, but an
// issue nobody looks at gets the stricter reading), and the claim check not having run. The test email is sent beside the draft
// and says nothing about it.
export function findReadyProblems(check) {
	const problems = (check?.items ?? []).filter(({ status, id }) => (status === "blocker" || status === "warning") && !NOT_ABOUT_THE_ISSUE.has(id)).map(({ title, message }) => `${title}: ${message}`);
	if (check?.claims?.state === "error") problems.push("Claim check: it could not start (too many checks this hour), so the issue was not checked for dead links and figures with no source.");
	return problems;
}

const held = (heldReason, ...holdDetail) => ({ status: "drafted", heldReason, holdDetail });

// Whether a run that passed the engine's own checks may be sent, and the send. { status: "sent" | "drafted" | "checking", heldReason,
// holdDetail[] }. "checking": the links or the claim check are still being read, ask again (the checks are kept for the issue's
// words, so asking costs nothing). Every refusal is a draft, never an error.
async function settleSend({ account, campaign, payload }) {
	if (payload.heldReason) return held(payload.heldReason);
	if (payload.reviewMode !== "send_if_checks_pass") return held("review_mode");
	// A run the owner asked for by hand is theirs to look at (run_briefing: "a draft, never a send").
	if (String(payload.slot).startsWith("manual:")) return held("review_mode", "A run you start by hand is always kept as a draft.");
	const briefing = await Briefing.findOne(scoped(account, { _id: payload.briefingId })).select({ name: 1, status: 1, reviewMode: 1, autoSendDailyCap: 1 }).lean();
	if (!briefing || briefing.reviewMode !== "send_if_checks_pass" || briefing.status !== "active") return held("review_mode", "Sending by itself was turned off, or the briefing paused, while this run was going.");
	if (isOnFreeTier(account)) return held("review_mode", "The Free plan keeps a briefing's issues as drafts: a paid plan sends them by itself.");

	const current = await Campaign.findOne(scoped(account, { _id: campaign.id })).select({ status: 1 }).lean();
	if (current && current.status !== "draft") return { status: "sent", alreadySent: true };

	const cap = Math.min(AUTO_SEND.maxDailyCap, Math.max(1, Number(briefing.autoSendDailyCap) || AUTO_SEND.dailyCap));
	const sentToday = await BriefingRun.countDocuments(scoped(account, { briefingId: briefing._id, autoSentAt: { $gte: startOfUtcDay(new Date()) } }));
	if (sentToday >= cap) return held("daily_cap", `${sentToday === 1 ? "One issue" : `${sentToday} issues`} already went out by itself today (UTC), and this briefing's allowance is ${cap}.`);

	const check = await runAction("check_campaign", { account, input: { id: campaign.id }, via: VIA });
	if (check.isChecking && !payload.checksTimedOut) return { status: "checking" };
	const problems = findReadyProblems(check);
	if (check.isChecking) problems.push(`The ready-to-send check (${check.checking.join(" and ")}) did not finish in ${READY_CHECK_WAIT_MS / 60_000} minutes.`);
	if (check.blockers > 0 || problems.length > 0) return held("checks", ...problems);

	const newsletter = await Newsletter.findOne(scoped(account, { _id: payload.newsletterId })).select({ agentApproval: 1 }).lean();
	const input = { id: campaign.id };
	if (newsletter?.agentApproval) {
		// An agent's send waits for the owner on the Approvals page when the newsletter asks (lib/agent-guard.js); a briefing sends as
		// an app of its own name, and approving runs send_campaign once with this exact input.
		const action = await loadAction("send_campaign");
		try {
			await proposeApproval({
				account,
				agent: { type: "app", id: `${BRIEFING_ACTOR_PREFIX}${briefing._id}`, name: `Briefing: ${briefing.name}`, preset: "send_with_approval" },
				action,
				className: "send",
				input,
				newsletterId: payload.newsletterId,
				via: VIA,
				requestId: `briefing:${payload.runId}`,
				reason: "newsletter",
				summary: summarizeCall(action, input),
			});
		} catch (error) {
			return held("checks", `Asking for your approval failed: ${clip(error?.message ?? "it failed", 300)}`);
		}
		return held("agent_approval");
	}
	try {
		await runAction("send_campaign", { account, input, via: VIA });
	} catch (error) {
		// Another send, or the owner's, got there first.
		if (error?.code === "conflict") return { status: "sent", alreadySent: true };
		return held("checks", `The send was refused: ${clip(error?.message ?? "it failed", 300)}`);
	}
	return { status: "sent" };
}

export async function deliverIssue(payload) {
	const account = await loadAccount(payload.accountId);
	const campaign = await runAction("create_campaign", {
		account,
		via: VIA,
		input: {
			newsletter: String(payload.newsletterId),
			externalId: `briefing:${payload.briefingId}:${payload.slot}`,
			subject: clip(payload.subject, SUBJECT_MAX),
			previewText: clip(payload.previewText, PREVIEW_MAX),
			format: "markdown",
			content: String(payload.markdown ?? ""),
		},
	});
	const { item } = await runAction("create_content_item", {
		account,
		via: VIA,
		input: {
			newsletter: String(payload.newsletterId),
			channel: "newsletter",
			externalId: clip(`briefing:${payload.briefingId}:${payload.slot}`, LIMITS.externalId),
			title: clip(payload.subject, LIMITS.title) || "Briefing",
			body: issueBody(payload.stories),
			references: issueReferences(payload.stories),
			campaign: campaign.id,
		},
	});
	// An item made by an earlier, cut-off delivery may not have its issue yet.
	if (item.campaign?.id !== campaign.id) await runAction("link_content_campaign", { account, via: VIA, input: { id: item.id, campaign: campaign.id } });
	if (Array.isArray(payload.translations) && payload.translations.length > 0) {
		const draft = await Campaign.findOne(scoped(account, { _id: campaign.id })).select({ newsletterId: 1, subject: 1, markdown: 1 }).lean();
		if (draft) await storeBriefingTranslations({ account, campaign: draft, translations: payload.translations });
	}
	const { to: testEmail, redirected } = await findTestAddress(account, payload.testEmail);
	const testResult = await sendTest(account, campaign.id, testEmail);
	const outcome = await settleSend({ account, campaign, payload });
	// The checks are still being read: no word to the owner yet, the engine asks again with the same payload.
	if (outcome.status === "checking") return { campaignId: campaign.id, status: "checking" };
	const sent = outcome.status === "sent";
	if (sent && !outcome.alreadySent) await BriefingRun.updateOne(scoped(account, { _id: payload.runId }), { $set: { autoSentAt: new Date() } });
	const isRun = /^[a-f0-9]{24}$/i.test(String(payload.runId));
	const links = isRun ? verdictLinks({ accountId: account._id, runId: payload.runId, stories: payload.stories }) : [];
	const pause = sent && isRun ? getPauseLinkUrl(getAppUrl(), createPauseToken({ accountId: account._id, briefingId: payload.briefingId, runId: payload.runId })) : null;
	const heldReason = outcome.heldReason ?? null;
	await sendAlert({
		accountId: account._id,
		key: `briefing-run-${payload.runId}`,
		title: sent ? "A briefing issue was sent" : heldReason === "agent_approval" ? "A briefing issue is waiting for your approval" : "A briefing draft is ready to review",
		detail: `"${clip(payload.subject, SUBJECT_MAX)}"\n${describeRun({ checks: payload.checks, costUsd: payload.costUsd, testEmail, testResult, thin: payload.thin, heldReason, holdDetail: outcome.holdDetail ?? [], sent, discoveryNotes: payload.discoveryNotes ?? [], redirected, sections: payload.sections ?? [] })}`,
		emailOnly: [describePause(pause), describeLinks(links)].filter(Boolean).join("\n\n"),
		path: heldReason === "agent_approval" ? "/approvals" : `/campaigns/${campaign.id}`,
		cooldownMinutes: RUN_NOTE_COOLDOWN_MINUTES,
	});
	return { campaignId: campaign.id, status: sent ? "sent" : "drafted", ...(heldReason && { heldReason }) };
}

// A one-line word to the owner about a run that made no draft (no news, the budget, a failure). It goes to the account owner's
// address, like every account alert; `to` is accepted for the engine's contract and not used.
export async function notifyOwner({ accountId, briefingId, subject, text }) {
	await sendAlert({
		accountId,
		key: `briefing-${briefingId}-${clip(subject, 60).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
		title: clip(subject, SUBJECT_MAX) || "A briefing needs a look",
		detail: clip(text, 2000),
		path: /^[a-f0-9]{24}$/i.test(String(briefingId)) ? `/briefings/${briefingId}` : "",
	});
	return { notified: true };
}
