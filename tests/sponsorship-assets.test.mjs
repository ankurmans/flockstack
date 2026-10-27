import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { installFakeStripe } from "./helpers/shop.mjs";
import { sponsorCreative, sponsorRequest, sponsorshipModels, sponsorshipSeller } from "./helpers/sponsorships.mjs";
import { files, setFilesBound } from "./stubs/opennext-cloudflare.mjs";
let app, m, fake;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKxkAAAAASUVORK5CYII=", "base64");
before(async () => { app = await startTestApp(); fake = installFakeStripe(); m = { ...(await sponsorshipModels()), assets: await import("../lib/sponsorship-assets.js"), Asset: (await import("../models/SponsorshipAsset.js")).default }; });
after(() => app?.stop());
async function setup() {
	const state = await sponsorshipSeller(m, fake), created = await sponsorRequest(m, state);
	const verified = await m.bookings.verifySponsorshipRequest(created.token);
	return { ...state, booking: verified.booking };
}
const input = extra => ({ base64: PNG.toString("base64"), fileName: "sponsor.png", publicationConsent: true, externalId: randomUUID(), ...extra });
const upload = (s, data = input()) => m.assets.uploadSponsorshipAsset({ account: s.user.account, bookingId: s.booking._id, input: data });

test("sponsor images stay private until uploader consent and current owner creative approval", async () => {
	const s = await setup();
	await assert.rejects(upload(s, input({ publicationConsent: false })), error => error.code === "validation_failed");
	const asset = await upload(s); assert.equal(asset.publicUrl, null); assert.equal(asset.status, "ready");
	assert.doesNotMatch(JSON.stringify(asset), /accounts\/|sha256|key/);
	const stored = await m.Asset.findOne({ accountId: s.user.accountId, _id: asset.id }).lean();
	assert.equal(stored.publicAt, undefined); assert.ok(files.has(stored.key));
	const creative = await m.bookings.updateSponsorshipCreative({ account: s.user.account, bookingId: s.booking._id, input: { ...sponsorCreative, assetId: asset.id } });
	await m.bookings.approveSponsorshipCreative({ account: s.user.account, bookingId: s.booking._id, expectedHash: creative.creativeHash, actorId: String(s.user.account.ownerId) });
	const readable = await m.assets.readSponsorshipAsset({ account: s.user.account, bookingId: s.booking._id, assetId: asset.id, includeContent: true });
	assert.ok(readable.publicUrl); assert.equal(readable.dataUrl, `data:image/png;base64,${PNG.toString("base64")}`);
	const parts = new URL(readable.publicUrl).pathname.split("/");
	assert.deepEqual(Buffer.from((await m.assets.readPublicSponsorshipAsset(parts.at(-2), parts.at(-1))).bytes), PNG);
	assert.equal(await m.assets.readPublicSponsorshipAsset(parts.at(-2), `${parts.at(-1)}x`), null);
});

test("concurrent upload retries keep one immutable object, and changed bytes cannot reuse the ID", async () => {
	const s = await setup(), data = input();
	const [one, two] = await Promise.all([upload(s, data), upload(s, data)]);
	assert.equal(one.id, two.id);
	const rows = await m.Asset.find({ accountId: s.user.accountId, bookingId: s.booking._id }).lean();
	assert.equal(rows.length, 1); assert.equal(files.has(rows[0].key), true, "the losing ready CAS doesn't delete the completed upload");
	const changed = Buffer.from(PNG); changed[changed.length - 1] ^= 1;
	await assert.rejects(upload(s, { ...data, base64: changed.toString("base64") }), error => error.code === "conflict");
});

test("image formats, dimensions, account/booking scope and five-image concurrency limit are enforced", async () => {
	const s = await setup();
	await assert.rejects(upload(s, input({ base64: Buffer.from("<svg><script>bad</script></svg>").toString("base64") })), error => error.code === "validation_failed");
	const oversized = Buffer.from(PNG); oversized.writeUInt32BE(20000, 16);
	await assert.rejects(upload(s, input({ base64: oversized.toString("base64") })), error => error.code === "validation_failed");
	await Promise.all([upload(s), upload(s), upload(s), upload(s)]);
	const last = await Promise.allSettled([upload(s), upload(s)]);
	assert.equal(last.filter(value => value.status === "fulfilled").length, 1);
	assert.equal(await m.Asset.countDocuments({ accountId: s.user.accountId, bookingId: s.booking._id }), 5);
	const other = await setup(), row = await m.Asset.findOne({ accountId: s.user.accountId }).lean();
	await assert.rejects(m.assets.readSponsorshipAsset({ account: other.user.account, bookingId: other.booking._id, assetId: row._id, includeContent: true }), error => error.code === "not_found");
});

test("a failed private put retains its tracked key and safely retries, while unused removal frees capacity", async () => {
	const s = await setup(), data = input();
	setFilesBound(false);
	try { await assert.rejects(upload(s, data), error => error.code === "unavailable"); } finally { setFilesBound(true); }
	const pending = await m.Asset.findOne({ accountId: s.user.accountId, bookingId: s.booking._id }).lean();
	assert.equal(pending.status, "uploading"); assert.ok(pending.key);
	const ready = await upload(s, data); assert.equal(ready.id, String(pending._id));
	await m.assets.removeSponsorshipAsset({ account: s.user.account, bookingId: s.booking._id, assetId: ready.id });
	assert.equal(files.has(pending.key), false); assert.equal((await m.Booking.findOne({ accountId: s.user.accountId, _id: s.booking._id }).lean()).assetUploads.length, 0);
});
