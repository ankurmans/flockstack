import { TRIAGE_LEVELS, triagePrompt, triageTypeSafe } from "./prompts.js";

// Triage (docs/BRIEFINGS-DESIGN.md, The run, 4): every story scored 0 to 100 for the audience in one call, then the ones at or
// over minScore, best first, up to maxStories.
export async function scoreStories({ briefing, stories, key, model, models }) {
	if (key.provider === "typesafe") {
		const { state, questions } = triageTypeSafe({ briefing, stories });
		const { answers } = await models.typesafe({ key, model, step: "triage", state, questions });
		const top = TRIAGE_LEVELS.length - 1;
		return Object.fromEntries(stories.map((story) => [story.id, Number.isFinite(answers?.[story.id]?.score) ? Math.round((answers[story.id].score / top) * 100) : 0]));
	}
	const { system, user, maxTokens } = triagePrompt({ briefing, stories });
	const { json } = await models.text({ key, model, step: "triage", system, user, json: true, maxTokens, temperature: 0 });
	const scores = json?.scores ?? json ?? {};
	return Object.fromEntries(stories.map((story) => [story.id, Math.max(0, Math.min(100, Math.round(Number(scores[story.id]) || 0)))]));
}

export function pickStories(stories, scores, { minScore, maxStories }) {
	return stories
		.map((story) => ({ ...story, score: scores[story.id] ?? 0 }))
		.filter((story) => story.score >= minScore)
		.sort((a, b) => b.score - a.score || b.weight - a.weight)
		.slice(0, maxStories);
}
