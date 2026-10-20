import "server-only";
import { isValidObjectId } from "@/lib/docdb";
import { sendAlert } from "@/lib/alerts";
import {
	CUSTOM_EMAIL_RANGES,
	CUSTOM_NEEDS,
	CUSTOM_PLATFORMS,
	CUSTOM_REPLY_WITHIN,
	CUSTOM_RETENTION_YEARS,
	CUSTOM_SUBSCRIBER_RANGES,
	CUSTOM_TIMELINES,
	choiceLabel,
} from "@/lib/custom-choices";
import { readNotes, readStatus } from "@/lib/custom-rules";
import { connectDb } from "@/lib/db";
import { canSendPlatformEmail, sendPlatformEmail } from "@/lib/platform-email";
import { getRegion } from "@/lib/region";
import CustomRequest from "@/models/CustomRequest";

// Newest requests the admin page reads: far more than a lead form gets, and the tally counts every one of them.
const ADMIN_LIMIT = 2000;

export async function createCustomRequest(value) {
	await connectDb();
	return (await CustomRequest.create({ ...value, region: getRegion(), status: "new" })).toObject();
}

export async function listCustomRequests() {
	await connectDb();
	return CustomRequest.find({}).sort({ createdAt: -1, _id: -1 }).limit(ADMIN_LIMIT).lean();
}

export async function countNewCustomRequests() {
	await connectDb();
	return CustomRequest.countDocuments({ status: "new" });
}

// null when there is no such request.
export async function updateCustomRequest(id, { status, notes }) {
	if (!isValidObjectId(id)) return null;
	const set = {};
	const newStatus = readStatus(status);
	if (!newStatus) return null;
	set.status = newStatus;
	set.notes = readNotes(notes);
	await connectDb();
	const result = await CustomRequest.updateOne({ _id: id }, { $set: set });
	return result.matchedCount > 0 ? set : null;
}

export async function deleteCustomRequest(id) {
	if (!isValidObjectId(id)) return false;
	await connectDb();
	return (await CustomRequest.deleteOne({ _id: id })).deletedCount > 0;
}

// Requests untouched for CUSTOM_RETENTION_YEARS (what the privacy policy says). Run by the hourly cron.
export async function purgeCustomRequests(now = new Date()) {
	await connectDb();
	const cutoff = new Date(now);
	cutoff.setUTCFullYear(cutoff.getUTCFullYear() - CUSTOM_RETENTION_YEARS);
	return (await CustomRequest.deleteMany({ updatedAt: { $lt: cutoff } })).deletedCount ?? 0;
}

// What the admins read in the alert: how big and what they would need. Never the person's name or address: alerts are
// logged, and the request itself is one click away.
export function describeCustomRequest(request) {
	const needs = request.needs.map((id) => choiceLabel(CUSTOM_NEEDS, id)).filter(Boolean);
	return [
		`${request.company}${request.platform ? `, on ${choiceLabel(CUSTOM_PLATFORMS, request.platform)}` : ""}.`,
		request.subscribers && `Subscribers: ${choiceLabel(CUSTOM_SUBSCRIBER_RANGES, request.subscribers)}.`,
		request.emailsPerMonth && `Emails a month: ${choiceLabel(CUSTOM_EMAIL_RANGES, request.emailsPerMonth)}.`,
		needs.length > 0 && `Would need: ${needs.join(", ")}.`,
		request.timeline && `Timeline: ${choiceLabel(CUSTOM_TIMELINES, request.timeline)}.`,
	]
		.filter(Boolean)
		.join(" ");
}

export function getConfirmationText(request) {
	const first = request.name.split(" ")[0];
	return [
		`Hi ${first},`,
		"",
		`Thanks for telling us about ${request.company}. A person on the FlockStack team will reply to you personally within ${CUSTOM_REPLY_WITHIN}.`,
		"",
		"There's nothing else to do. If you want to add something, reply to this email.",
		"",
		"FlockStack",
	].join("\n");
}

// The admins' alert and the requester's confirmation, each on its own: one failing never stops the other, nor the request,
// which is already saved.
export async function notifyCustomRequest(request) {
	const results = await Promise.allSettled([
		sendAlert({
			key: `custom-request:${request._id}`,
			title: "New Custom plan request",
			detail: describeCustomRequest(request),
			action: "Reply personally, then set its status.",
			path: "/admin/custom",
			cooldownMinutes: 1,
		}),
		canSendPlatformEmail() &&
			sendPlatformEmail({ to: request.email, subject: "We got your note about a Custom plan", text: getConfirmationText(request) }),
	]);
	for (const result of results) if (result.status === "rejected") console.error("[custom] Could not send:", result.reason?.message);
}
