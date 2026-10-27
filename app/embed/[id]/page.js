import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { after } from "next/server";
import FormEmbed from "@/components/FormEmbed";
import { UTM_KEYS } from "@/lib/attribution";
import { isLikelyBot } from "@/lib/bots";
import { FORM_ERRORS, getFormButtonText, getFormColors, getFormMessage } from "@/lib/form-rules";
import { countFormView, findPublicForm } from "@/lib/forms";
import { getClientIp } from "@/lib/rate-limit";
import CustomField from "@/models/CustomField";

// Counted when it loads, so a page that is cached would not be; it also takes a different form for every id.
export const dynamic = "force-dynamic";

export const metadata = {
	title: "Subscribe",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

const first = (value) => (Array.isArray(value) ? value[0] : value);

// A signup form of a newsletter, for other sites to frame (lib/embed-script.js does it) and to link to. Its views are
// counted here, on the server: no script of ours runs on the site that shows it.
export default async function EmbedPage({ params, searchParams }) {
	const [{ id }, query] = await Promise.all([params, searchParams]);
	const found = await findPublicForm(id);
	if (!found) notFound();
	const { form, newsletter } = found;

	const requestHeaders = await headers();
	if (!isLikelyBot(requestHeaders.get("user-agent"))) {
		const ip = getClientIp(requestHeaders);
		after(() => countFormView(form, { ip }).catch((error) => console.error(`[forms] View of ${form._id} not counted:`, error.message)));
	}

	const keys = form.fields ?? [];
	const definitions = keys.length > 0 ? await CustomField.find({ accountId: form.accountId, newsletterId: form.newsletterId, key: { $in: keys } }).lean() : [];
	const fields = keys
		.map((key) => definitions.find((definition) => definition.key === key))
		.filter(Boolean)
		.map(({ key, label, type, options, multiple }) => ({ key, label, type, options: options ?? [], multiple: Boolean(multiple) }));
	const utm = Object.fromEntries(UTM_KEYS.map((key) => [`utm_${key}`, first(query[`utm_${key}`])]).filter(([, value]) => typeof value === "string"));
	const done = first(query.done);
	const errorCode = first(query.error);

	return (
		<>
			<style>{"html,body{background:transparent!important;min-height:0!important;color-scheme:light!important}"}</style>
			<FormEmbed
				formId={String(form._id)}
				fields={fields}
				buttonText={getFormButtonText(form)}
				colors={getFormColors(form, newsletter)}
				message={getFormMessage(form)}
				parent={typeof query.parent === "string" ? query.parent : ""}
				utm={utm}
				state={done === "pending" ? "pending" : done === "held" ? "held" : done === "1" ? "done" : ""}
				errorText={Object.hasOwn(FORM_ERRORS, errorCode ?? "") ? FORM_ERRORS[errorCode] : ""}
			/>
		</>
	);
}
