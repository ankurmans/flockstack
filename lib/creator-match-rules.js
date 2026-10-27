export const MATCH_WINDOW = 200;
export function normalizeTopics(values) {
	const topics = [...new Set(values.map((value) => value.trim().toLowerCase().replace(/\s+/g, " ")))];
	if (topics.length > 10 || topics.some((value) => value.length < 2 || value.length > 30 || !/^[\p{L}\p{N} &'-]+$/u.test(value))) return null;
	return topics;
}

export function rankCreator(source, target, recommendation = null) {
	const shared = source.topics.filter((topic) => target.topics.includes(topic));
	const sameLanguage = source.language === target.language;
	const sameSize = source.subscriberRange === target.subscriberRange;
	const historyPoints = recommendation?.status === "active" ? Math.min(5, Math.max(0, Number(recommendation.stats?.confirmed) || 0)) : 0;
	return {
		score: shared.length * 10 + (sameLanguage ? 2 : 0) + (sameSize ? 3 : 0) + historyPoints,
		reasons: [...(historyPoints ? ["Your recommendation previously brought confirmed subscribers"] : []), ...shared.map((topic) => `Shared topic: ${topic}`), ...(sameSize ? ["Same subscriber range"] : []), ...(sameLanguage ? ["Same language"] : [])],
	};
}
