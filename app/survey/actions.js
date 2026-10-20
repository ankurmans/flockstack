"use server";

import { headers } from "next/headers";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { submitSurvey } from "@/lib/surveys";

// A subscriber's link answers once (again replaces it); readers without one are held back per address.
const PER_IP = { name: "survey-ip", limit: 10, window: "10 m" };

export async function answerSurvey(surveyId, token, source, _state, formData) {
	if (await isRateLimited({ ...PER_IP, key: getClientIp(await headers()) })) return { error: "Too many answers from your network. Try again in a few minutes." };
	const result = await submitSurvey({
		surveyId,
		token,
		source,
		read: (question) => (question.type === "multi_choice" ? formData.getAll(question.id) : formData.get(question.id)),
	});
	if (result.problem === "invalid") return { error: "This link doesn't work. Open it from the email again." };
	if (result.problem === "closed") return { error: "This survey is closed." };
	if (result.problem) return { error: result.problem };
	return { ok: true, thankYou: result.survey.thankYou || "Thanks, your answers are in." };
}
