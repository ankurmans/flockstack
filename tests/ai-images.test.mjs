import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "../components/ui/dialog.jsx";
import { as, withEnv } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { setAi } from "./stubs/opennext-cloudflare.mjs";
import { deleted, stored } from "./stubs/vercel-blob.mjs";

// A synthetic two-pixel JPEG, never a provider response or a user's image.
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";
let t, m, n = 0;
before(async () => {
	t = await setupAudienceTests();
	m = { Upload: (await import("../models/Upload.js")).default, AiUsage: (await import("../models/AiUsage.js")).default, Activity: (await import("../models/AgentActivity.js")).default, images: await import("../lib/ai-images.js"), picker: (await import("../components/PickerGeneratedImage.jsx")).default, media: await import("../app/(app)/media/actions.js") };
});
afterEach(() => setAi(null));
after(() => t?.app.stop());
const customer = () => t.customer(`image-ai${++n}@example.com`);
const generate = (u, input = {}, key = u.key) => t.api(key, "POST", "/ai/images", { newsletter: u.newsletterId, prompt: "A white paper bird", consent: true, ...input });
function stub(reply = { image: JPEG }) {
	const calls = [];
	setAi({ async run(model, input, options) { calls.push({ model, input, options }); if (reply instanceof Error) throw reply; return reply; } });
	return calls;
}

test("saves an ordinary account-owned image with model and date, without persisting or logging the prompt", async () => {
	const u = await customer(), other = await customer();
	const calls = stub();
	const prompt = "abcdef0123456789abcdef01";
	const r = await generate(u, { prompt, folder: "Covers" });
	assert.equal(r.status, 201, JSON.stringify(r.body));
	assert.equal(r.body.width, 2); assert.equal(r.body.height, 2); assert.equal(r.body.usage.used, 1);
	assert.equal(calls[0].model, m.images.AI_IMAGE_MODEL);
	assert.deepEqual(calls[0].input, { prompt, steps: 4 });
	assert.deepEqual(calls[0].options, { gateway: { id: "default", skipCache: true, collectLog: false } });
	assert.equal(calls.length, 1);
	const row = await m.Upload.findOne({ accountId: u.accountId, _id: r.body.id }).lean();
	assert.equal(row.generatedBy, m.images.AI_IMAGE_MODEL); assert.ok(row.generatedAt);
	assert.equal(row.folder, "Covers"); assert.equal(row.name, "generated-image.jpg");
	assert.doesNotMatch(JSON.stringify(row), new RegExp(prompt));
	const activity = await m.Activity.find({ accountId: u.accountId, action: "generate_image" }).lean();
	assert.ok(activity.length); assert.doesNotMatch(JSON.stringify(activity), new RegExp(prompt));
	assert.equal((await t.api(u.key, "GET", "/images")).body.images[0].generatedBy, m.images.AI_IMAGE_MODEL);
	assert.equal((await t.api(other.key, "GET", "/images")).body.images.length, 0);
});

test("requires consent, a valid newsletter, configuration and a bounded prompt before claiming quota", async () => {
	const u = await customer(); const calls = stub();
	for (const input of [{ consent: false }, { prompt: "" }, { prompt: "x".repeat(2049) }, { folder: "../x" }, { newsletter: "missing" }]) assert.ok((await generate(u, input)).status >= 400);
	await withEnv({ BLOB_READ_WRITE_TOKEN: "", IMAGES_STORAGE: "", IMAGES_S3_BUCKET: "" }, async () => t.assertError(await generate(u), 503, "unavailable"));
	assert.equal(calls.length, 0);
	setAi(null); t.assertError(await generate(u), 503, "unavailable");
	assert.equal((await t.api(u.key, "GET", "/ai/usage")).body.used, 0);
});

test("rejects unsupported or corrupt provider bytes and counts every model attempt, including provider errors", async () => {
	const u = await customer();
	for (const image of ["https://example.com/not-fetched.jpg", "AAAA", "/9j/2Q==", JPEG.slice(0, -4), "A".repeat(6_000_000)]) {
		stub({ image }); t.assertError(await generate(u), 503, "unavailable");
	}
	stub(new Error("private prompt should not escape"));
	const failure = await generate(u); t.assertError(failure, 503, "unavailable");
	assert.doesNotMatch(JSON.stringify(failure), /private prompt/);
	assert.equal((await t.api(u.key, "GET", "/ai/usage")).body.used, 6);
	assert.equal(await m.Upload.countDocuments({ accountId: u.accountId }), 0);
	assert.equal(m.images.readGeneratedImage(JPEG).width, 2);
});

test("concurrent calls share the existing daily allowance, including writing usage", async () => {
	const u = await customer(); const calls = stub();
	const { limit, resetsAt } = (await t.api(u.key, "GET", "/ai/usage")).body;
	await m.AiUsage.create({ accountId: u.accountId, day: new Date(Date.parse(resetsAt) - 86400000).toISOString().slice(0, 10), count: limit - 1 });
	const results = await Promise.all([generate(u), generate(u), generate(u)]);
	assert.equal(results.filter((r) => r.status === 201).length, 1);
	assert.equal(results.filter((r) => r.body.error?.code === "ai_daily_limit").length, 2);
	assert.equal(calls.length, 1);
	assert.equal((await t.api(u.key, "GET", "/ai/usage")).body.used, limit);
});

test("draft agents may generate only in their newsletter; readers and signups keys cannot", async () => {
	const u = await customer(), other = await customer(); const calls = stub();
	const makeKey = async (level, newsletter) => (await t.api(u.key, "POST", "/api-keys", { name: "Image tool", level, newsletter })).body.key;
	const drafts = await makeKey("drafts", u.newsletterId), read = await makeKey("read_only", u.newsletterId);
	t.assertError(await generate(u, {}, read), 403, "forbidden");
	t.assertError(await generate(u, {}, u.signupsKey), 403, "forbidden");
	t.assertError(await generate(u, { newsletter: other.newsletterId }, drafts), 403, "forbidden");
	assert.equal(calls.length, 0);
	assert.equal((await generate(u, {}, drafts)).status, 201);
});

test("a failed upload record removes its stored image, with the generation attempt still counted", async () => {
	const u = await customer(); stub();
	const create = m.Upload.create;
	const before = stored.length, beforeDeleted = deleted.length;
	try {
		m.Upload.create = async () => { throw new Error("synthetic record failure"); };
		assert.equal((await generate(u)).status, 500);
	} finally { m.Upload.create = create; }
	assert.equal(stored.length, before + 1); assert.equal(deleted.length, beforeDeleted + 1);
	assert.equal(await m.Upload.countDocuments({ accountId: u.accountId }), 0);
	assert.equal((await t.api(u.key, "GET", "/ai/usage")).body.used, 1);
});

test("self-hosted servers honor AI_DAILY_LIMIT and retain the hourly action limit without a daily cap", async () => {
	const limited = await customer(); const calls = stub();
	await withEnv({ FLOCKSTACK_CLOUD: "", ALLOWED_EMAILS: limited.email, AI_DAILY_LIMIT: "1" }, async () => {
		assert.equal((await generate(limited)).status, 201);
		assert.equal((await generate(limited)).body.error.code, "ai_daily_limit");
	});
	assert.equal(calls.length, 1);
	const hourly = await customer(); const hourlyCalls = stub();
	await withEnv({ FLOCKSTACK_CLOUD: "", ALLOWED_EMAILS: hourly.email, AI_DAILY_LIMIT: "" }, async () => {
		for (let i = 0; i < 10; i++) assert.equal((await generate(hourly)).status, 201);
		t.assertError(await generate(hourly), 429, "rate_limited");
		assert.equal((await t.api(hourly.key, "GET", "/ai/usage")).body.limit, null);
	});
	assert.equal(hourlyCalls.length, 10);
});

test("the editor asks consent and offers review and alt text, and its server action uses the same guard", async () => {
	const html = renderToStaticMarkup(createElement(Dialog, { open: true }, createElement(m.picker, { newsletterId: "synthetic", onSelect() {} })));
	assert.match(html, /public URL/); assert.match(html, /outside my region/); assert.match(html, /including failures/); assert.doesNotMatch(html, /<img/);
	const u = await customer(); stub();
	const denied = await as(u, () => m.media.generateMediaImage(u.newsletterId, "Paper bird", false));
	assert.ok(denied.error);
	const saved = await as(u, () => m.media.generateMediaImage(u.newsletterId, "Paper bird", true));
	assert.ok(saved.image.url); assert.equal(saved.image.usage.used, 1);
});
