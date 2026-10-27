import { getCurrentAccount } from "@/lib/auth";
import { getErrorStatus, toActionError } from "@/lib/actions/errors";
import { runAction } from "@/lib/actions/run-action";
import { readSponsorshipContext } from "@/lib/sponsorship-bookings";
import { uploadSponsorshipAsset } from "@/lib/sponsorship-assets";
import { SPONSOR_LIMITS } from "@/lib/sponsorship-rules";

const headers = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };
const json = (value, status = 200) => Response.json(value, { status, headers });

async function readBody(request) {
	if (Number(request.headers.get("content-length")) > SPONSOR_LIMITS.assetBytes || !request.body) return null;
	const reader = request.body.getReader(), parts = []; let length = 0;
	try {
		while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > SPONSOR_LIMITS.assetBytes) { await reader.cancel(); return null; } parts.push(value); }
	} finally { reader.releaseLock(); }
	return Buffer.concat(parts, length);
}

export async function POST(request) {
	try {
		const token = request.headers.get("x-sponsor-token");
		const context = token ? await readSponsorshipContext(token) : null;
		if (!token && request.headers.get("sec-fetch-site") !== "same-origin") return json({ error: "Forbidden" }, 403);
		const current = context ? null : await getCurrentAccount();
		if (!context && !current) return json({ error: "Unauthorized" }, 401);
		const bookingId = request.headers.get("x-booking-id");
		if (context && String(context.booking._id) !== bookingId) return json({ error: "Sponsor image not found" }, 404);
		const bytes = await readBody(request);
		if (!bytes) return json({ error: "Use an image up to 5 MiB" }, 413);
		let fileName; try { fileName = decodeURIComponent(request.headers.get("x-file-name") ?? "sponsor"); } catch { return json({ error: "Invalid filename" }, 400); }
		const input = { base64: bytes.toString("base64"), fileName: fileName.slice(0, 150), externalId: request.headers.get("x-external-id"), publicationConsent: request.headers.get("x-publication-consent") === "true" };
		const output = context ? await uploadSponsorshipAsset({ account: context.account, bookingId, input, managerVersion: context.reference.version }) : await runAction("upload_sponsorship_asset", { ...current, via: "dashboard", input: { id: bookingId, ...input } });
		return json(output);
	} catch (error) { const failure = toActionError(error); return json({ error: failure.message, code: failure.code }, getErrorStatus(failure.code)); }
}
