import { TRIAGE_QUESTIONS, triagePrompt, triageTypeSafe } from "./prompts.js";

// Triage (docs/BRIEFINGS-DESIGN.md, Ranking): Jev's four scores for every story on the shortlist, from 0 to 1, in one call: one
// System One request with a Score question per story and feature, or one JSON call to the triage model without a TypeSafe key.
export const JEV_FEATURES = Object.keys(TRIAGE_QUESTIONS);

function unit(value, top) {
	return Number.isFinite(value) ? Math.round(Math.min(1, Math.max(0, value / top)) * 1000) / 1000 : null;
}

export async function scoreStories({ briefing, stories, recent, key, model, models }) {
	if (key.provider === "typesafe") {
		const { state, questions } = triageTypeSafe({ briefing, stories, recent });
		const { answers } = await models.typesafe({ key, model, step: "triage", state, questions });
		return Object.fromEntries(
			stories.map((story) => [story.id, Object.fromEntries(JEV_FEATURES.map((name) => [name, unit(answers?.[`${story.id}_${name}`]?.score, TRIAGE_QUESTIONS[name].criteria.length - 1)]))])
		);
	}
	const { system, user, maxTokens } = triagePrompt({ briefing, stories, recent });
	const { json } = await models.text({ key, model, step: "triage", system, user, json: true, maxTokens, temperature: 0 });
	const scores = json?.scores ?? {};
	return Object.fromEntries(stories.map((story) => [story.id, Object.fromEntries(JEV_FEATURES.map((name) => [name, unit(Number(scores?.[story.id]?.[name]), 100)]))]));
}

// What a triage call over these stories would be sent, for sizing the shortlist to the step's share before calling.
export function triageInputChars({ briefing, stories, recent, key }) {
	if (key.provider === "typesafe") return JSON.stringify(triageTypeSafe({ briefing, stories, recent })).length;
	const { system, user } = triagePrompt({ briefing, stories, recent });
	return system.length + user.length;
}

export function triageMaxTokens({ briefing, stories, recent, key }) {
	return key.provider === "typesafe" ? 0 : triagePrompt({ briefing, stories, recent }).maxTokens;
}

// Full stories, then brief items, from stories already scored 0 to 100 and sorted best first. Full: the ones over minScore, at
// most maxFull. Brief: the next ones over three quarters of minScore, at most briefItems.
export function pickStories(scored, { minScore, minFull, maxFull, briefItems }) {
	const full = scored.filter((story) => story.score >= minScore).slice(0, maxFull);
	const rest = scored.filter((story) => !full.includes(story) && story.score >= minScore * 0.75).slice(0, briefItems);
	return { full: full.map((story) => ({ ...story, kind: "full" })), brief: rest.map((story) => ({ ...story, kind: "brief" })), short: full.length < minFull };
}
