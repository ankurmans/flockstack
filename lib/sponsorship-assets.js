import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { isSignedWithAppKey, signWithAppKey } from "@/lib/app-keys";
import { actionError } from "@/lib/actions/errors";
import { getAppUrl } from "@/lib/config";
import { decodeBase64Image, detectImageType } from "@/lib/image-files";
import { deletePrivateFiles, getPrivateFile, putPrivateFile, safeFileName } from "@/lib/private-files";
import { currentSponsorshipAccount } from "@/lib/sponsorship-bookings";
import { findSponsorshipRecord } from "@/lib/sponsorship-inventory";
import { SPONSOR_LIMITS } from "@/lib/sponsorship-rules";
import { isObjectIdString } from "@/lib/validation";
import SponsorshipAsset from "@/models/SponsorshipAsset";
import SponsorshipBooking from "@/models/SponsorshipBooking";

const ASSET_INFO = "flockstack-sponsorship-public-asset-v1";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const assetValue = asset => `${asset.accountId}:${asset.bookingId}:${asset._id}:${asset.sha256}`;
const prefix = asset => `accounts/${asset.accountId}/sponsorships/${asset.bookingId}/`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

async function reserveUpload(account, bookingId, externalId, managerVersion) {
	for (let attempt = 0; attempt < 8; attempt++) {
		const current = await findSponsorshipRecord(SponsorshipBooking, account, bookingId);
		if (!current.verifiedAt || current.status === "canceled" || current.campaignId || managerVersion !== undefined && managerVersion !== current.managerVersion) throw actionError("conflict", "This sponsorship can't accept an uploaded image");
		const uploads = current.assetUploads ?? [];
		if (uploads.includes(externalId)) return;
		if (uploads.length >= SPONSOR_LIMITS.assetsPerBooking) throw actionError("conflict", "A sponsorship can hold 5 uploaded images. Remove an unused private upload first.");
		const guard = current.revision ? { revision: current.revision } : { $or: [{ revision: 0 }, { revision: { $exists: false } }] };
		const result = await SponsorshipBooking.updateOne(scoped(account, { _id: current._id, ...guard }), { $set: { assetUploads: [...uploads, externalId] }, $inc: { revision: 1 } });
		if (result.matchedCount) return;
	}
	throw actionError("conflict", "These uploads changed. Refresh and try again.");
}

function dimensions(bytes, type) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (type === "png" && bytes.length >= 24 && String.fromCharCode(...bytes.subarray(12, 16)) === "IHDR") return [view.getUint32(16), view.getUint32(20)];
	if (type === "webp" && bytes.length >= 30) {
		const marker = String.fromCharCode(...bytes.subarray(12, 16));
		if (marker === "VP8X") return [1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)];
		if (marker === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
		if (marker === "VP8L" && bytes[20] === 0x2f) return [1 + bytes[21] + ((bytes[22] & 0x3f) << 8), 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10)];
	}
	if (type === "jpg") {
		for (let offset = 2; offset + 8 < bytes.length;) {
			if (bytes[offset] !== 0xff) return null;
			const marker = bytes[offset + 1], size = view.getUint16(offset + 2);
			if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return [view.getUint16(offset + 7), view.getUint16(offset + 5)];
			if (size < 2) return null;
			offset += size + 2;
		}
	}
	return null;
}

function readImage(base64) {
	if (typeof base64 !== "string" || base64.length > Math.ceil(SPONSOR_LIMITS.assetBytes / 3) * 4 + 200) throw actionError("validation_failed", "Use a PNG, JPEG or WebP image up to 5 MiB");
	const bytes = decodeBase64Image(base64), type = bytes && detectImageType(bytes);
	if (!bytes?.length || bytes.length > SPONSOR_LIMITS.assetBytes || !type || !["png", "jpg", "webp"].includes(type.extension)) throw actionError("validation_failed", "Use a PNG, JPEG or WebP image up to 5 MiB");
	const size = dimensions(bytes, type.extension);
	if (!size || size.some(value => value < 1 || value > 8192) || size[0] * size[1] > 32000000) throw actionError("validation_failed", "Use an image up to 8192 pixels per side and 32 megapixels");
	return { bytes, type, sha256: digest(bytes) };
}

export function sponsorshipAssetOutput(asset) {
	return { id: String(asset._id), bookingId: String(asset.bookingId), fileName: asset.fileName, contentType: asset.contentType, bytes: asset.bytes, status: asset.status, publicAt: asset.publicAt ? new Date(asset.publicAt).toISOString() : null, publicUrl: asset.status === "ready" && asset.publicAt ? getPublicSponsorshipAssetUrl(asset) : null };
}

export function getPublicSponsorshipAssetUrl(asset) {
	if (!asset.publicAt || asset.status !== "ready") throw actionError("conflict", "This sponsor image hasn't been approved for public use");
	return `${getAppUrl()}/sponsor-assets/${asset._id}/${signWithAppKey(ASSET_INFO, assetValue(asset))}`;
}

export async function uploadSponsorshipAsset({ account, bookingId, input, managerVersion }) {
	account = await currentSponsorshipAccount(account, { change: true });
	const booking = await findSponsorshipRecord(SponsorshipBooking, account, bookingId);
	if (!booking.verifiedAt || booking.status === "canceled" || booking.campaignId || managerVersion !== undefined && managerVersion !== booking.managerVersion) throw actionError("conflict", "This sponsorship can't accept an uploaded image");
	if (input.publicationConsent !== true || !uuid.test(input.externalId ?? "")) throw actionError("validation_failed", "Agree that the image may be publicly served if the creator approves it, and use a stable upload UUID");
	const { bytes, type, sha256 } = readImage(input.base64);
	let asset = await SponsorshipAsset.findOne(scoped(account, { bookingId: booking._id, externalId: input.externalId })).lean();
	if (asset && (asset.sha256 !== sha256 || asset.status === "deleted")) throw actionError("conflict", "This upload ID belongs to another image or a deleted upload");
	if (!asset) {
		await reserveUpload(account, booking._id, input.externalId, managerVersion);
		try {
			const name = safeFileName(input.fileName).replace(/\.[^.]*$/, "") || "sponsor";
			asset = (await SponsorshipAsset.create({ accountId: account._id, newsletterId: booking.newsletterId, bookingId: booking._id, externalId: input.externalId, key: `accounts/${account._id}/sponsorships/${booking._id}/${randomUUID()}.${type.extension}`, fileName: `${name.slice(0, 110)}.${type.extension}`, contentType: type.contentType, bytes: bytes.length, sha256, publicationConsentAt: new Date() })).toObject();
		} catch (error) {
			if (error?.code !== 11000) throw error;
			asset = await SponsorshipAsset.findOne(scoped(account, { bookingId: booking._id, externalId: input.externalId })).lean();
			if (!asset || asset.sha256 !== sha256 || asset.status === "deleted") throw actionError("conflict", "This upload ID belongs to another image");
		}
	}
	if (asset.status === "ready") return sponsorshipAssetOutput(asset);
	// The key is durable before R2 is touched. A failed/unknown put remains tracked for retries and account purge.
	try { await putPrivateFile(asset.key, bytes, asset.contentType); }
	catch { throw actionError("unavailable", "Private sponsor image storage isn't available. Retry this upload with the same ID."); }
	const ready = await SponsorshipAsset.findOneAndUpdate(scoped(account, { _id: asset._id, sha256, status: "uploading" }), { $set: { status: "ready" } }, { new: true }).lean();
	if (!ready) {
		const current = await SponsorshipAsset.findOne(scoped(account, { _id: asset._id })).lean();
		if (current?.status === "ready" && current.sha256 === sha256) return sponsorshipAssetOutput(current);
		await deletePrivateFiles([asset.key]);
		throw actionError("conflict", "This upload was removed before it finished");
	}
	return sponsorshipAssetOutput(ready);
}

async function readAssetBytes(asset) {
	if (asset.status !== "ready" || !asset.key.startsWith(prefix(asset))) throw actionError("not_found", "Sponsor image not found");
	const file = await getPrivateFile(asset.key);
	if (!file || file.size !== asset.bytes || file.size > SPONSOR_LIMITS.assetBytes) throw actionError("not_found", "Sponsor image not found");
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) throw actionError("conflict", "This sponsor image changed in storage");
	return bytes;
}

export async function readSponsorshipAsset({ account, bookingId, assetId, includeContent = false, managerVersion }) {
	await currentSponsorshipAccount(account);
	const booking = await findSponsorshipRecord(SponsorshipBooking, account, bookingId);
	if (managerVersion !== undefined && (!booking.verifiedAt || booking.managerVersion !== managerVersion)) throw actionError("not_found", "Sponsor image not found");
	const asset = await SponsorshipAsset.findOne(scoped(account, { _id: assetId, bookingId: booking._id, newsletterId: booking.newsletterId, status: { $ne: "deleted" } })).lean();
	if (!asset) throw actionError("not_found", "Sponsor image not found");
	return { ...sponsorshipAssetOutput(asset), ...(includeContent && { dataUrl: `data:${asset.contentType};base64,${Buffer.from(await readAssetBytes(asset)).toString("base64")}` }) };
}

export async function readPublicSponsorshipAsset(id, signature) {
	if (!isObjectIdString(id) || !/^[A-Za-z0-9_-]{43}$/.test(signature ?? "")) return null;
	const asset = await SponsorshipAsset.findOne({ _id: id }).setOptions({ crossAccount: true }).lean();
	if (!asset?.publicAt || asset.status !== "ready" || !isSignedWithAppKey(ASSET_INFO, assetValue(asset), signature)) return null;
	try { await currentSponsorshipAccount(asset.accountId); }
	catch (error) { if (error.code === "not_found") return null; throw error; }
	return { bytes: await readAssetBytes(asset), contentType: asset.contentType };
}

export async function removeSponsorshipAsset({ account, bookingId, assetId, managerVersion }) {
	await currentSponsorshipAccount(account, { change: true });
	const booking = await findSponsorshipRecord(SponsorshipBooking, account, bookingId);
	if (managerVersion !== undefined && booking.managerVersion !== managerVersion) throw actionError("not_found", "Sponsor image not found");
	if (String(booking.creative?.assetId) === String(assetId)) throw actionError("conflict", "Choose a different creative image before removing this upload");
	const asset = await SponsorshipAsset.findOneAndUpdate(scoped(account, { _id: assetId, bookingId: booking._id, publicAt: null }), { $set: { status: "deleted" } }, { new: true }).lean();
	if (!asset) throw actionError("conflict", "An approved public image stays available for sent issues until account deletion");
	await deletePrivateFiles([asset.key]);
	await SponsorshipBooking.updateOne(scoped(account, { _id: booking._id }), { $pull: { assetUploads: asset.externalId }, $inc: { revision: 1 } });
	return { id: String(asset._id), deleted: true };
}
