import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { anonymous, as, callApi, form, platformEmails, startTestApp } from "./helpers/app.mjs";
import { api, installFakeStripe } from "./helpers/shop.mjs";
import { sponsorCreative, sponsorRequest, sponsorshipModels, sponsorshipSeller } from "./helpers/sponsorships.mjs";
let app, m, fake;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKxkAAAAASUVORK5CYII=";
before(async () => { app = await startTestApp(); fake = installFakeStripe(); m = { ...(await sponsorshipModels()), actions: await import("../app/(app)/sponsorships/actions.js"), assets: await import("../lib/sponsorship-assets.js"), uploadRoute: await import("../app/api/sponsorship-assets/route.js"), publicAsset: await import("../app/sponsor-assets/[id]/[signature]/route.js"), keys: await import("../app/(app)/api-keys/actions.js"), email: await import("../lib/sponsorship-email.js") }; });
after(() => app?.stop());
async function setup() { const s = await sponsorshipSeller(m, fake), request = await sponsorRequest(m, s); const verified = await m.bookings.verifySponsorshipRequest(request.token); return { ...s, booking: verified.booking, token: new URL(verified.managerUrl).searchParams.get("token") }; }
test("sponsor REST output is schema-valid and scoped, without buyer capabilities or invoice URLs on reads", async () => {
	const s = await setup();
	for (const path of [`/newsletters/${s.newsletter._id}/sponsorships/settings`, `/sponsorships/placements?newsletter=${s.newsletter._id}`, `/sponsorships/slots?newsletter=${s.newsletter._id}`, `/sponsorships/bookings?newsletter=${s.newsletter._id}`, `/sponsorships/bookings/${s.booking._id}`, `/sponsorships/bookings/${s.booking._id}/assets`, `/sponsorships/bookings/${s.booking._id}/report`]) {
		const response = await api(s.user, "GET", path); assert.equal(response.status, 200);
		assert.doesNotMatch(JSON.stringify(response.body), /managerVersion|verificationVersion|invoiceLease|stripeCustomerId|hostedUrl|token=/);
	}
	const other = await setup(); assert.equal((await api(other.user, "GET", `/sponsorships/bookings/${s.booking._id}`)).status, 404);
});
test("an agent cannot approve creative, draft keys cannot reserve or invoice, and invoice email needs its own explicit send", async () => {
	const s = await setup();
	const creative = await api(s.user, "PATCH", `/sponsorships/bookings/${s.booking._id}/creative`, { creative: sponsorCreative }); assert.equal(creative.status, 200);
	assert.equal((await api(s.user, "POST", `/sponsorships/bookings/${s.booking._id}/approve`, { expectedHash: creative.body.creativeHash })).status, 404);
	const drafts = await as(s.user, () => m.keys.createApiKey(null, form({ name: "Drafts", level: "drafts" })));
	for (const path of ["accept", "invoice", "invoice/refresh", "cancel"]) assert.equal((await callApi("POST", `/api/v1/sponsorships/bookings/${s.booking._id}/${path}`, { key: drafts.key, body: {} })).status, 403);
	const approved = await as(s.user, () => m.actions.approveCreative(null, form({ id: s.booking._id, expectedHash: creative.body.creativeHash }))); assert.equal(approved.ok, true);
	assert.equal((await api(s.user, "POST", `/sponsorships/bookings/${s.booking._id}/accept`, {})).status, 200);
	const before = platformEmails.length;
	const invoice = await api(s.user, "POST", `/sponsorships/bookings/${s.booking._id}/invoice`, {}); assert.equal(invoice.status, 200); assert.equal(platformEmails.length, before);
	const emailed = await api(s.user, "POST", `/sponsorships/bookings/${s.booking._id}/invoice/email`, {}); assert.equal(emailed.status, 200); assert.equal(emailed.body.sent, true);
	assert.equal(await m.Contact.countDocuments({ accountId: s.user.accountId }), 0);
});
test("raw upload authenticates before reading bytes, checks sponsor scope and streams within 5 MiB", async () => {
	const s = await setup();
	const req = (extra = {}, body = Buffer.from(PNG, "base64")) => new Request("https://flockstack.io/api/sponsorship-assets", { method: "POST", headers: { "x-booking-id": String(s.booking._id), "x-file-name": "example.png", "x-external-id": randomUUID(), "x-publication-consent": "true", ...extra }, body });
	assert.equal((await anonymous(() => m.uploadRoute.POST(req()))).status, 403);
	assert.equal((await as(s.user, () => m.uploadRoute.POST(req({ "sec-fetch-site": "same-site" })))).status, 403);
	const owner = await as(s.user, () => m.uploadRoute.POST(req({ "sec-fetch-site": "same-origin" }))); assert.equal(owner.status, 200);
	const buyer = await anonymous(() => m.uploadRoute.POST(req({ "x-sponsor-token": s.token }))); assert.equal(buyer.status, 200);
	const wrong = await anonymous(() => m.uploadRoute.POST(req({ "x-sponsor-token": s.token, "x-booking-id": "f".repeat(24) }))); assert.equal(wrong.status, 404);
	let canceled = false;
	const oversized = new Request("https://flockstack.io/api/sponsorship-assets", { method: "POST", headers: { "x-sponsor-token": s.token, "x-booking-id": String(s.booking._id) }, body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1)); }, cancel() { canceled = true; } }), duplex: "half" });
	assert.equal((await anonymous(() => m.uploadRoute.POST(oversized))).status, 413); assert.equal(canceled, true);
});
test("public image route requires approval and a valid signature, and does not expose an original filename", async () => {
	const s = await setup();
	const asset = await m.assets.uploadSponsorshipAsset({ account: s.user.account, bookingId: s.booking._id, input: { base64: PNG, fileName: "private-name.png", externalId: randomUUID(), publicationConsent: true } });
	const get = signature => m.publicAsset.GET(new Request("https://flockstack.io/sponsor-assets/x/x"), { params: Promise.resolve({ id: asset.id, signature }) });
	assert.equal((await get("a".repeat(43))).status, 404);
	const edited = await m.bookings.updateSponsorshipCreative({ account: s.user.account, bookingId: s.booking._id, input: { ...sponsorCreative, assetId: asset.id } });
	await m.bookings.approveSponsorshipCreative({ account: s.user.account, bookingId: s.booking._id, expectedHash: edited.creativeHash, actorId: s.user.account.ownerId });
	const current = await m.assets.readSponsorshipAsset({ account: s.user.account, bookingId: s.booking._id, assetId: asset.id });
	const response = await get(new URL(current.publicUrl).pathname.split("/").at(-1));
	assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "public, max-age=300"); assert.equal(response.headers.get("content-disposition"), null); assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(PNG, "base64"));
});
