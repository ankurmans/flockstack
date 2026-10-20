import "server-only";
import { scoped } from "@/lib/account-scope";
import { getLinkBaseUrl } from "@/lib/archive-hosts";
import { connectDb } from "@/lib/db";
import { FORM_ID_PATTERN } from "@/lib/form-rules";
import { isRateLimited } from "@/lib/rate-limit";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { shiftDateKey } from "@/lib/time-zone";
import Form from "@/models/Form";
import FormDay from "@/models/FormDay";

// A page load counts once; a client that loads one over and over stops counting.
const VIEWS_PER_VISITOR = { name: "form-views", limit: 60, window: "10 m", store: "memory" };

// Days are UTC, whatever the visitor's or the owner's time zone: a count is added to one row per form and day.
export function getDayKey(date = new Date()) {
	return date.toISOString().slice(0, 10);
}

// A form and its open newsletter, for the public pages: whatever the account. Null for an ID that isn't one, a form that
// is gone, and a newsletter whose account has no plan.
export async function findPublicForm(id) {
	const value = String(id ?? "").toLowerCase();
	if (!FORM_ID_PATTERN.test(value)) return null;
	await connectDb();
	const form = await Form.findOne({ _id: value }).setOptions({ crossAccount: true }).lean();
	const newsletter = form && (await findOpenNewsletter({ _id: form.newsletterId }));
	return newsletter ? { form, newsletter } : null;
}

export async function countFormView(form, { ip }) {
	if (await isRateLimited({ ...VIEWS_PER_VISITOR, key: `${form._id}:${ip}` })) return;
	await Promise.all([
		FormDay.updateOne(scoped(form.accountId, { formId: form._id, day: getDayKey() }), { $inc: { views: 1 } }, { upsert: true }),
		Form.updateOne(scoped(form.accountId, { _id: form._id }), { $inc: { views: 1 } }),
	]);
}

export async function countFormSignup(form) {
	await Promise.all([
		FormDay.updateOne(scoped(form.accountId, { formId: form._id, day: getDayKey() }), { $inc: { signups: 1 } }, { upsert: true }),
		Form.updateOne(scoped(form.accountId, { _id: form._id }), { $inc: { signups: 1 } }),
	]);
}

export function toConversion(signups, views) {
	return views > 0 ? Math.round(Math.min(signups / views, 1) * 10_000) / 10_000 : null;
}

// The last `days` days of a form, oldest first, a row for each.
export async function getFormDays(account, form, days = 30, now = new Date()) {
	const today = getDayKey(now);
	const keys = Array.from({ length: days }, (_, index) => shiftDateKey(today, index - days + 1));
	const rows = await FormDay.find(scoped(account, { formId: form._id, day: { $gte: keys[0], $lte: today } })).lean();
	const byDay = new Map(rows.map((row) => [row.day, row]));
	return keys.map((key) => ({ date: key, views: byDay.get(key)?.views ?? 0, signups: byDay.get(key)?.signups ?? 0 }));
}

function escapeAttribute(value) {
	return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function fieldInput({ key, label, type, options, multiple }) {
	const name = `field_${key}`;
	const title = escapeAttribute(label);
	if (type === "list") {
		const choices = (options ?? []).map((option) => `<option>${escapeAttribute(option)}</option>`).join("");
		return `  <select name="${name}"${multiple ? " multiple" : ""} aria-label="${title}">${multiple ? "" : '<option value="">' + title + "</option>"}${choices}</select>`;
	}
	if (type === "boolean") return `  <label><input type="checkbox" name="${name}" value="true"> ${title}</label>`;
	const inputType = { number: "number", date: "date", datetime: "datetime-local" }[type] ?? "text";
	return `  <input type="${inputType}" name="${name}" placeholder="${title}" aria-label="${title}">`;
}

// What the dashboard hands the owner: the hosted page, the one-line script, a plain iframe, and a plain HTML form that
// posts to the form's address (no script, no framing). definitions: the custom fields the form asks for, in order.
export function getEmbedCodes(newsletter, form, definitions = []) {
	const base = getLinkBaseUrl(newsletter);
	const id = String(form._id);
	const url = `${base}/embed/${id}`;
	const title = escapeAttribute(`Subscribe to ${newsletter.name}`);
	const button = escapeAttribute(form.buttonText?.trim() || "Subscribe");
	return {
		url,
		script: `<script async src="${base}/embed.js" data-flockstack-form="${id}"></script>`,
		iframe: `<iframe src="${url}" title="${title}" width="100%" height="140" style="border:0;color-scheme:light" loading="lazy"></iframe>`,
		html: [
			`<form action="${base}/f/${id}" method="post">`,
			'  <input type="email" name="email" placeholder="you@example.com" aria-label="Email" required>',
			...definitions.map(fieldInput),
			'  <input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-10000px">',
			`  <button type="submit">${button}</button>`,
			"</form>",
		].join("\n"),
	};
}
