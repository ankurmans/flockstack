"use server";

import { revalidatePath } from "next/cache";
import { runDashboardAction, toFormError } from "@/lib/actions/dashboard";

// The builder's survey: { title, intro, questions, afterSignup, onUnsubscribe, thankYou, closed }.
function readSurvey(values) {
	return {
		title: String(values?.title ?? ""),
		intro: values?.intro ? String(values.intro) : null,
		questions: (Array.isArray(values?.questions) ? values.questions : []).map((question) => ({
			...(question.id && { id: String(question.id) }),
			type: String(question.type ?? ""),
			label: String(question.label ?? ""),
			...(Array.isArray(question.options) && question.options.length > 0 && { options: question.options.map(String) }),
			required: question.required === true,
			fieldKey: question.fieldKey ? String(question.fieldKey) : null,
		})),
		afterSignup: values?.afterSignup === true,
		onUnsubscribe: values?.onUnsubscribe === true,
		thankYou: values?.thankYou ? String(values.thankYou) : null,
		closed: values?.closed === true,
	};
}

export async function createSurvey(newsletterId, values) {
	const { output, failure } = await runDashboardAction("create_survey", { newsletter: String(newsletterId ?? ""), ...readSurvey(values) });
	if (failure) return toFormError(failure);
	revalidatePath("/surveys");
	return { ok: true, id: output.id };
}

export async function updateSurvey(id, values) {
	const { failure } = await runDashboardAction("update_survey", { id: String(id ?? ""), ...readSurvey(values) });
	if (failure) return toFormError(failure);
	revalidatePath("/surveys");
	revalidatePath(`/surveys/${id}`);
	return { ok: true };
}

export async function deleteSurvey(id) {
	const { failure } = await runDashboardAction("delete_survey", { id: String(id ?? "") });
	if (failure) return toFormError(failure);
	revalidatePath("/surveys");
	return { ok: true };
}

export async function exportSurveyResponses(id) {
	const { output, failure } = await runDashboardAction("export_survey_responses", { id: String(id ?? "") });
	return failure ? toFormError(failure) : output;
}
