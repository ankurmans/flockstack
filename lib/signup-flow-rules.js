export const SIGNUP_FLOW_TYPES = ["survey", "upsell", "recommendations"];
export const MAX_SIGNUP_FLOW_STEPS = 3;

export function getSignupFlowProblem(flow) {
	if (!Array.isArray(flow) || flow.length > MAX_SIGNUP_FLOW_STEPS) return "Choose up to three signup steps.";
	const seen = new Set();
	for (const step of flow) {
		if (!SIGNUP_FLOW_TYPES.includes(step?.type)) return "Choose a survey, paid-subscription offer or recommendations step.";
		if (seen.has(step.type)) return "Each kind of signup step can appear once.";
		seen.add(step.type);
		if (step.type === "survey" && !/^[a-f0-9]{24}$/.test(step.surveyId ?? "")) return "Choose a survey for the survey step.";
	}
	return null;
}
