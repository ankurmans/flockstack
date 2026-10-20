import { NextResponse } from "next/server";
import { toReferrerHost, UTM_KEYS } from "@/lib/attribution";
import { getNewsletterHost } from "@/lib/archive-hosts";
import { getAppHost } from "@/lib/config";
import { FORM_ERRORS, getErrorCode, getFormMessage } from "@/lib/form-rules";
import { countFormSignup, findPublicForm } from "@/lib/forms";
import { getClientIp } from "@/lib/rate-limit";
import { signUp } from "@/lib/signup";

export const dynamic = "force-dynamic";

// Sites post here from a browser they don't control, with no cookie of ours and no key: anyone can, which is what a signup
// form is. So this reads no cookie and sets none, answers every origin without credentials, and leans on what protects
// the other signups: the honeypot, 5 signups per visitor in 10 minutes, the newsletter's confirmation email and suppression.
const MAX_BODY_BYTES = 20_000;
const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Accept",
	"Access-Control-Max-Age": "86400",
};
const ALLOWED_FIELD = /^(email|website|page|utm_[a-z]+|field_[a-z][a-z0-9_]{0,29})$/;

function json(body, status = 200) {
	return NextResponse.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store" } });
}

export function OPTIONS() {
	return new Response(null, { status: 204, headers: CORS });
}

// Only what a form has: a script can't add the hidden fields (rec, ref, acq) that mean something to the website's own form.
async function readBody(request) {
	const type = request.headers.get("content-type") ?? "";
	const data = new FormData();
	if (type.includes("application/json")) {
		const body = await request.json().catch(() => null);
		for (const [name, value] of Object.entries(body && typeof body === "object" ? body : {})) {
			if (!ALLOWED_FIELD.test(name)) continue;
			for (const item of Array.isArray(value) ? value : [value]) if (["string", "number", "boolean"].includes(typeof item)) data.append(name, String(item));
		}
		return data;
	}
	const posted = await request.formData().catch(() => new FormData());
	for (const [name, value] of posted.entries()) if (ALLOWED_FIELD.test(name) && typeof value === "string") data.append(name, value);
	return data;
}

// A plain HTML form posts here and lands back on the form's own page, or on the page the owner chose.
function leave(request, location) {
	return new Response(null, { status: 303, headers: { Location: new URL(location, request.url).toString(), "Cache-Control": "no-store" } });
}

export async function POST(request, { params }) {
	const { id } = await params;
	const wantsJson = (request.headers.get("content-type") ?? "").includes("application/json") || (request.headers.get("accept") ?? "").includes("application/json");
	const found = await findPublicForm(id);
	if (!found) return wantsJson ? json({ ok: false, error: "This form is gone." }, 404) : new Response("Not found", { status: 404 });
	const { form, newsletter } = found;
	if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json({ ok: false, error: FORM_ERRORS.failed }, 413);

	const data = await readBody(request);
	data.set("newsletter", newsletter.slug);
	const utm = Object.fromEntries(UTM_KEYS.map((key) => [key, data.get(`utm_${key}`)]).filter(([, value]) => value));
	const ownHosts = [getNewsletterHost(newsletter), getAppHost()];
	// The page that holds the form: what it says it is (the frame's script), else the browser's Referer.
	const referrer = toReferrerHost(data.get("page"), ownHosts) ?? toReferrerHost(request.headers.get("referer"), ownHosts) ?? "";

	const result = await signUp({
		formData: data,
		ip: getClientIp(request.headers),
		headers: request.headers,
		source: `form:${form._id}`,
		utm: Object.keys(utm).length > 0 ? utm : null,
		referrer,
		fieldKeys: form.fields ?? [],
		requireWebsite: false,
		onSignup: ({ created }) => (created ? countFormSignup(form) : undefined),
	});
	const pageUrl = `/embed/${form._id}`;
	if (result.error) {
		const code = getErrorCode(result.error);
		return wantsJson ? json({ ok: false, error: result.error }, code === "limit" ? 429 : 400) : leave(request, `${pageUrl}?error=${code}`);
	}
	const redirectUrl = form.redirectUrl || null;
	if (!wantsJson) return leave(request, redirectUrl ?? `${pageUrl}?done=${result.pending ? "pending" : "1"}`);
	return json({ ok: true, ...(result.pending && { pending: true }), message: getFormMessage(form), ...(redirectUrl && { redirectUrl }) });
}

// A form's address opened in a browser leads to the form.
export async function GET(request, { params }) {
	const { id } = await params;
	return leave(request, `/embed/${id}`);
}
