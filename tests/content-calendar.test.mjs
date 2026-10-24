import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { as, startTestApp } from "./helpers/app.mjs";
import { addDraft, agentOwner, api, callTool, loadAgentModules, mcp } from "./helpers/agents.mjs";
import { published } from "./stubs/qstash.mjs";

// The content calendar: items, batches, visuals, plan, review and revisions through the REST API, MCP and the dashboard's
// forms, and the promise under all of it: a plan never sends, schedules or publishes anything.
let app;
let m;
let n = 0;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString("base64");
const PDF = Buffer.from("%PDF-1.4\n%test\n").toString("base64");

before(async () => {
	app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		...(await loadAgentModules()),
		dashboard: await import("../app/(app)/campaigns/calendar/actions.js"),
		rules: await import("../lib/content-rules.js"),
		zones: await import("../lib/time-zone.js"),
		ContentItem: (await import("../models/ContentItem.js")).default,
		ContentRevision: (await import("../models/ContentRevision.js")).default,
		EditorialBatch: (await import("../models/EditorialBatch.js")).default,
		Message: (await import("../models/Message.js")).default,
		Upload: (await import("../models/Upload.js")).default,
		rest: await import("../lib/api/rest.js"),
	};
});

after(() => app?.stop());

const customer = () => agentOwner(m, `content${++n}@example.com`);

async function ok(promise, status = 200) {
	const response = await promise;
	assert.equal(response.status, status, JSON.stringify(response.body));
	return response.body;
}

async function upload(key, kind = "image", fileName = `visual-${++n}.${kind === "pdf" ? "pdf" : "png"}`) {
	const body = kind === "pdf" ? { base64: PDF, fileName } : { base64: PNG, fileName };
	return (await ok(api(key, "POST", kind === "pdf" ? "/files" : "/images", body), 201)).id;
}

// A complete LinkedIn post: copy, hook, call to action and a picture with alt text.
async function post(user, fields = {}, key = user.keys.full) {
	const media = await upload(key);
	return (
		await ok(
			api(key, "POST", "/content-items", {
				channel: "linkedin",
				title: "Why replies beat opens",
				funnelStage: "TOFU",
				pillar: "Deliverability",
				hook: "Open rates lie.",
				body: "Most newsletters count opens. Replies tell you who reads.",
				cta: "Read the issue",
				destinationUrl: "https://example.com/issue",
				assets: [{ media, altText: "A chart of replies against opens" }],
				...fields,
			}),
			201
		)
	).item;
}

const get = async (user, id) => ok(api(user.keys.full, "GET", `/content-items/${id}`));
const approve = (user, id) => as(user, () => m.dashboard.decideContentReview(id, "approve", ""));
const plan = (user, query = "") => ok(api(user.keys.full, "GET", `/content-plan?from=2026-11-01&to=2026-11-30${query}`));

const own = (user, filter = {}) => ({ accountId: user.accountId, ...filter });
const campaignRow = (user, id) => m.Campaign.findOne(own(user, { _id: id })).lean();
const itemRow = (user, id) => m.ContentItem.findOne(own(user, { _id: id })).lean();
const setCampaign = (user, id, fields) => m.Campaign.updateOne(own(user, { _id: id }), { $set: fields });

async function untouched(user, campaignId, before) {
	const campaign = await campaignRow(user, campaignId);
	assert.equal(campaign.status, before.status, "the campaign's status didn't change");
	assert.equal(String(campaign.scheduledAt ?? ""), String(before.scheduledAt ?? ""), "nothing was scheduled");
	assert.equal(String(campaign.updatedAt), String(before.updatedAt), "the campaign wasn't written to");
}

describe("the first acceptance scenario, as an MCP agent runs it", () => {
	test("a batch, six linked drafts, five LinkedIn posts in pattern order, visuals, dates, one review link, and nothing published or scheduled", async () => {
		const user = await customer();
		const key = user.keys.drafts;
		const drafts = [];
		for (let index = 0; index < 6; index++) drafts.push(await addDraft(m, key, { subject: `Issue ${index + 1}` }));
		const queued = published.length;
		const before = await m.Campaign.find(own(user, { _id: { $in: drafts } })).lean();

		const created = (await callTool(m, key, "create_editorial_batch", { name: "November", externalId: "nov-2026", pattern: { stages: ["TOFU", "MOFU", "BOFU", "TOFU", "TOFU"], cadence: { weekdays: [1, 3, 5], time: "09:00", timeZone: "Europe/Paris" } } })).structuredContent;
		assert.equal(created.created, true);
		const batch = created.batch;
		assert.match(batch.reviewUrl, /\/campaigns\/calendar\/batches\//);

		const linked = [];
		for (const campaign of drafts) {
			linked.push((await callTool(m, key, "create_content_item", { channel: "newsletter", campaign, batch: "nov-2026" })).structuredContent);
		}
		assert.ok(linked.every((result) => result.created && result.item.campaign.status === "draft" && result.item.batchId === batch.id));
		assert.equal(await m.Campaign.countDocuments(own(user)), 6, "no campaign was duplicated");

		const stages = ["TOFU", "MOFU", "BOFU", "TOFU", "TOFU"];
		const posts = [];
		for (const [index, funnelStage] of stages.entries()) {
			const media = (await callTool(m, key, "upload_image", { base64: PNG, fileName: `post-${index}.png` })).structuredContent.id;
			const result = (
				await callTool(m, key, "create_content_item", {
					channel: "linkedin",
					title: `Post ${index + 1}`,
					funnelStage,
					pillar: "Deliverability",
					obstacle: "Readers ignore the email",
					takeaway: "Replies beat opens",
					hook: `Hook ${index + 1}`,
					body: `Copy of post ${index + 1}.`,
					cta: "Read the issue",
					destinationUrl: "https://example.com/issue",
					batch: batch.id,
					externalId: `nov-post-${index + 1}`,
					assets: [{ media, altText: `Visual ${index + 1}` }],
				})
			).structuredContent;
			assert.equal(result.created, true);
			posts.push(result.item);
		}
		assert.deepEqual(posts.map((one) => one.funnelStage), stages);

		const applied = (await callTool(m, key, "apply_editorial_pattern", { id: batch.id, startDate: "2026-11-02", itemIds: posts.map((one) => one.id), matchStages: true })).structuredContent;
		assert.equal(applied.applied, 5);
		assert.deepEqual(applied.mismatches, []);
		assert.deepEqual(applied.assignments.map((one) => one.date), ["2026-11-02", "2026-11-04", "2026-11-06", "2026-11-09", "2026-11-11"]);

		const review = (await callTool(m, key, "request_batch_review", { id: batch.id })).structuredContent;
		assert.equal(review.requested.length, 11, "six issues and five posts");
		assert.deepEqual(review.blocked, []);
		assert.match(review.reviewUrl, new RegExp(`/campaigns/calendar/batches/${batch.id}$`));

		const read = (await callTool(m, key, "get_editorial_batch", { id: batch.id })).structuredContent;
		assert.equal(read.itemCount, 11);
		assert.deepEqual(read.counts, { ready_for_review: 11 });
		assert.ok(read.items.every((item) => item.delivery.status === "draft" || item.delivery.status === "not_posted"), "everything is unpublished and unscheduled");
		assert.ok(read.items.filter((item) => item.channel === "linkedin").every((item) => item.delivery.mode === "manual"));

		for (const row of before) await untouched(user, row._id, row);
		assert.equal(published.length, queued, "no job was queued");
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId }), 0, "no email was made");
		assert.ok(
			(await m.ContentItem.find(own(user, { channel: "linkedin" })).lean()).every((item) => item.state === "ready_for_review" && !item.publicationUrl),
			"every post is unpublished"
		);
		assert.equal((await mcp(m, key, "tools/list")).body.result.tools.some((tool) => tool.name === "decide_content_review"), false, "an agent can't approve");
	});
});

describe("account isolation and key permissions", () => {
	test("another account's items, batches, plan and media are not found", async () => {
		const owner = await customer();
		const stranger = await customer();
		const item = await post(owner);
		const batch = (await ok(api(owner.keys.full, "POST", "/editorial-batches", { name: "Mine" }), 201)).batch;
		const theirMedia = await upload(stranger.keys.full);

		for (const [method, path, body] of [
			["GET", `/content-items/${item.id}`],
			["PATCH", `/content-items/${item.id}`, { title: "Theirs now" }],
			["DELETE", `/content-items/${item.id}`],
			["POST", `/content-items/${item.id}/slot`, { date: "2026-11-03" }],
			["POST", `/content-items/${item.id}/review`],
			["GET", `/content-items/${item.id}/revisions`],
			["GET", `/editorial-batches/${batch.id}`],
			["POST", `/editorial-batches/${batch.id}/review`],
			["DELETE", `/editorial-batches/${batch.id}`],
		]) {
			const answer = await api(stranger.keys.full, method, path, body);
			assert.equal(answer.status, 404, `${method} ${path}: ${JSON.stringify(answer.body)}`);
		}
		assert.deepEqual((await ok(api(stranger.keys.full, "GET", "/content-items"))).items, []);
		assert.deepEqual((await ok(api(stranger.keys.full, "GET", "/content-plan?from=2026-11-01&to=2026-11-30&includeBacklog=true"))).backlog, []);
		assert.equal((await itemRow(owner, item.id)).title, "Why replies beat opens");
		assert.equal((await api(owner.keys.full, "POST", `/content-items/${item.id}/assets`, { media: theirMedia })).status, 404, "media of another account");
		assert.equal((await api(owner.keys.full, "POST", `/content-items/${item.id}/campaign`, { campaign: await addDraft(m, stranger.keys.full) })).status, 404, "a campaign of another account");
	});

	test("read only reads the plan, drafts plans and asks for reviews, nothing here sends, and only the dashboard approves", async () => {
		const user = await customer();
		const item = await post(user);
		const read = user.keys.read_only;
		assert.equal((await api(read, "GET", `/content-items/${item.id}`)).status, 200);
		assert.equal((await api(read, "GET", "/content-plan?from=2026-11-01&to=2026-11-30")).status, 200);
		assert.equal((await api(read, "GET", "/editorial-batches")).status, 200);
		for (const [method, path, body] of [
			["POST", "/content-items", { channel: "linkedin", title: "No" }],
			["PATCH", `/content-items/${item.id}`, { title: "No" }],
			["POST", `/content-items/${item.id}/slot`, { date: "2026-11-03" }],
			["POST", "/editorial-batches", { name: "No" }],
		]) {
			const refused = await api(read, method, path, body);
			assert.equal(refused.status, 403, `${method} ${path}`);
		}

		const drafts = user.keys.drafts;
		assert.equal((await api(drafts, "POST", `/content-items/${item.id}/slot`, { date: "2026-11-03" })).status, 200);
		assert.equal((await api(drafts, "PATCH", `/content-items/${item.id}`, { notes: "Check the chart" })).status, 200);
		assert.equal((await api(drafts, "POST", `/content-items/${item.id}/review`)).status, 200);
		assert.equal((await api(drafts, "DELETE", `/content-items/${item.id}`)).status, 403, "deleting is not drafting");
		assert.equal((await api(drafts, "DELETE", `/editorial-batches/${item.id}`)).status, 403);
		const draft = await addDraft(m, drafts);
		assert.equal((await api(drafts, "POST", `/campaigns/${draft}/send`, {})).status, 403, "planning didn't grant sending");
		assert.equal((await api(drafts, "POST", `/campaigns/${draft}/schedule`, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })).status, 403);

		for (const key of Object.values(user.keys)) {
			const answer = await api(key, "POST", `/content-items/${item.id}/decision`, { decision: "approve" });
			assert.equal(answer.status, 404, "there is no route to approve");
			const called = await mcp(m, key, "tools/call", { name: "decide_content_review", arguments: { id: item.id, decision: "approve" } });
			assert.ok(called.body.error || called.body.result?.isError, "there is no tool to approve");
		}
		assert.equal((await itemRow(user, item.id)).state, "ready_for_review");
		const scopes = await import("../lib/action-scopes.js");
		for (const name of ["create_content_item", "update_content_item", "set_content_slot", "apply_editorial_pattern", "request_batch_review", "attach_content_asset"]) {
			assert.equal(scopes.ACTION_CLASSES[name], "write-draft", name);
			assert.equal(scopes.PRESET_RULES.drafts.allow.includes(scopes.ACTION_CLASSES[name]), true);
		}
		assert.equal(scopes.PRESET_RULES.drafts.allow.includes("send"), false);
	});

	test("a send with approval key's deletes wait for the owner, and a key limited to one newsletter reaches only that one", async () => {
		const user = await customer();
		const first = await post(user);
		const other = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "linkedin", title: "On the second", newsletter: user.otherSlug }), 201)).item;
		assert.notEqual(first.newsletterId, other.newsletterId);

		const waiting = await api(user.keys.send_with_approval, "DELETE", `/content-items/${first.id}`);
		assert.equal(waiting.status, 202, JSON.stringify(waiting.body));
		assert.equal(waiting.body.status, "approval_required");
		assert.ok(await itemRow(user, first.id), "still there");

		const limited = (await as(user, () => m.apiKeys.createApiKey(null, (formData(user, { name: "One newsletter", level: "drafts", newsletter: user.newsletterId }))))).key;
		assert.equal((await api(limited, "GET", `/content-items/${first.id}`)).status, 200);
		assert.equal((await api(limited, "GET", `/content-items/${other.id}`)).status, 403);
		assert.equal((await api(limited, "PATCH", `/content-items/${other.id}`, { title: "Nope" })).status, 403);
		assert.deepEqual((await ok(api(limited, "GET", "/content-items"))).items.map((item) => item.id), [first.id], "a list stays inside its newsletter");
		const created = await ok(api(limited, "POST", "/content-items", { channel: "linkedin", title: "Defaults to mine" }), 201);
		assert.equal(created.item.newsletterId, first.newsletterId);
		assert.equal((await api(limited, "POST", "/content-items", { channel: "linkedin", title: "Theirs", newsletter: user.otherSlug })).status, 403);
		assert.equal((await api(limited, "POST", "/content-items/reorder", { scope: "batch", ids: [other.id] })).status, 403);
	});
});

function formData(user, fields) {
	const data = new FormData();
	for (const [key, value] of Object.entries(fields)) data.set(key, value);
	return data;
}

describe("drafts on planned dates", () => {
	test("a draft shows on its planned day as planned, and stays a draft that nothing schedules or sends", async () => {
		const user = await customer();
		const draft = await addDraft(m, user.keys.full, { subject: "Planned for the 12th" });
		const before = await campaignRow(user, draft);
		const queued = published.length;
		const item = (await ok(api(user.keys.drafts, "POST", "/content-items", { channel: "newsletter", campaign: draft, plannedDate: "2026-11-12", plannedTime: "08:30", timeZone: "Europe/Paris" }), 201)).item;
		assert.equal(item.title, "Planned for the 12th", "no title of its own: the issue's subject");

		const view = await plan(user);
		const entry = view.entries.find((one) => one.itemId === item.id);
		assert.equal(entry.kind, "planned");
		assert.equal(entry.date, "2026-11-12");
		assert.equal(entry.deliveryStatus, "draft");
		assert.equal(view.entries.filter((one) => one.kind !== "planned").length, 0, "no delivery");
		await untouched(user, draft, before);

		const calendar = await ok(api(user.keys.full, "GET", "/calendar?month=2026-11"));
		assert.deepEqual(calendar.issues, [], "get_content_calendar still leaves drafts out");
		assert.equal(published.length, queued);
	});

	test("the same issue shows as scheduled at its real time once it is, and as sent after, apart from its planned day", async () => {
		const user = await customer();
		const draft = await addDraft(m, user.keys.full, { subject: "Goes out later" });
		const item = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", campaign: draft, plannedDate: "2026-11-05" }), 201)).item;
		assert.equal((await plan(user)).entries.find((one) => one.itemId === item.id).kind, "planned");

		await setCampaign(user, draft, { status: "scheduled", scheduledAt: new Date("2026-11-12T09:00:00Z") });
		const scheduled = (await plan(user)).entries.filter((one) => one.itemId === item.id);
		assert.equal(scheduled.length, 1, "one entry, not a plan and a delivery");
		assert.equal(scheduled[0].kind, "scheduled");
		assert.equal(scheduled[0].date, "2026-11-12");
		assert.equal(scheduled[0].plannedDate, "2026-11-05");
		assert.equal(scheduled[0].time, "09:00");
		assert.equal((await get(user, item.id)).delivery.status, "scheduled");

		await setCampaign(user, draft, { status: "sent", sentAt: new Date("2026-11-12T09:02:00Z") });
		assert.equal((await plan(user)).entries.find((one) => one.itemId === item.id).kind, "sent");
		const paris = await ok(api(user.keys.full, "GET", "/content-plan?from=2026-11-01&to=2026-11-30&timeZone=Asia/Tokyo"));
		assert.equal(paris.entries.find((one) => one.itemId === item.id).time, "18:02", "placed in the timezone asked");
		const unlinked = await addDraft(m, user.keys.full, { subject: "Not in the plan" });
		await setCampaign(user, unlinked, { status: "scheduled", scheduledAt: new Date("2026-11-20T09:00:00Z") });
		const both = await plan(user);
		assert.equal(both.entries.find((one) => one.campaignId === unlinked).itemId, null, "a campaign no item links still shows");
		assert.equal(both.counts.delivery, 2);
		assert.equal((await plan(user, "&includeDeliveries=false")).entries.length, 1);
		assert.equal((await plan(user, "&channel=linkedin")).entries.length, 0, "deliveries are newsletter things");
		assert.equal((await plan(user, "&state=approved")).entries.some((one) => one.campaignId === unlinked), false, "an item filter leaves out a campaign with no item");
	});

	test("the backlog is the items with no day, and filters narrow the plan", async () => {
		const user = await customer();
		const a = await post(user, { title: "A", funnelStage: "TOFU", pillar: "Growth", plannedDate: "2026-11-03" });
		const b = await post(user, { title: "B", funnelStage: "BOFU", pillar: "Sales" });
		const c = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", title: "C", plannedDate: "2026-11-03" }), 201)).item;
		const view = await plan(user, "&includeBacklog=true");
		assert.deepEqual(view.backlog.map((one) => one.id), [b.id]);
		assert.deepEqual(view.entries.map((one) => one.itemId).toSorted(), [a.id, c.id].toSorted());
		assert.deepEqual((await plan(user, "&channel=newsletter")).entries.map((one) => one.itemId), [c.id]);
		assert.deepEqual((await plan(user, "&funnelStage=TOFU")).entries.map((one) => one.itemId), [a.id]);
		assert.deepEqual((await plan(user, "&pillar=Growth")).entries.map((one) => one.itemId), [a.id]);
		assert.deepEqual((await plan(user, "&state=idea")).entries.map((one) => one.itemId), [c.id]);
		const batch = (await ok(api(user.keys.full, "POST", "/editorial-batches", { name: "Group", externalId: "group" }), 201)).batch;
		await ok(api(user.keys.full, "PATCH", `/content-items/${a.id}`, { batch: "group" }));
		assert.deepEqual((await plan(user, `&batch=${batch.id}`)).entries.map((one) => one.itemId), [a.id]);
		assert.deepEqual((await ok(api(user.keys.full, "GET", "/content-items?dated=false"))).items.map((one) => one.id), [b.id]);
		assert.deepEqual((await ok(api(user.keys.full, "GET", "/content-items?from=2026-11-01&to=2026-11-02"))).items, []);
		await rangeErrors(user);
	});
});

async function rangeErrors(user) {
	assert.equal((await api(user.keys.full, "GET", "/content-plan?from=2026-11-30&to=2026-11-01")).status, 400);
	assert.equal((await api(user.keys.full, "GET", "/content-plan?from=2026-01-01&to=2026-12-31")).status, 400, "up to 100 days");
	assert.equal((await api(user.keys.full, "GET", "/content-plan?from=2026-02-30&to=2026-03-01")).status, 400, "a day that doesn't exist");
}

describe("moving never delivers", () => {
	test("setting, moving and clearing a day, reordering, applying a pattern and asking for a review leave a linked draft and the queue as they were", async () => {
		const user = await customer();
		const draft = await addDraft(m, user.keys.full, { subject: "Stays a draft" });
		const before = await campaignRow(user, draft);
		const queued = published.length;
		const issue = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", campaign: draft }), 201)).item;
		const second = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", title: "Second", plannedDate: "2026-11-04" }), 201)).item;
		const batch = (await ok(api(user.keys.full, "POST", "/editorial-batches", { name: "Moves", pattern: { stages: ["TOFU"], cadence: { everyDays: 2 } } }), 201)).batch;
		await ok(api(user.keys.full, "PATCH", `/content-items/${issue.id}`, { batch: batch.id }));

		await ok(api(user.keys.full, "POST", `/content-items/${issue.id}/slot`, { date: "2026-11-04" }));
		await ok(api(user.keys.full, "POST", `/content-items/${issue.id}/slot`, { date: "2026-11-09", time: "07:00", timeZone: "Europe/Paris" }));
		await ok(api(user.keys.full, "POST", `/content-items/${issue.id}/slot`, { date: "2026-11-04", position: 1 }));
		await ok(api(user.keys.full, "POST", "/content-items/reorder", { scope: "day", ids: [second.id, issue.id] }));
		await ok(api(user.keys.full, "POST", `/editorial-batches/${batch.id}/pattern`, { startDate: "2026-11-10", includePlanned: true }));
		await ok(api(user.keys.full, "POST", `/content-items/${issue.id}/slot`, { date: null }));
		await ok(api(user.keys.full, "POST", `/editorial-batches/${batch.id}/review`));
		await as(user, () => m.dashboard.moveContentItem(issue.id, { date: "2026-11-16" }));
		await approve(user, issue.id);

		await untouched(user, draft, before);
		assert.equal(published.length, queued, "no job was queued");
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId }), 0);
		const moved = await get(user, issue.id);
		assert.equal(moved.state, "approved");
		assert.equal(moved.delivery.status, "draft");
		assert.equal(moved.campaign.status, "draft");
		assert.ok(moved.moves.length >= 3 && moved.moves.length <= 10, "the moves are recorded");
	});

	test("a move keeps an approval and says so; an issue's own campaign is never read as moved", async () => {
		const user = await customer();
		const item = await post(user);
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/review`));
		await approve(user, item.id);
		const moved = await ok(api(user.keys.full, "POST", `/content-items/${item.id}/slot`, { date: "2026-11-20", time: "10:00" }));
		assert.equal(moved.approvalKept, true);
		assert.equal(moved.previous.plannedDate, null);
		assert.equal(moved.item.state, "approved");
		assert.equal(moved.item.review.editedAfterApproval, false);
		const again = await ok(api(user.keys.full, "POST", `/content-items/${item.id}/slot`, { date: "2026-11-21" }));
		assert.equal(again.previous.plannedDate, "2026-11-20");
		assert.equal(again.item.plannedTime, "10:00", "the time stays when none is given");
		const cleared = await ok(api(user.keys.full, "POST", `/content-items/${item.id}/slot`, { date: "2026-11-21", time: null }));
		assert.equal(cleared.item.plannedTime, null);
		assert.equal(cleared.item.plannedAt, null);
	});

	test("the day's items keep an explicit order that a position and a reorder change", async () => {
		const user = await customer();
		const ids = [];
		for (const title of ["One", "Two", "Three"]) ids.push((await ok(api(user.keys.full, "POST", "/content-items", { channel: "linkedin", title, plannedDate: "2026-11-10" }), 201)).item.id);
		const order = async () => (await plan(user)).entries.map((one) => one.title);
		assert.deepEqual(await order(), ["One", "Two", "Three"]);
		await ok(api(user.keys.full, "POST", `/content-items/${ids[2]}/slot`, { date: "2026-11-10", position: 1 }));
		assert.deepEqual(await order(), ["Three", "One", "Two"]);
		const reordered = await ok(api(user.keys.full, "POST", "/content-items/reorder", { scope: "day", ids: [ids[1]] }));
		assert.deepEqual(reordered.items.map((one) => one.title), ["Two", "Three", "One"]);
		assert.deepEqual(reordered.items.map((one) => one.slot), [1, 2, 3]);
		const other = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "linkedin", title: "Elsewhere", plannedDate: "2026-11-11" }), 201)).item;
		assert.equal((await api(user.keys.full, "POST", "/content-items/reorder", { scope: "day", ids: [ids[0], other.id] })).status, 400, "one day at a time");
		assert.equal((await api(user.keys.full, "POST", "/content-items/reorder", { scope: "batch", ids: [ids[0]] })).status, 400, "not in a batch");
	});
});

describe("timezones and daylight saving", () => {
	test("a wall-clock time becomes the right instant on a normal day, and the day a clock skips and repeats", () => {
		const { zonedTimeToInstant, toTimeKey } = m.zones;
		const at = (date, time, zone) => zonedTimeToInstant(date, time, zone).toISOString();
		assert.equal(at("2026-01-15", "09:00", "Europe/Paris"), "2026-01-15T08:00:00.000Z");
		assert.equal(at("2026-07-15", "09:00", "Europe/Paris"), "2026-07-15T07:00:00.000Z");
		assert.equal(at("2026-11-10", "09:00", "UTC"), "2026-11-10T09:00:00.000Z");
		assert.equal(at("2026-11-10", "09:00", "Asia/Kolkata"), "2026-11-10T03:30:00.000Z", "a half hour offset");
		// Paris springs forward on 2026-03-29: 02:00 becomes 03:00, so 02:30 never happens.
		assert.equal(at("2026-03-29", "02:30", "Europe/Paris"), "2026-03-29T01:30:00.000Z");
		assert.equal(toTimeKey(zonedTimeToInstant("2026-03-29", "02:30", "Europe/Paris"), "Europe/Paris"), "03:30");
		assert.equal(at("2026-03-29", "01:59", "Europe/Paris"), "2026-03-29T00:59:00.000Z");
		assert.equal(at("2026-03-29", "03:00", "Europe/Paris"), "2026-03-29T01:00:00.000Z");
		// And falls back on 2026-10-25: 02:30 is shown twice; the first is meant.
		assert.equal(at("2026-10-25", "02:30", "Europe/Paris"), "2026-10-25T00:30:00.000Z");
		assert.equal(at("2026-10-25", "03:30", "Europe/Paris"), "2026-10-25T02:30:00.000Z");
		// New York: forward on 2026-03-08, back on 2026-11-01.
		assert.equal(at("2026-03-08", "02:30", "America/New_York"), "2026-03-08T07:30:00.000Z");
		assert.equal(toTimeKey(zonedTimeToInstant("2026-03-08", "02:30", "America/New_York"), "America/New_York"), "03:30");
		assert.equal(at("2026-11-01", "01:30", "America/New_York"), "2026-11-01T05:30:00.000Z");
		// Sydney is on summer time in November.
		assert.equal(at("2026-11-10", "09:00", "Australia/Sydney"), "2026-11-09T22:00:00.000Z");
		assert.equal(at("2026-04-05", "02:30", "Australia/Sydney"), "2026-04-04T15:30:00.000Z", "the first of the two 02:30s");
	});

	test("a slot keeps its local time across a clock change, the instant moves, and a skipped time is stored as the time that exists", async () => {
		const user = await customer();
		const item = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "linkedin", title: "Zones" }), 201)).item;
		const set = async (date, time, timeZone = "Europe/Paris") => (await ok(api(user.keys.full, "POST", `/content-items/${item.id}/slot`, { date, time, timeZone }))).item;
		const before = await set("2026-03-27", "09:00");
		const after = await set("2026-03-30", "09:00");
		assert.equal(before.plannedTime, "09:00");
		assert.equal(after.plannedTime, "09:00");
		assert.equal(before.plannedAt, "2026-03-27T08:00:00.000Z");
		assert.equal(after.plannedAt, "2026-03-30T07:00:00.000Z");
		const skipped = await set("2026-03-29", "02:30");
		assert.equal(skipped.plannedDate, "2026-03-29");
		assert.equal(skipped.plannedTime, "03:30");
		assert.equal(skipped.plannedAt, "2026-03-29T01:30:00.000Z");
		const repeated = await set("2026-10-25", "02:30");
		assert.equal(repeated.plannedTime, "02:30");
		assert.equal(repeated.plannedAt, "2026-10-25T00:30:00.000Z");
		assert.equal((await set("2026-10-25", "09:00", "America/Los_Angeles")).plannedAt, "2026-10-25T16:00:00.000Z");
		assert.equal((await api(user.keys.full, "POST", `/content-items/${item.id}/slot`, { date: "2026-10-25", timeZone: "Mars/Olympus" })).status, 400);
		assert.equal((await api(user.keys.full, "POST", `/content-items/${item.id}/slot`, { date: "2026-02-30" })).status, 400);
		assert.equal((await api(user.keys.full, "POST", `/content-items/${item.id}/slot`, { date: "2026-10-25", time: "25:00" })).status, 400);
	});

	test("a planned item stays on its own day whatever timezone the calendar is read in; a campaign is placed in the timezone asked", async () => {
		const user = await customer();
		const item = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "linkedin", title: "Late", plannedDate: "2026-11-10", plannedTime: "23:30", timeZone: "America/Los_Angeles" }), 201)).item;
		assert.equal(item.plannedAt, "2026-11-11T07:30:00.000Z");
		for (const zone of ["UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
			const view = await ok(api(user.keys.full, "GET", `/content-plan?from=2026-11-01&to=2026-11-30&timeZone=${zone}`));
			assert.equal(view.entries[0].date, "2026-11-10", zone);
		}
	});

	test("a pattern's slots repeat the same wall-clock time across the clock change", async () => {
		const user = await customer();
		const batch = (await ok(api(user.keys.full, "POST", "/editorial-batches", { name: "Spring", pattern: { stages: ["TOFU"], cadence: { weekdays: [1, 5], time: "09:00", timeZone: "Europe/Paris" } } }), 201)).batch;
		for (let index = 0; index < 4; index++) await ok(api(user.keys.full, "POST", "/content-items", { channel: "linkedin", title: `Spring ${index}`, batch: batch.id }), 201);
		const result = await ok(api(user.keys.full, "POST", `/editorial-batches/${batch.id}/pattern`, { startDate: "2026-03-26" }));
		assert.deepEqual(result.assignments.map((one) => [one.date, one.time]), [["2026-03-27", "09:00"], ["2026-03-30", "09:00"], ["2026-04-03", "09:00"], ["2026-04-06", "09:00"]]);
		const rows = await m.ContentItem.find(own(user, { batchId: batch.id })).sort({ plannedDate: 1 }).lean();
		assert.deepEqual(rows.map((row) => row.plannedAt.toISOString()), ["2026-03-27T08:00:00.000Z", "2026-03-30T07:00:00.000Z", "2026-04-03T07:00:00.000Z", "2026-04-06T07:00:00.000Z"]);
	});
});

describe("patterns", () => {
	test("TOFU, MOFU, BOFU, TOFU, TOFU is one account's choice: it places items by the batch's pattern, reports mismatches, previews and never applies itself", async () => {
		const user = await customer();
		const other = await customer();
		const batch = (await ok(api(user.keys.full, "POST", "/editorial-batches", { name: "Pattern", pattern: { stages: ["TOFU", "MOFU", "BOFU", "TOFU", "TOFU"], cadence: { weekdays: [1, 3, 5] } } }), 201)).batch;
		assert.deepEqual(batch.pattern, { stages: ["TOFU", "MOFU", "BOFU", "TOFU", "TOFU"], cadence: { weekdays: [1, 3, 5], everyDays: null, perDay: 1, time: null, timeZone: null } });
		const noPattern = (await ok(api(other.keys.full, "POST", "/editorial-batches", { name: "Plain" }), 201)).batch;
		assert.equal(noPattern.pattern, null, "nothing is hard-coded for every account");
		assert.equal((await api(other.keys.full, "POST", `/editorial-batches/${noPattern.id}/pattern`, { startDate: "2026-11-02" })).status, 400, "no pattern, no placing");

		const stages = ["BOFU", "TOFU", "TOFU", "MOFU", "TOFU"];
		const ids = [];
		for (const [index, funnelStage] of stages.entries()) ids.push((await ok(api(user.keys.full, "POST", "/content-items", { channel: index === 3 ? "newsletter" : "linkedin", title: `Item ${index}`, funnelStage, batch: batch.id }), 201)).item.id);
		assert.equal((await m.ContentItem.countDocuments(own(user, { batchId: batch.id, plannedDate: { $exists: true } }))), 0, "creating items placed nothing");

		const preview = await ok(api(user.keys.full, "POST", `/editorial-batches/${batch.id}/pattern`, { startDate: "2026-11-02", dryRun: true }));
		assert.equal(preview.applied, 0);
		assert.equal(preview.dryRun, true);
		assert.deepEqual(preview.mismatches.map((one) => [one.has, one.wants]), [["BOFU", "TOFU"], ["TOFU", "MOFU"], ["TOFU", "BOFU"], ["MOFU", "TOFU"]]);
		assert.equal(await m.ContentItem.countDocuments(own(user, { batchId: batch.id, plannedDate: { $exists: true } })), 0, "a preview writes nothing");

		const byStage = await ok(api(user.keys.full, "POST", `/editorial-batches/${batch.id}/pattern`, { startDate: "2026-11-02", matchStages: true }));
		assert.deepEqual(byStage.assignments.map((one) => one.funnelStage), ["TOFU", "MOFU", "BOFU", "TOFU", "TOFU"]);
		assert.deepEqual(byStage.assignments.map((one) => one.date), ["2026-11-02", "2026-11-04", "2026-11-06", "2026-11-09", "2026-11-11"]);
		assert.deepEqual(byStage.mismatches, []);
		assert.equal(byStage.assignments.filter((one) => one.channel === "newsletter").length, 1, "five posts are not five newsletters: any channel takes a slot");

		const again = await ok(api(user.keys.full, "POST", `/editorial-batches/${batch.id}/pattern`, { startDate: "2026-12-01" }));
		assert.equal(again.applied, 0, "already placed items are left alone");
		const cleared = await ok(api(user.keys.full, "PATCH", `/editorial-batches/${batch.id}`, { pattern: null }));
		assert.equal(cleared.batch.pattern, null);
		assert.equal((await api(user.keys.full, "POST", `/editorial-batches/${batch.id}/pattern`, { startDate: "2026-12-01", pattern: { stages: ["TOFU"], cadence: { everyDays: 7 } }, includePlanned: true })).status, 200);
		assert.equal((await api(user.keys.full, "POST", `/editorial-batches/${batch.id}/pattern`, { startDate: "2026-12-01", pattern: { stages: ["TOFU", "XOFU"] } })).status, 400);
		assert.ok(ids.length === 5);
	});

	test("the slot helpers walk weekdays and every-N-days, with several slots a day", () => {
		const { buildSlots, assignPattern, normalizeCadence } = m.rules;
		assert.deepEqual(buildSlots(normalizeCadence({ weekdays: [1, 3], perDay: 2, time: "08:00" }), "2026-11-02", 5).map((slot) => [slot.date, slot.slot]), [["2026-11-02", 0], ["2026-11-02", 1], ["2026-11-04", 0], ["2026-11-04", 1], ["2026-11-09", 0]]);
		assert.deepEqual(buildSlots(normalizeCadence({ everyDays: 3 }), "2026-11-01", 3).map((slot) => slot.date), ["2026-11-01", "2026-11-04", "2026-11-07"]);
		assert.deepEqual(buildSlots(normalizeCadence({}), "2026-11-01", 2).map((slot) => slot.date), ["2026-11-01", "2026-11-02"]);
		const items = [{ _id: "a", funnelStage: "BOFU" }, { _id: "b", funnelStage: "TOFU" }];
		const slots = buildSlots(normalizeCadence({}), "2026-11-01", 3);
		const placed = assignPattern(items, ["TOFU", "BOFU"], slots, { matchStages: true });
		assert.deepEqual(placed.assigned.map(({ item }) => item._id), ["b", "a"]);
		assert.deepEqual(placed.mismatches, []);
	});
});

describe("linked campaigns", () => {
	test("the item reads its campaign as it is now: a new subject, a schedule and a sent status show without anything copied", async () => {
		const user = await customer();
		const draft = await addDraft(m, user.keys.full, { subject: "First subject" });
		const item = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", campaign: draft }), 201)).item;
		assert.equal(item.title, "First subject");
		await ok(api(user.keys.full, "PATCH", `/campaigns/${draft}`, { subject: "A better subject" }));
		const renamed = await get(user, item.id);
		assert.equal(renamed.title, "A better subject");
		assert.equal(renamed.campaign.subject, "A better subject");
		assert.equal((await itemRow(user, item.id)).title, "", "nothing was copied to the item");
		await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { title: "Our own title" }));
		assert.equal((await get(user, item.id)).title, "Our own title");
		const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
		await ok(api(user.keys.full, "POST", `/campaigns/${draft}/schedule`, { scheduledAt }));
		const scheduled = await get(user, item.id);
		assert.equal(scheduled.delivery.status, "scheduled");
		assert.equal(scheduled.campaign.scheduledAt, scheduledAt);
		assert.equal(scheduled.state, "drafting", "the editorial state didn't move with the campaign");
	});

	test("an issue belongs to one newsletter item, repeated links return it, and another newsletter's campaign is refused", async () => {
		const user = await customer();
		const draft = await addDraft(m, user.keys.full);
		const first = await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", campaign: draft, externalId: "issue-1" }), 201);
		const repeat = await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", campaign: draft }));
		assert.equal(repeat.created, false);
		assert.equal(repeat.item.id, first.item.id);
		const spare = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", title: "Spare" }), 201)).item;
		const clash = await api(user.keys.full, "POST", `/content-items/${spare.id}/campaign`, { campaign: draft });
		assert.equal(clash.status, 409);
		assert.equal((await api(user.keys.full, "POST", "/content-items", { channel: "newsletter", campaign: draft, externalId: "other-key" })).body.item.id, first.item.id, "the linked issue wins over a new key");

		const post = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "linkedin", title: "Derived", campaign: draft }), 201)).item;
		assert.equal(post.campaign.id, draft, "a post can be derived from an issue that has an item");

		const secondNewsletter = await ok(api(user.keys.full, "POST", "/campaigns", { newsletter: user.otherSlug, subject: "Elsewhere", content: "x" }), 201);
		const crossed = await api(user.keys.full, "POST", `/content-items/${spare.id}/campaign`, { campaign: secondNewsletter.id });
		assert.equal(crossed.status, 400);
		assert.match(crossed.body.error.message, /another newsletter/);
		const linked = await ok(api(user.keys.full, "POST", `/content-items/${spare.id}/campaign`, { campaign: null }));
		assert.equal(linked.item.campaign, null);
	});

	test("a deleted campaign shows as a missing link and keeps the item from being approved; the item itself stays", async () => {
		const user = await customer();
		const draft = await addDraft(m, user.keys.full, { subject: "To delete" });
		const item = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", campaign: draft }), 201)).item;
		await ok(api(user.keys.full, "DELETE", `/campaigns/${draft}`));
		const missing = await get(user, item.id);
		assert.equal(missing.campaign, null);
		assert.equal(missing.delivery.status, "issue_missing");
		assert.deepEqual(missing.readiness.blockers.map((one) => one.code), ["title", "campaign_missing"], "no title of its own, and the issue that gave it one is gone");
		const refused = await api(user.keys.full, "POST", `/content-items/${item.id}/review`);
		assert.equal(refused.status, 409);
		assert.match(refused.body.error.message, /deleted/);
		const relinked = await addDraft(m, user.keys.full, { subject: "Replacement" });
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/campaign`, { campaign: relinked }));
		assert.equal((await ok(api(user.keys.full, "POST", `/content-items/${item.id}/review`))).item.state, "ready_for_review");
	});

	test("an approved issue changed in its campaign afterwards is marked edited after approval, and a new review puts it back in review", async () => {
		const user = await customer();
		const draft = await addDraft(m, user.keys.full, { subject: "Approved subject" });
		const item = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", campaign: draft }), 201)).item;
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/review`));
		await approve(user, item.id);
		const approved = await get(user, item.id);
		assert.equal(approved.review.approvalValid, true);
		await ok(api(user.keys.full, "PATCH", `/campaigns/${draft}`, { content: "A different body" }));
		const edited = await get(user, item.id);
		assert.equal(edited.state, "approved");
		assert.equal(edited.review.editedAfterApproval, true);
		assert.equal(edited.review.approvalValid, false);
		const requested = await ok(api(user.keys.full, "POST", `/content-items/${item.id}/review`));
		assert.equal(requested.requested, true);
		assert.equal(requested.item.state, "ready_for_review");
		await approve(user, item.id);
		assert.equal((await get(user, item.id)).review.editedAfterApproval, false);
	});
});

describe("review and approval", () => {
	test("what is missing is listed, a review is refused until it is fixed, and approving is the owner's click", async () => {
		const user = await customer();
		const item = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "linkedin", title: "Bare" }), 201)).item;
		assert.deepEqual((await get(user, item.id)).readiness.blockers.map((one) => one.code), ["body", "cta", "visual"]);
		const refused = await api(user.keys.full, "POST", `/content-items/${item.id}/review`);
		assert.equal(refused.status, 409);
		assert.match(refused.body.error.message, /Write the post\. Add the call to action\. Attach a visual\./);
		const media = await upload(user.keys.full);
		await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { body: "x".repeat(3001), cta: "Read" }));
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/assets`, { media }));
		assert.deepEqual((await get(user, item.id)).readiness.blockers.map((one) => one.code), ["body_length", "alt_text"]);
		await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { body: "Short enough." }));
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/assets`, { media, altText: "A chart" }));
		const ready = await get(user, item.id);
		assert.equal(ready.readiness.canApprove, true);
		assert.deepEqual(ready.readiness.warnings.map((one) => one.code).toSorted(), ["date", "funnel_stage", "hook", "pillar"]);

		assert.equal((await as(user, () => m.dashboard.decideContentReview(item.id, "approve", ""))).error?.length > 0, true, "not in review yet");
		const requested = await ok(api(user.keys.drafts, "POST", `/content-items/${item.id}/review`));
		assert.equal(requested.item.state, "ready_for_review");
		assert.equal(requested.item.review.requestedBy, "key: drafts key");
		const again = await ok(api(user.keys.drafts, "POST", `/content-items/${item.id}/review`));
		assert.equal(again.requested, false, "asking twice changes nothing");
		const result = await approve(user, item.id);
		assert.deepEqual(result, { ok: true });
		const approved = await get(user, item.id);
		assert.equal(approved.state, "approved");
		assert.equal(approved.review.decision, "approved");
		assert.equal(approved.review.approvedVersion, approved.version);
		assert.equal(approved.review.approvalValid, true);
		assert.equal((await api(user.keys.full, "PATCH", `/content-items/${item.id}`, { state: "approved" })).status, 400, "state can't be set to approved by hand");
	});

	test("an edit after approval takes the approval back and shows it; a move, a note and a pillar don't", async () => {
		const user = await customer();
		const item = await post(user);
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/review`));
		await approve(user, item.id);

		for (const change of [{ notes: "Private thought" }, { pillar: "Another pillar" }, { obstacle: "A new obstacle" }, { references: [{ url: "https://example.com/source", kind: "evidence" }] }]) {
			const kept = await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, change));
			assert.equal(kept.item.state, "approved", JSON.stringify(change));
			assert.equal(kept.approvalWithdrawn, false);
		}
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/slot`, { date: "2026-11-24" }));
		assert.equal((await get(user, item.id)).state, "approved");

		const edited = await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { body: "Changed after the owner approved it." }));
		assert.equal(edited.approvalWithdrawn, true);
		assert.deepEqual(edited.changedFields, ["body"]);
		assert.equal(edited.item.state, "changes_requested");
		assert.equal(edited.item.review.editedAfterApproval, true);
		assert.equal(edited.item.review.decision, null);
		assert.ok(edited.item.review.editedAfterApprovalAt);
		const summary = (await ok(api(user.keys.full, "GET", "/content-items"))).items.find((one) => one.id === item.id);
		assert.equal(summary.review.editedAfterApproval, true, "the list says so too");

		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/review`));
		await approve(user, item.id);
		for (const change of [{ title: "A new title" }, { hook: "A new hook" }, { cta: "A new call" }, { destinationUrl: "https://example.com/new" }]) {
			const withdrawn = await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, change));
			assert.equal(withdrawn.approvalWithdrawn, true, JSON.stringify(change));
			await ok(api(user.keys.full, "POST", `/content-items/${item.id}/review`));
			await approve(user, item.id);
		}
		const media = await upload(user.keys.full);
		assert.equal((await ok(api(user.keys.full, "POST", `/content-items/${item.id}/assets`, { media, altText: "Another" }))).approvalWithdrawn, true, "a visual is part of the post");
	});

	test("an approval is never given to words that changed since they were read, and an edit made on a stale copy is a conflict", async () => {
		const user = await customer();
		const item = await post(user);
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/review`));
		const lib = await import("../lib/content-items.js");
		const account = { _id: user.accountId };
		const stale = await itemRow(user, item.id);
		await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { body: "Changed while the owner was reading." }));
		await assert.rejects(lib.decideReview(account, stale, { decision: "approve" }, "dashboard"), (error) => error.code === "conflict");
		await assert.rejects(lib.applyContentChange(account, stale, { body: "Written on an old copy" }, { by: "test" }), (error) => error.code === "conflict");
		assert.equal((await get(user, item.id)).state, "ready_for_review", "nothing was approved");
		assert.equal((await get(user, item.id)).body, "Changed while the owner was reading.");
		const fresh = await itemRow(user, item.id);
		assert.equal((await lib.decideReview(account, fresh, { decision: "approve" }, "dashboard")).state, "approved");
	});

	test("asking for changes carries the owner's note, and a post set back to drafting is no longer approved", async () => {
		const user = await customer();
		const item = await post(user);
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/review`));
		assert.deepEqual(await as(user, () => m.dashboard.decideContentReview(item.id, "request_changes", "Shorter hook, please")), { ok: true });
		const changes = await get(user, item.id);
		assert.equal(changes.state, "changes_requested");
		assert.equal(changes.review.note, "Shorter hook, please");
		assert.equal(changes.review.decision, "changes_requested");
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/review`));
		assert.equal((await get(user, item.id)).review.note, null, "a new request clears the old note");
		await approve(user, item.id);
		const back = await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { state: "drafting" }));
		assert.equal(back.item.state, "drafting");
		assert.equal(back.item.review.decision, null);
		assert.equal(back.approvalWithdrawn, true);
	});

	test("a batch review asks for every item that can be approved and lists the ones that can't, with why", async () => {
		const user = await customer();
		const batch = (await ok(api(user.keys.full, "POST", "/editorial-batches", { name: "Mixed" }), 201)).batch;
		const complete = await post(user, { batch: batch.id });
		const bare = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "linkedin", title: "Bare", batch: batch.id }), 201)).item;
		const result = await ok(api(user.keys.full, "POST", `/editorial-batches/${batch.id}/review`));
		assert.deepEqual(result.requested.map((one) => one.id), [complete.id]);
		assert.deepEqual(result.blocked.map((one) => [one.id, one.blockers.map((blocker) => blocker.code)]), [[bare.id, ["body", "cta", "visual"]]]);
		const again = await ok(api(user.keys.full, "POST", `/editorial-batches/${batch.id}/review`));
		assert.deepEqual(again.alreadyInReview.map((one) => one.id), [complete.id]);
		assert.deepEqual(again.requested, []);
		const approved = await as(user, () => m.dashboard.approveReadyItems(batch.id));
		assert.deepEqual(approved, { ok: true, approved: 1 });
		assert.equal((await get(user, bare.id)).state, "idea");
	});
});

describe("visuals", () => {
	test("attach in order with alt text, reorder, replace and remove, with the files from the media library and none copied", async () => {
		const user = await customer();
		const item = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "linkedin", title: "Carousel" }), 201)).item;
		const [a, b, c] = [await upload(user.keys.full), await upload(user.keys.full), await upload(user.keys.full)];
		const uploads = await m.Upload.countDocuments({ accountId: user.accountId });
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/assets`, { media: a, altText: "First" }));
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/assets`, { media: b, altText: "Second" }));
		const third = await ok(api(user.keys.full, "POST", `/content-items/${item.id}/assets`, { media: c, altText: "Third", position: 1 }));
		assert.deepEqual(third.item.assets.map((asset) => [asset.position, asset.mediaId, asset.altText]), [[1, c, "Third"], [2, a, "First"], [3, b, "Second"]]);
		assert.ok(third.item.assets.every((asset) => asset.url.startsWith("https://") && asset.name && !asset.isMissing), "each has its file to download");
		const moved = await ok(api(user.keys.full, "POST", `/content-items/${item.id}/assets`, { media: b, position: 1 }));
		assert.deepEqual(moved.item.assets.map((asset) => [asset.mediaId, asset.altText]), [[b, "Second"], [c, "Third"], [a, "First"]], "a file already attached moves and keeps its alt text");
		const renamed = await ok(api(user.keys.full, "POST", `/content-items/${item.id}/assets`, { media: a, altText: "First, again" }));
		assert.equal(renamed.item.assets[2].altText, "First, again");
		const replaced = await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}/assets`, { assets: [{ media: a, altText: "Only" }, { media: c }] }));
		assert.deepEqual(replaced.item.assets.map((asset) => [asset.mediaId, asset.altText]), [[a, "Only"], [c, ""]]);
		assert.equal((await m.Upload.countDocuments({ accountId: user.accountId })), uploads, "no file was stored twice");
		assert.deepEqual((await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}/assets`, { assets: [] }))).item.assets, []);
		assert.equal((await api(user.keys.full, "PATCH", `/content-items/${item.id}/assets`, { assets: [{ media: a }, { media: a }] })).status, 400, "once each");
	});

	test("a PDF carousel stands alone on LinkedIn, files that aren't pictures or PDFs are refused, and only the account's own library is used", async () => {
		const user = await customer();
		const stranger = await customer();
		const item = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "linkedin", title: "Doc" }), 201)).item;
		const pdf = await upload(user.keys.full, "pdf");
		const image = await upload(user.keys.full);
		const text = (await ok(api(user.keys.full, "POST", "/files", { base64: Buffer.from("a,b\n1,2\n").toString("base64"), fileName: "data.csv" }), 201)).id;
		const added = await ok(api(user.keys.full, "POST", `/content-items/${item.id}/assets`, { media: pdf }));
		assert.equal(added.item.assets[0].kind, "pdf");
		assert.equal(added.item.assets[0].contentType, "application/pdf");
		assert.equal((await api(user.keys.full, "POST", `/content-items/${item.id}/assets`, { media: image })).status, 400, "a PDF and a picture don't mix on LinkedIn");
		assert.equal((await api(user.keys.full, "POST", `/content-items/${item.id}/assets`, { media: text })).status, 400, "a CSV isn't a visual");
		assert.equal((await api(user.keys.full, "POST", `/content-items/${item.id}/assets`, { media: await upload(stranger.keys.full) })).status, 404, "someone else's file");
		assert.equal((await api(user.keys.full, "POST", `/content-items/${item.id}/assets`, { media: "nope" })).status, 400);
		assert.equal((await get(user, item.id)).readiness.blockers.some((one) => one.code === "alt_text"), false, "a PDF needs no alt text");
		const issue = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", title: "Issue" }), 201)).item;
		assert.equal((await api(user.keys.full, "POST", `/content-items/${issue.id}/assets`, { media: image })).status, 200);
		assert.equal((await api(user.keys.full, "POST", `/content-items/${issue.id}/assets`, { media: pdf })).status, 200, "a newsletter item can hold both");
	});

	test("a visual a key can't reach through the media actions can't be attached either", async () => {
		const user = await customer();
		const item = await post(user);
		const media = await upload(user.keys.full);
		assert.equal((await api(user.keys.read_only, "POST", `/content-items/${item.id}/assets`, { media })).status, 403);
		assert.equal((await api(user.keys.drafts, "POST", `/content-items/${item.id}/assets`, { media, altText: "ok" })).status, 200);
		assert.equal((await api(user.keys.drafts, "POST", "/images", { base64: PNG, fileName: "via-drafts.png" })).status, 201, "a drafts key uploads through the media actions");
	});

	test("the dashboard downloads a visual through the account's own session, and nobody else's", async () => {
		const user = await customer();
		const stranger = await customer();
		const item = await post(user);
		const route = await import("../app/(app)/campaigns/calendar/items/[id]/download/[position]/route.js");
		const realFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => (String(input).startsWith("https://blob.example.com/") ? new Response("PNGDATA", { headers: { "content-type": "image/png" } }) : realFetch(input, init));
		try {
			const response = await as(user, () => route.GET(new Request("http://localhost:3000/x"), { params: Promise.resolve({ id: item.id, position: "1" }) }));
			assert.equal(response.status, 200);
			assert.match(response.headers.get("content-disposition"), /^attachment; filename=/);
			assert.equal(await response.text(), "PNGDATA");
			assert.equal((await as(user, () => route.GET(new Request("http://localhost:3000/x"), { params: Promise.resolve({ id: item.id, position: "2" }) }))).status, 404);
			assert.equal((await as(stranger, () => route.GET(new Request("http://localhost:3000/x"), { params: Promise.resolve({ id: item.id, position: "1" }) }))).status, 404);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("retry-safe imports", () => {
	test("the same import twice makes the items once, and says which were new", async () => {
		const user = await customer();
		const items = [1, 2, 3].map((number) => ({ channel: "linkedin", title: `Imported ${number}`, externalId: `import-${number}`, funnelStage: "TOFU" }));
		const first = await ok(api(user.keys.drafts, "POST", "/content-items/import", { items }));
		assert.deepEqual([first.created, first.existing], [3, 0]);
		const again = await ok(api(user.keys.drafts, "POST", "/content-items/import", { items: [...items, { channel: "linkedin", title: "Imported 4", externalId: "import-4" }] }));
		assert.deepEqual([again.created, again.existing], [1, 3]);
		assert.deepEqual(again.items.map((one) => one.created), [false, false, false, true]);
		assert.deepEqual(again.items.slice(0, 3).map((one) => one.item.id), first.items.map((one) => one.item.id));
		assert.equal(await m.ContentItem.countDocuments(own(user)), 4);
	});

	test("an existing item comes back as it is, a repeat changes nothing, and a key used in another newsletter or by another account is not leaked", async () => {
		const user = await customer();
		const stranger = await customer();
		const body = { channel: "linkedin", title: "Original", externalId: "same-key", body: "First words" };
		const first = await ok(api(user.keys.full, "POST", "/content-items", body), 201);
		const repeat = await ok(api(user.keys.full, "POST", "/content-items", { ...body, title: "Changed title", body: "Other words" }));
		assert.equal(repeat.created, false);
		assert.equal(repeat.item.id, first.item.id);
		assert.equal(repeat.item.title, "Original");
		assert.equal(repeat.item.version, 1);
		assert.equal(await m.ContentRevision.countDocuments(own(user, { itemId: first.item.id })), 1);
		const theirs = await ok(api(stranger.keys.full, "POST", "/content-items", body), 201);
		assert.notEqual(theirs.item.id, first.item.id, "keys are per account");
		const crossed = await api(user.keys.full, "POST", "/content-items", { ...body, newsletter: user.otherSlug });
		assert.equal(crossed.status, 409);
		assert.doesNotMatch(JSON.stringify(crossed.body), /Original/);
		const batch = await ok(api(user.keys.full, "POST", "/editorial-batches", { name: "Batch", externalId: "batch-key" }), 201);
		const batchAgain = await ok(api(user.keys.full, "POST", "/editorial-batches", { name: "Renamed", externalId: "batch-key" }));
		assert.equal(batchAgain.created, false);
		assert.equal(batchAgain.batch.id, batch.batch.id);
		assert.equal(batchAgain.batch.name, "Batch");
		assert.equal((await api(user.keys.full, "POST", "/editorial-batches", { name: "Other", externalId: "batch-key", newsletter: user.otherSlug })).status, 409);
	});

	test("two imports that race for the same key make one item", async () => {
		const user = await customer();
		const send = () => api(user.keys.full, "POST", "/content-items", { channel: "linkedin", title: "Race", externalId: "race-1" });
		const answers = await Promise.all([send(), send(), send()]);
		assert.ok(answers.every((answer) => answer.status === 200 || answer.status === 201), JSON.stringify(answers.map((a) => a.body)));
		assert.equal(new Set(answers.map((answer) => answer.body.item.id)).size, 1);
		assert.equal(await m.ContentItem.countDocuments(own(user, { externalId: "race-1" })), 1);
	});
});

describe("manual publication", () => {
	test("a post is delivered only after approval, with a LinkedIn address, and is never called scheduled or published by FlockStack", async () => {
		const user = await customer();
		const item = await post(user, { plannedDate: "2026-11-10", plannedTime: "09:00", timeZone: "Europe/Paris" });
		assert.deepEqual(item.delivery, { mode: "manual", status: "not_posted", at: null, url: null });
		const early = await api(user.keys.full, "POST", `/content-items/${item.id}/publication`, { url: "https://www.linkedin.com/posts/example-1" });
		assert.equal(early.status, 409, "not approved yet");
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/review`));
		await approve(user, item.id);
		for (const url of [undefined, "https://example.com/not-linkedin", "ftp://www.linkedin.com/x", "not a url", "https://evil-linkedin.com/posts/1"]) {
			const refused = await api(user.keys.full, "POST", `/content-items/${item.id}/publication`, { ...(url && { url }) });
			assert.equal(refused.status, 400, String(url));
		}
		assert.equal((await api(user.keys.full, "POST", `/content-items/${item.id}/publication`, { url: "https://www.linkedin.com/posts/example-1", deliveredAt: new Date(Date.now() + 86_400_000).toISOString() })).status, 400, "not in the future");
		const done = await ok(api(user.keys.drafts, "POST", `/content-items/${item.id}/publication`, { url: "https://www.linkedin.com/posts/example-1", deliveredAt: "2026-10-20T08:04:00Z" }));
		assert.equal(done.item.state, "delivered");
		assert.deepEqual(done.item.delivery, { mode: "manual", status: "posted", at: "2026-10-20T08:04:00.000Z", url: "https://www.linkedin.com/posts/example-1" });
		assert.equal(done.item.deliveredBy, "key: drafts key");
		const entry = (await plan(user)).entries.find((one) => one.itemId === item.id);
		assert.equal(entry.kind, "planned", "FlockStack never shows a post as scheduled or sent");
		assert.equal(entry.isManual, true);
		assert.equal(entry.deliveryStatus, "posted");
		assert.equal((await api(user.keys.full, "PATCH", `/content-items/${item.id}`, { state: "drafting" })).status, 409, "a delivered item keeps its state");

		const edited = await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { body: "A typo fixed." }));
		assert.equal(edited.item.state, "delivered", "a fixed typo doesn't undeliver it");
		const undone = await ok(api(user.keys.full, "POST", `/content-items/${item.id}/publication`, { published: false }));
		assert.equal(undone.item.state, "approved");
		assert.deepEqual(undone.item.delivery, { mode: "manual", status: "not_posted", at: null, url: null });
		assert.equal((await api(user.keys.full, "POST", `/content-items/${item.id}/publication`, { published: false })).status, 409);
	});

	test("an issue is recorded as delivered only once its campaign has been sent, with the time it was sent", async () => {
		const user = await customer();
		const draft = await addDraft(m, user.keys.full, { subject: "Goes out" });
		const item = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", campaign: draft }), 201)).item;
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/review`));
		await approve(user, item.id);
		const early = await api(user.keys.full, "POST", `/content-items/${item.id}/publication`, {});
		assert.equal(early.status, 409);
		assert.match(early.body.error.message, /hasn't been sent/);
		await setCampaign(user, draft, { status: "sent", sentAt: new Date("2026-10-03T08:00:00Z") });
		const done = await ok(api(user.keys.full, "POST", `/content-items/${item.id}/publication`, {}));
		assert.equal(done.item.state, "delivered");
		assert.equal(done.item.deliveredAt, "2026-10-03T08:00:00.000Z");
		assert.equal(done.item.delivery.mode, "campaign");
		assert.equal(done.item.delivery.status, "sent");
	});
});

describe("revisions", () => {
	test("every change to the content is kept, and an earlier state can be read and restored as a new revision", async () => {
		const user = await customer();
		const item = await post(user);
		await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { body: "Second words", cta: "Second call" }));
		await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { notes: "A note", body: "Third words" }));
		const list = await ok(api(user.keys.full, "GET", `/content-items/${item.id}/revisions?includeContent=true`));
		assert.deepEqual(list.revisions.map((one) => one.version), [3, 2, 1]);
		assert.deepEqual(list.revisions.map((one) => one.reason), ["edit", "edit", "create"]);
		assert.deepEqual(list.revisions[1].changedFields, ["body", "cta"]);
		assert.equal(list.revisions[0].content.body, "Third words");
		assert.equal(list.revisions[2].content.body, "Most newsletters count opens. Replies tell you who reads.");
		assert.equal((await ok(api(user.keys.full, "GET", `/content-items/${item.id}/revisions`))).revisions[0].content, undefined);

		await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { title: "No change but the same body", body: "Third words" }));
		await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { body: "Third words" }));
		assert.equal((await ok(api(user.keys.full, "GET", `/content-items/${item.id}/revisions`))).revisions.length, 4, "a save that changes nothing keeps nothing");

		const restored = await ok(api(user.keys.full, "POST", `/content-items/${item.id}/revisions/${list.revisions[2].id}/restore`));
		assert.equal(restored.item.body, "Most newsletters count opens. Replies tell you who reads.");
		assert.equal(restored.item.notes, "");
		assert.equal(restored.item.version, 5);
		assert.deepEqual(restored.skipped, []);
		const after = await ok(api(user.keys.full, "GET", `/content-items/${item.id}/revisions`));
		assert.equal(after.revisions[0].reason, "restore");
		assert.equal((await api(user.keys.full, "POST", `/content-items/${item.id}/revisions/${"a".repeat(24)}/restore`)).status, 404);
	});

	test("a restore skips a visual that left the library, and restoring over approved words takes the approval back; only 50 are kept", async () => {
		const user = await customer();
		const item = await post(user);
		const original = (await ok(api(user.keys.full, "GET", `/content-items/${item.id}/revisions`))).revisions[0];
		const media = await upload(user.keys.full);
		await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}/assets`, { assets: [{ media, altText: "New" }] }));
		await m.Upload.deleteOne(own(user, { _id: item.assets[0].mediaId }));
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/review`));
		await approve(user, item.id);
		const restored = await ok(api(user.keys.full, "POST", `/content-items/${item.id}/revisions/${original.id}/restore`));
		assert.deepEqual(restored.skipped, ["a visual that is no longer in the media library"]);
		assert.equal(restored.approvalWithdrawn, true);
		assert.equal(restored.item.state, "changes_requested");

		for (let index = 0; index < 55; index++) await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { hook: `Hook ${index}` }));
		assert.equal(await m.ContentRevision.countDocuments(own(user, { itemId: item.id })), 50);
		const latest = (await ok(api(user.keys.full, "GET", `/content-items/${item.id}/revisions?limit=1&includeContent=true`))).revisions[0];
		assert.equal(latest.content.hook, "Hook 54", "the newest is kept");
	});
});

describe("REST, MCP and the dashboard do the same", () => {
	test("creating an item through each leaves the same kind of record, and every planning tool exists", async () => {
		const user = await customer();
		const fields = { channel: "linkedin", title: "Same thing", funnelStage: "MOFU", pillar: "Parity", body: "Words", cta: "Go", plannedDate: "2026-11-18", timeZone: "UTC" };
		const viaRest = await ok(api(user.keys.drafts, "POST", "/content-items", { ...fields, externalId: "rest" }), 201);
		const viaMcp = (await callTool(m, user.keys.drafts, "create_content_item", { ...fields, externalId: "mcp" })).structuredContent;
		const viaDashboard = await as(user, () => m.dashboard.createContentItem(user.newsletterId, { channel: "linkedin", title: "Same thing", funnelStage: "MOFU", plannedDate: "2026-11-18", timeZone: "UTC" }));
		assert.equal(viaDashboard.ok, true);
		const strip = (item) => ({ channel: item.channel, funnelStage: item.funnelStage, state: item.state, plannedDate: item.plannedDate, timeZone: item.timeZone, delivery: item.delivery, newsletterId: item.newsletterId });
		const dashboardItem = await get(user, viaDashboard.id);
		assert.deepEqual(strip(viaMcp.item), strip(viaRest.item));
		assert.deepEqual(strip({ ...dashboardItem, state: "drafting" }), strip({ ...viaRest.item, state: "drafting" }));
		assert.deepEqual(Object.keys(viaMcp.item).toSorted(), Object.keys(viaRest.item).toSorted());
		assert.equal(viaMcp.created, true);
		assert.equal((await callTool(m, user.keys.drafts, "create_content_item", { ...fields, externalId: "mcp" })).structuredContent.created, false);

		const names = new Set((await mcp(m, user.keys.full, "tools/list")).body.result.tools.map((tool) => tool.name));
		for (const name of [
			"create_editorial_batch", "list_editorial_batches", "get_editorial_batch", "update_editorial_batch", "apply_editorial_pattern", "request_batch_review",
			"create_content_item", "import_content_items", "list_content_items", "get_content_item", "update_content_item", "get_content_plan", "set_content_slot", "reorder_content_items",
			"link_content_campaign", "attach_content_asset", "set_content_assets", "request_content_review", "record_content_publication", "list_content_revisions", "restore_content_revision",
			"upload_image", "upload_file", "list_media",
		]) {
			assert.ok(names.has(name), name);
		}
		assert.equal(names.has("decide_content_review"), false);
		const listed = (await callTool(m, user.keys.read_only, "list_content_items", { dated: true })).structuredContent;
		assert.equal(listed.items.length, 3);
		const refused = await mcp(m, user.keys.read_only, "tools/call", { name: "create_content_item", arguments: fields });
		assert.ok(refused.body.error || refused.body.result?.isError, "a read only key can't plan");
		assert.equal((await mcp(m, user.keys.read_only, "tools/list")).body.result.tools.some((tool) => tool.name === "create_content_item"), false, "and isn't offered the tool");
	});

	test("every dashboard form runs a registered action and agrees with the API's answer", async () => {
		const user = await customer();
		const issue = await addDraft(m, user.keys.full, { subject: "Dashboard issue" });
		const created = await as(user, () => m.dashboard.createContentItem(user.newsletterId, { channel: "linkedin", title: "From the form", funnelStage: "TOFU" }));
		const planned = await as(user, () => m.dashboard.planCampaignDraft(user.newsletterId, issue));
		assert.ok(created.id && planned.id);
		assert.equal((await get(user, planned.id)).campaign.id, issue);
		const saved = await as(user, () => m.dashboard.saveContentItem(created.id, { title: "Saved", hook: "Hook", body: "Body", cta: "Go", destinationUrl: "https://example.com/x", notes: "n", pillar: "P", funnelStage: "MOFU", references: [{ label: "A", url: "https://example.com/a", kind: "evidence" }, { label: "", url: "" }], batch: "" }));
		assert.equal(saved.ok, true);
		const item = await get(user, created.id);
		assert.deepEqual([item.title, item.funnelStage, item.pillar, item.hook, item.cta, item.references.length], ["Saved", "MOFU", "P", "Hook", "Go", 1]);
		assert.deepEqual(await as(user, () => m.dashboard.moveContentItem(created.id, { date: "2026-12-01", time: "10:00", timeZone: "Europe/Paris" })), { ok: true });
		assert.equal((await get(user, created.id)).plannedAt, "2026-12-01T09:00:00.000Z");
		assert.deepEqual(await as(user, () => m.dashboard.moveContentItem(created.id, { date: "" })), { ok: true });
		assert.equal((await get(user, created.id)).plannedDate, null);
		const batch = await as(user, () => m.dashboard.createEditorialBatch(user.newsletterId, "From the dashboard"));
		assert.ok(batch.id);
		const bad = await as(user, () => m.dashboard.moveContentItem(created.id, { date: "2026-02-30" }));
		assert.match(bad.error, /YYYY-MM-DD/);
		const media = await upload(user.keys.full);
		assert.equal((await as(user, () => m.dashboard.saveContentAssets(created.id, [{ mediaId: media, altText: "Alt" }]))).ok, true);
		assert.equal((await as(user, () => m.dashboard.setContentState(created.id, "idea"))).ok, true);
		assert.equal((await get(user, created.id)).state, "idea");
		const review = await as(user, () => m.dashboard.requestContentReview(created.id));
		assert.equal(review.ok, true);
		assert.equal((await as(user, () => m.dashboard.decideContentReview(created.id, "request_changes", "Not yet"))).ok, true);
		assert.equal((await get(user, created.id)).review.note, "Not yet");
		const drafted = await as(user, () => m.dashboard.savePostToPlan(user.newsletterId, issue, "LinkedIn: Dashboard issue", "A post the AI drafted for the issue."));
		assert.equal(drafted.ok, true);
		const kept = await get(user, drafted.id);
		assert.deepEqual([kept.channel, kept.body, kept.campaign.id, kept.state, kept.delivery.status], ["linkedin", "A post the AI drafted for the issue.", issue, "drafting", "not_posted"], "a drafted post is kept in the plan, unpublished");
		assert.equal((await api(user.keys.full, "POST", "/content-items", { channel: "linkedin", title: "Time only", plannedTime: "09:00" })).status, 400, "a time needs a day");
		assert.equal((await as(user, () => m.dashboard.linkContentCampaign(created.id, issue))).ok, true, "a post can be derived from an issue that has its own item");
		assert.equal((await get(user, created.id)).campaign.id, issue);
		assert.equal((await as(user, () => m.dashboard.linkContentCampaign(created.id, ""))).ok, true);
		assert.equal((await get(user, created.id)).campaign, null);
	});
});

describe("existing calendar and campaign behavior", () => {
	test("get_content_calendar and the campaign actions answer as before with content items around them", async () => {
		const user = await customer();
		const draft = await addDraft(m, user.keys.full, { subject: "Still a draft" });
		const scheduled = await addDraft(m, user.keys.full, { subject: "Scheduled one" });
		const first = new Date(Date.now() + 60 * 86_400_000);
		first.setUTCHours(9, 0, 0, 0);
		const second = new Date(first.getTime() + 86_400_000);
		const day = (date) => date.toISOString().slice(0, 10);
		const inSixty = day(new Date(first.getTime() - 5 * 86_400_000));
		await ok(api(user.keys.full, "POST", `/campaigns/${scheduled}/schedule`, { scheduledAt: first.toISOString() }));
		await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", campaign: draft, plannedDate: inSixty }), 201);
		await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", campaign: scheduled, plannedDate: day(new Date(first.getTime() - 3 * 86_400_000)) }), 201);
		const calendar = await ok(api(user.keys.full, "GET", `/calendar?month=${day(first).slice(0, 7)}`));
		assert.deepEqual(calendar.issues.map((issue) => [issue.subject, issue.status, issue.date]), [["Scheduled one", "scheduled", day(first)]], "drafts and plans are not in it");
		const campaign = await ok(api(user.keys.full, "GET", `/campaigns/${draft}`));
		assert.equal(campaign.status, "draft");
		assert.equal(campaign.scheduledAt ?? null, null);
		await ok(api(user.keys.full, "PATCH", `/campaigns/${draft}`, { subject: "Edited draft" }));
		await ok(api(user.keys.full, "POST", `/campaigns/${draft}/schedule`, { scheduledAt: second.toISOString() }));
		const range = await ok(api(user.keys.full, "GET", `/content-plan?from=${day(first)}&to=${day(second)}`));
		assert.deepEqual(range.entries.map((one) => [one.title, one.kind, one.date]), [["Scheduled one", "scheduled", day(first)], ["Edited draft", "scheduled", day(second)]]);
		await ok(api(user.keys.full, "DELETE", `/campaigns/${scheduled}`));
		assert.equal((await ok(api(user.keys.full, "GET", `/calendar?month=${day(first).slice(0, 7)}`))).issues.length, day(first).slice(0, 7) === day(second).slice(0, 7) ? 1 : 0);
	});

	test("deleting an item or a batch leaves the campaign, the media and the other items alone", async () => {
		const user = await customer();
		const draft = await addDraft(m, user.keys.full);
		const item = await post(user);
		const issue = (await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", campaign: draft }), 201)).item;
		const batch = (await ok(api(user.keys.full, "POST", "/editorial-batches", { name: "Going" }), 201)).batch;
		await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { batch: batch.id }));
		await ok(api(user.keys.full, "DELETE", `/editorial-batches/${batch.id}`));
		assert.equal((await get(user, item.id)).batchId, null);
		await ok(api(user.keys.full, "DELETE", `/content-items/${issue.id}`));
		assert.equal((await ok(api(user.keys.full, "GET", `/campaigns/${draft}`))).status, "draft");
		assert.equal(await m.Upload.countDocuments({ accountId: user.accountId }), 1);
		assert.equal(await m.ContentRevision.countDocuments(own(user, { itemId: issue.id })), 0);
		assert.equal((await api(user.keys.full, "GET", `/content-items/${issue.id}`)).status, 404);
	});
});

describe("the rules", () => {
	test("readiness lists what a post and an issue need", () => {
		const { checkReadiness, composePost, getChangedFields, changesApproval } = m.rules;
		const codes = (item, extra) => checkReadiness(item, extra).blockers.map((one) => one.code);
		assert.deepEqual(codes({ channel: "linkedin" }), ["title", "body", "cta", "visual"]);
		assert.deepEqual(codes({ channel: "linkedin", title: "T", body: "B", cta: "C", assets: [{ mediaId: "a", kind: "image", altText: "" }] }), ["alt_text"]);
		assert.deepEqual(codes({ channel: "linkedin", title: "T", body: "B", cta: "C", assets: [{ mediaId: "a", kind: "pdf" }] }), []);
		assert.deepEqual(codes({ channel: "newsletter" }), ["title", "campaign"]);
		assert.deepEqual(codes({ channel: "newsletter", campaignId: "c" }, { campaign: { subject: "S" } }), []);
		assert.deepEqual(codes({ channel: "newsletter", campaignId: "c" }, { campaign: { subject: "" } }), ["title", "subject"]);
		assert.equal(composePost({ hook: "Hook", body: "Body", cta: "Go", destinationUrl: "https://example.com" }), "Hook\n\nBody\n\nGo\n\nhttps://example.com");
		assert.equal(composePost({ hook: "Body starts here", body: "Body starts here and goes on", cta: "See https://example.com", destinationUrl: "https://example.com" }), "Body starts here and goes on\n\nSee https://example.com");
		assert.deepEqual(getChangedFields({ title: "a", notes: "x" }, { title: "a", notes: "y" }), ["notes"]);
		assert.equal(changesApproval(["notes", "pillar"]), false);
		assert.equal(changesApproval(["notes", "cta"]), true);
		assert.equal(m.rules.isDateKey("2026-02-29"), false);
		assert.equal(m.rules.isDateKey("2028-02-29"), true);
	});

	test("the model's indexes keep an item's key and an issue's link unique per account", async () => {
		const a = await customer();
		const b = await customer();
		const base = { channel: "linkedin", newsletterId: a.newsletterId };
		await m.ContentItem.create({ ...base, accountId: a.accountId, externalId: "k" });
		await assert.rejects(m.ContentItem.create({ ...base, accountId: a.accountId, externalId: "k" }), (error) => error.code === 11000);
		await m.ContentItem.create({ ...base, accountId: b.accountId, newsletterId: b.newsletterId, externalId: "k" });
		await m.ContentItem.create({ ...base, accountId: a.accountId });
		await m.ContentItem.create({ ...base, accountId: a.accountId });
	});
});

describe("the pages", () => {
	test("the calendar tells a plan from a delivery, filters, shows the backlog and offers a way to move without dragging", async () => {
		const user = await customer();
		const page = (await import("../app/(app)/campaigns/calendar/page.js")).default;
		const render = async (searchParams) => renderToStaticMarkup(await as(user, () => page({ searchParams: Promise.resolve(searchParams) })));
		const draft = await addDraft(m, user.keys.full, { subject: "Planned issue" });
		const sent = await addDraft(m, user.keys.full, { subject: "Sent issue" });
		await setCampaign(user, sent, { status: "sent", sentAt: new Date("2026-11-03T08:00:00Z") });
		const scheduled = await addDraft(m, user.keys.full, { subject: "Scheduled issue" });
		await setCampaign(user, scheduled, { status: "scheduled", scheduledAt: new Date("2026-11-12T09:00:00Z") });
		await ok(api(user.keys.full, "POST", "/content-items", { channel: "newsletter", campaign: draft, plannedDate: "2026-11-05" }), 201);
		const linked = await post(user, { title: "A LinkedIn post", plannedDate: "2026-11-05", funnelStage: "MOFU" });
		await ok(api(user.keys.full, "POST", "/content-items", { channel: "linkedin", title: "Waiting in the backlog" }), 201);
		await addDraft(m, user.keys.full, { subject: "Not in the plan yet" });

		const html = await render({ month: "2026-11" });
		const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
		assert.match(text, /Planned.{0,30}Planned issue/);
		assert.match(text, /Planned.{0,40}A LinkedIn post/);
		assert.match(text, /Sent.{0,20}Sent issue/);
		assert.match(text, /Scheduled.{0,20}Scheduled issue/);
		assert.ok(html.includes("border-dashed"), "a plan is outlined");
		assert.match(text, /Waiting in the backlog/);
		assert.match(text, /1 without a day/);
		assert.match(text, /Drafts not in the plan.{0,40}Not in the plan yet.{0,10}Add to plan/);
		assert.doesNotMatch(text.slice(text.indexOf("Drafts not in the plan")), /Planned issue/, "a draft that has an item isn't offered");
		assert.match(text, /nothing is sent or published on that day/);
		assert.match(text, /2 issues this month\. 2 planned/);
		assert.ok(html.includes(`href="/campaigns/calendar/items/${linked.id}"`));
		assert.ok(html.includes(`href="/campaigns/${sent}"`));
		assert.match(html, /<label[^>]*>[^<]*(<[^>]+>)*Channel/);

		const filtered = (await render({ month: "2026-11", channel: "linkedin" })).replace(/<[^>]+>/g, " ");
		assert.match(filtered, /A LinkedIn post/);
		assert.doesNotMatch(filtered.replace(/Drafts not in the plan[\s\S]*$/, ""), /Sent issue|Scheduled issue/);
		const staged = (await render({ month: "2026-11", stage: "BOFU" })).replace(/<[^>]+>/g, " ");
		assert.doesNotMatch(staged.replace(/Backlog[\s\S]*$/, ""), /A LinkedIn post/);

		const week = await render({ view: "week", date: "2026-11-05" });
		assert.ok(week.includes('aria-label="Nov 2 to Nov 8, 2026, by day"') || /by day/.test(week));
		assert.match(week.replace(/<[^>]+>/g, " "), /A LinkedIn post/);
		assert.ok(week.includes('type="date"'), "a date field to move an item");
		assert.ok(week.includes('href="/campaigns/calendar?view=week&amp;date=2026-11-09"'), "next week");
		const agenda = (await render({ view: "agenda", month: "2026-11" })).replace(/<[^>]+>/g, " ");
		assert.match(agenda, /Nov 5/);
		assert.match(agenda, /Planned issue/);
		assert.match(agenda.replace(/\s+/g, " "), /Sent issue/);
	});

	test("an item's page has the copy, notes, call to action, visuals, review, plan, issue and revisions together, and the batch page lists the items to review", async () => {
		const user = await customer();
		const item = await post(user, { notes: "Check the claim", plannedDate: "2026-11-10" });
		const batch = (await ok(api(user.keys.full, "POST", "/editorial-batches", { name: "Review me" }), 201)).batch;
		await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { batch: batch.id }));
		await ok(api(user.keys.full, "POST", `/content-items/${item.id}/review`));
		const itemPage = (await import("../app/(app)/campaigns/calendar/items/[id]/page.js")).default;
		const html = renderToStaticMarkup(await as(user, () => itemPage({ params: Promise.resolve({ id: item.id }) })));
		const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
		for (const expected of ["Why replies beat opens", "Check the claim", "Most newsletters count opens", "Ready for review", "It can be approved", "Planned day", "Revisions", "Copy the post", "Add from the media library", "Approving sends, schedules and publishes nothing", "Address of the post on LinkedIn"]) {
			assert.ok(text.includes(expected), expected);
		}
		for (const value of ["Read the issue", "Open rates lie.", "A chart of replies against opens", "https://example.com/issue"]) assert.ok(html.includes(value), value);
		assert.match(html, /<label[^>]*for="item-title"/);
		assert.ok(html.includes(`/campaigns/calendar/items/${item.id}/download/1`));
		const batchPage = (await import("../app/(app)/campaigns/calendar/batches/[id]/page.js")).default;
		const batchHtml = renderToStaticMarkup(await as(user, () => batchPage({ params: Promise.resolve({ id: batch.id }) }))).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
		for (const expected of ["Review me", "1. Why replies beat opens", "Approve all that are ready (1)", "Ready for review", "Recurring pattern", "never sends, schedules or publishes"]) assert.ok(batchHtml.includes(expected), expected);

		await approve(user, item.id);
		await ok(api(user.keys.full, "PATCH", `/content-items/${item.id}`, { body: "Edited afterwards." }));
		const edited = renderToStaticMarkup(await as(user, () => itemPage({ params: Promise.resolve({ id: item.id }) }))).replace(/<[^>]+>/g, " ");
		assert.match(edited, /Edited after approval/);
		const stranger = await customer();
		const { NotFoundError } = await import("./stubs/next-navigation.mjs");
		await assert.rejects(as(stranger, () => itemPage({ params: Promise.resolve({ id: item.id }) })), NotFoundError);
	});
});
