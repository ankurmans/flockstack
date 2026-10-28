import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { as, startTestApp } from "./helpers/app.mjs";
import { addDraft, agentOwner, api, callTool, loadAgentModules } from "./helpers/agents.mjs";
import { published } from "./stubs/qstash.mjs";

// The Briefing issue pattern of apply_editorial_pattern (docs/CONTENT-CALENDAR.md, Patterns): the sectioned skeleton a briefing writes,
// for an issue written by hand or by an agent, through REST, MCP and the dashboard's pattern form, and never a send.
let app;
let m;
let n = 0;

before(async () => {
	app = await startTestApp();
	m = {
		...(await loadAgentModules()),
		dashboard: await import("../app/(app)/campaigns/calendar/actions.js"),
		pattern: await import("../lib/briefing-issue-pattern.js"),
		rules: await import("../lib/briefing-rules.js"),
		icons: await import("../lib/section-icons.js"),
		ContentItem: (await import("../models/ContentItem.js")).default,
		ContentRevision: (await import("../models/ContentRevision.js")).default,
	};
});

after(() => app?.stop());

const customer = () => agentOwner(m, `issue-pattern${++n}@example.com`);

async function ok(promise, status = 200) {
	const response = await promise;
	assert.equal(response.status, status, JSON.stringify(response.body));
	return response.body;
}

const PATTERN = { issue: "briefing", cadence: { weekdays: [1, 2, 3, 4, 5], time: "06:00", timeZone: "Europe/Paris" } };

describe("the skeleton", () => {
	test("nine generic sections, each id an icon key and each title one the icons know, in the shape a briefing's sections take", () => {
		const { BRIEFING_ISSUE_SECTIONS, getBriefingIssueMarkdown } = m.pattern;
		assert.deepEqual(
			BRIEFING_ISSUE_SECTIONS.map(({ title }) => title),
			["Lead", "Market pulse", "Earnings and filings", "Headline roundup", "Deal flow", "Regulation and rates", "People moves", "Product and tech launches", "Coming up"]
		);
		assert.deepEqual(BRIEFING_ISSUE_SECTIONS.map(({ id }) => id), m.rules.SECTION_ICON_KEYS.filter((key) => key !== "generic"));
		for (const section of BRIEFING_ISSUE_SECTIONS) {
			assert.equal(m.icons.iconKeyForSection({ title: section.title }), section.id, `${section.title} draws its own icon`);
			assert.ok(m.rules.SECTION_FORMATS.includes(section.format));
			assert.ok(section.maxItems >= 1 && section.maxItems <= m.rules.MAX_SECTION_ITEMS);
			assert.ok(section.title.length <= m.rules.MAX_SECTION_TITLE_LENGTH && section.purpose.length <= m.rules.MAX_SECTION_PURPOSE_LENGTH);
		}
		assert.equal(BRIEFING_ISSUE_SECTIONS[0].format, "sentences", "the lead is a sentence or two");
		assert.ok(BRIEFING_ISSUE_SECTIONS.slice(1).every(({ format }) => format === "one-liners"), "the rest are dense one-liners");

		const markdown = getBriefingIssueMarkdown();
		assert.deepEqual([...markdown.matchAll(/^## (.+)$/gm)].map(([, title]) => title), BRIEFING_ISSUE_SECTIONS.map(({ title }) => title));
		const items = markdown.split("\n").filter((line) => line.startsWith("- "));
		assert.equal(items.length, 8, "a sample line under every one-liner section");
		assert.ok(items.every((line) => /^- \*\*[^*]+\*\*/.test(line) && /\(\[Source\]\(https:\/\/[^)]+\)\)$/.test(line)), "the entity in bold, a source on every item");
		assert.match(markdown, /Delete a section with nothing in it, heading included/);
		assert.doesNotMatch(markdown + JSON.stringify(BRIEFING_ISSUE_SECTIONS), /insur|underwrit|premium|carrier|broker/i, "nothing in the pattern is about one topic");
		assert.ok(markdown.length < 10_000, "it fits an item's body");
	});

	test("some sections, in the order named", () => {
		const skeleton = m.pattern.getIssueSkeleton({ issue: "briefing", sections: ["deal-flow", "lead", "deal-flow"] });
		assert.deepEqual(skeleton.sections.map(({ id }) => id), ["deal-flow", "lead"]);
		assert.deepEqual([...skeleton.markdown.matchAll(/^## (.+)$/gm)].map(([, title]) => title), ["Deal flow", "Lead"]);
		assert.equal(m.pattern.getIssueSkeleton({ stages: ["TOFU"] }), null, "a pattern of stages has no skeleton");
	});
});

describe("apply_editorial_pattern with a Briefing issue", () => {
	test("places issues on the briefing's days, gives the empty ones the skeleton with a revision, leaves the others and sends nothing", async () => {
		const user = await customer();
		const key = user.keys.drafts;
		const batch = (await ok(api(key, "POST", "/editorial-batches", { name: "Briefings", pattern: PATTERN }), 201)).batch;
		assert.deepEqual(batch.pattern, { stages: [], cadence: { weekdays: [1, 2, 3, 4, 5], everyDays: null, perDay: 1, time: "06:00", timeZone: "Europe/Paris" }, issue: "briefing" });

		const item = async (fields) => (await ok(api(key, "POST", "/content-items", { batch: batch.id, ...fields }), 201)).item;
		const empty = [await item({ channel: "newsletter", title: "Monday briefing", funnelStage: "MOFU" }), await item({ channel: "newsletter", title: "Tuesday briefing" })];
		const written = await item({ channel: "newsletter", title: "Wednesday briefing", body: "My own words." });
		const campaign = await addDraft(m, key, { subject: "Thursday briefing" });
		const linked = await item({ channel: "newsletter", campaign });
		const post = await item({ channel: "linkedin", title: "A post" });
		const queued = published.length;
		const campaignBefore = await m.Campaign.findOne({ accountId: user.accountId, _id: campaign }).lean();

		const preview = await ok(api(key, "POST", `/editorial-batches/${batch.id}/pattern`, { startDate: "2026-11-02", dryRun: true }));
		assert.equal(preview.dryRun, true);
		assert.deepEqual(preview.assignments.map(({ date, time }) => `${date} ${time}`), ["2026-11-02 06:00", "2026-11-03 06:00", "2026-11-04 06:00", "2026-11-05 06:00", "2026-11-06 06:00"]);
		assert.ok(preview.assignments.every(({ patternStage }) => patternStage === null), "a pattern without stages wants none");
		assert.deepEqual(preview.mismatches, [], "an item's own stage is no mismatch");
		assert.deepEqual(preview.skeletonFor, empty.map(({ id }) => id));
		assert.equal(preview.issue.pattern, "briefing");
		assert.deepEqual(preview.issue.sections, m.pattern.BRIEFING_ISSUE_SECTIONS.map((section) => ({ priority: null, ...section })));
		assert.equal(preview.issue.markdown, m.pattern.getBriefingIssueMarkdown());
		assert.equal((await m.ContentItem.findOne({ accountId: user.accountId, _id: empty[0].id }).lean()).body, "", "a dry run writes nothing");

		const viaMcp = (await callTool(m, key, "apply_editorial_pattern", { id: batch.id, startDate: "2026-11-02", dryRun: true })).structuredContent;
		assert.deepEqual(viaMcp, preview, "MCP answers what REST does");

		const applied = await ok(api(key, "POST", `/editorial-batches/${batch.id}/pattern`, { startDate: "2026-11-02" }));
		assert.equal(applied.applied, 5);
		assert.deepEqual(applied.skeletonFor, empty.map(({ id }) => id));
		for (const { id } of empty) {
			const row = await m.ContentItem.findOne({ accountId: user.accountId, _id: id }).lean();
			assert.equal(row.body, applied.issue.markdown);
			assert.equal(row.contentVersion, 2);
			assert.deepEqual((await m.ContentRevision.findOne({ accountId: user.accountId, itemId: id }).sort({ createdAt: -1, _id: -1 }).lean()).changedFields, ["body"]);
		}
		assert.equal((await m.ContentItem.findOne({ accountId: user.accountId, _id: written.id }).lean()).body, "My own words.");
		assert.equal((await m.ContentItem.findOne({ accountId: user.accountId, _id: linked.id }).lean()).body, "", "a linked issue's words are its campaign's");
		assert.equal((await m.ContentItem.findOne({ accountId: user.accountId, _id: post.id }).lean()).body, "", "a post is not an issue");
		const campaignAfter = await m.Campaign.findOne({ accountId: user.accountId, _id: campaign }).lean();
		assert.equal(campaignAfter.status, "draft");
		assert.equal(String(campaignAfter.updatedAt), String(campaignBefore.updatedAt), "the campaign wasn't written to");
		assert.equal(published.length, queued, "nothing was queued to send");

		const again = await ok(api(key, "POST", `/editorial-batches/${batch.id}/pattern`, { startDate: "2026-11-09", includePlanned: true }));
		assert.deepEqual(again.skeletonFor, [], "an item that has the skeleton keeps what it has");
	});

	test("its sections go into a briefing as they are", async () => {
		const user = await customer();
		const batch = (await ok(api(user.keys.full, "POST", "/editorial-batches", { name: "Short", pattern: { ...PATTERN, sections: ["lead", "deal-flow", "people"] } }), 201)).batch;
		assert.deepEqual(batch.pattern.sections, ["lead", "deal-flow", "people"]);
		const { issue } = await ok(api(user.keys.full, "POST", `/editorial-batches/${batch.id}/pattern`, { startDate: "2026-11-02", dryRun: true }));
		const briefing = await ok(api(user.keys.full, "POST", "/briefings", { name: "Morning", sections: issue.sections }), 201);
		assert.deepEqual(
			briefing.sections.map(({ id, title, format, maxItems, priority }) => ({ id, title, format, maxItems, priority })),
			issue.sections.map(({ id, title, format, maxItems, priority }) => ({ id, title, format, maxItems, priority }))
		);
	});

	test("stages with an issue still place by stage, and a pattern needs one or the other", async () => {
		const user = await customer();
		const key = user.keys.full;
		const batch = (await ok(api(key, "POST", "/editorial-batches", { name: "Both", pattern: { ...PATTERN, stages: ["TOFU", "BOFU"] } }), 201)).batch;
		await ok(api(key, "POST", "/content-items", { batch: batch.id, channel: "newsletter", title: "One", funnelStage: "BOFU" }), 201);
		const result = await ok(api(key, "POST", `/editorial-batches/${batch.id}/pattern`, { startDate: "2026-11-02", dryRun: true }));
		assert.deepEqual(result.assignments.map(({ patternStage }) => patternStage), ["TOFU"]);
		assert.equal(result.mismatches.length, 1);
		assert.equal(result.skeletonFor.length, 1);

		for (const pattern of [{}, { cadence: { everyDays: 1 } }, { stages: ["TOFU"], sections: ["lead"] }, { issue: "briefing", sections: ["sports"] }, { issue: "newsletter" }]) {
			assert.equal((await api(key, "POST", "/editorial-batches", { name: "Bad", pattern })).status, 400, JSON.stringify(pattern));
			assert.equal((await api(key, "POST", `/editorial-batches/${batch.id}/pattern`, { startDate: "2026-11-02", pattern })).status, 400, JSON.stringify(pattern));
		}
		assert.equal((await ok(api(key, "PATCH", `/editorial-batches/${batch.id}`, { pattern: null }))).batch.pattern, null);
	});

	test("the dashboard's pattern form saves, previews and applies it", async () => {
		const user = await customer();
		const batch = (await ok(api(user.keys.full, "POST", "/editorial-batches", { name: "From the form" }), 201)).batch;
		await ok(api(user.keys.full, "POST", "/content-items", { batch: batch.id, channel: "newsletter", title: "By hand" }), 201);
		const values = { stages: [], issue: "briefing", weekdays: [1, 3, 5], time: "07:00", timeZone: "UTC", startDate: "2026-11-02" };
		assert.deepEqual(await as(user, () => m.dashboard.saveBatchPattern(batch.id, values)), { ok: true });
		const saved = (await ok(api(user.keys.full, "GET", `/editorial-batches/${batch.id}`))).pattern;
		assert.equal(saved.issue, "briefing");
		const preview = await as(user, () => m.dashboard.applyBatchPattern(batch.id, { ...values, dryRun: true }));
		assert.equal(preview.result.issue.sections.length, 9);
		assert.equal(preview.result.skeletonFor.length, 1);
		const applied = await as(user, () => m.dashboard.applyBatchPattern(batch.id, values));
		assert.equal(applied.result.applied, 1);
		assert.match((await m.ContentItem.findOne({ accountId: user.accountId, batchId: batch.id }).lean()).body, /^_Every item names its source/);
	});
});
