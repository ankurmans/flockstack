import "server-only";
import { scoped } from "@/lib/account-scope";
import { getArchiveUrls, getLinkBaseUrl } from "@/lib/archive-hosts";
import { verifyContactToken } from "@/lib/contact-token";
import { findPublicForm } from "@/lib/forms";
import { getShopPayments } from "@/lib/archive-data";
import { getReaderStep } from "@/lib/recommendations";
import { createSubscriberToken } from "@/lib/subscriber-links";
import { isPaidContact } from "@/lib/tiers";
import Contact from "@/models/Contact";
import Survey from "@/models/Survey";

import { FLOW_KEY, SIGNUP_FLOW_MAX_AGE_MS, getSignupFlowUrl } from "@/lib/signup-flow-links";

export async function readSignupFlow({ formId, step = "0", token, now = Date.now() }) {
	if (!/^[a-f0-9]{24}$/.test(formId ?? "") || !/^[0-3]$/.test(String(step))) return null;
	const found = await findPublicForm(formId);
	if (!found || !found.form.flow?.length) return null;
	const { form, newsletter } = found;
	const reference = token ? verifyContactToken(token, { info: FLOW_KEY, maxAgeMs: SIGNUP_FLOW_MAX_AGE_MS, now }) : null;
	if (token && (!reference || reference.newsletterId !== String(newsletter._id))) return null;
	const contact = reference && await Contact.findOne(scoped(newsletter.accountId, { _id: reference.contactId, newsletterId: newsletter._id, status: { $in: ["active", "pending"] } })).lean();
	if (reference && !contact) return null;
	const index = Number(step);
	const current = form.flow[index];
	const finishUrl = form.redirectUrl || (newsletter.archiveEnabled ? getArchiveUrls(newsletter).siteIndex : `${getLinkBaseUrl(newsletter)}/embed/${form._id}?done=1`);
	const nextUrl = index + 1 < form.flow.length ? getSignupFlowUrl({ form, newsletter, step: index + 1, token }) : finishUrl;
	const result = { newsletterName: newsletter.name, language: newsletter.language ?? "en", isPending: contact?.status === "pending", index, total: form.flow.length, type: current?.type ?? "done", nextUrl, finishUrl };
	if (current?.type === "survey") {
		const survey = await Survey.findOne(scoped(newsletter.accountId, { _id: current.surveyId, newsletterId: newsletter._id, closed: { $ne: true } })).lean();
		if (survey) result.survey = { id: String(survey._id), title: survey.title, intro: survey.intro ?? "", questions: survey.questions, token: contact ? createSubscriberToken("survey", { contactId: contact._id, newsletterId: newsletter._id }) : null };
	}
	if (current?.type === "upsell" && newsletter.archiveEnabled && newsletter.paidTier?.enabled && !isPaidContact(contact)) {
		const payments = await getShopPayments(newsletter);
		if (payments.ready) result.upgradeUrl = getArchiveUrls(newsletter).subscribe;
	}
	if (current?.type === "recommendations" && contact?.status === "active") result.recommendations = await getReaderStep({ newsletter, contact });
	return result;
}
