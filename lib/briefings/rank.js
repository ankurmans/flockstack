// Ranking (docs/BRIEFINGS-DESIGN.md, Ranking). Each story has the same features, each from 0 to 1 (pastSim from -1 to 1). Until a
// briefing has MIN_VERDICTS of the owner's verdicts the score is a fixed weighted sum; from then on a small logistic regression
// fitted here on the verdicts' saved features sets the weights, refitted every run: L2-regularised, plain gradient descent from
// zero for a fixed number of steps, so the same verdicts always give the same weights. Trusted outlets and a publisher's record
// only ever add: their weights are held at zero or above, and their features are never negative.
export const FEATURES = ["relevance", "usefulness", "novelty", "primary", "exampleSim", "pastSim", "publisher", "trusted", "independent", "recency"];
export const FIXED_WEIGHTS = { relevance: 0.28, usefulness: 0.22, novelty: 0.08, primary: 0.05, exampleSim: 0.1, pastSim: 0.07, publisher: 0.05, trusted: 0.05, independent: 0.05, recency: 0.05 };
export const ADD_ONLY = ["publisher", "trusted"];
export const MIN_VERDICTS = 30;
export const FIT = { steps: 400, learningRate: 0.5, l2: 0.05 };
// The Jev features before triage has scored a story: neither for nor against it.
const UNSCORED = 0.5;

function clamp(value, low = 0, high = 1) {
	return Math.min(high, Math.max(low, Number.isFinite(value) ? value : 0));
}

function vector(features) {
	return FEATURES.map((name) => clamp(Number(features?.[name] ?? (["relevance", "usefulness", "novelty", "primary"].includes(name) ? UNSCORED : 0)), name === "pastSim" ? -1 : 0, 1));
}

function sigmoid(value) {
	return 1 / (1 + Math.exp(-value));
}

// { kind: "fitted", weights, bias, verdicts } from verdicts with features and both kinds of answer; null when there are too few.
export function fitModel(verdicts) {
	const rows = verdicts.filter((verdict) => verdict.features && (verdict.verdict === "keep" || verdict.verdict === "drop"));
	if (rows.length < MIN_VERDICTS) return null;
	const kept = rows.filter((row) => row.verdict === "keep").length;
	if (kept === 0 || kept === rows.length) return null;
	const xs = rows.map((row) => vector(row.features));
	const ys = rows.map((row) => (row.verdict === "keep" ? 1 : 0));
	const weights = new Array(FEATURES.length).fill(0);
	let bias = 0;
	for (let step = 0; step < FIT.steps; step++) {
		const gradient = new Array(FEATURES.length).fill(0);
		let biasGradient = 0;
		for (let index = 0; index < xs.length; index++) {
			const error = sigmoid(bias + xs[index].reduce((total, value, feature) => total + value * weights[feature], 0)) - ys[index];
			for (let feature = 0; feature < FEATURES.length; feature++) gradient[feature] += error * xs[index][feature];
			biasGradient += error;
		}
		for (let feature = 0; feature < FEATURES.length; feature++) {
			weights[feature] -= FIT.learningRate * (gradient[feature] / xs.length + FIT.l2 * weights[feature]);
			if (ADD_ONLY.includes(FEATURES[feature])) weights[feature] = Math.max(0, weights[feature]);
		}
		bias -= FIT.learningRate * (biasGradient / xs.length);
	}
	return { kind: "fitted", weights: Object.fromEntries(FEATURES.map((name, index) => [name, Math.round(weights[index] * 1e6) / 1e6])), bias: Math.round(bias * 1e6) / 1e6, verdicts: rows.length };
}

export function rankModel(verdicts) {
	return fitModel(verdicts) ?? { kind: "fixed", weights: FIXED_WEIGHTS, bias: 0, verdicts: verdicts.length };
}

// 0 to 100: the weighted sum for the fixed model, the probability of a keep for the fitted one.
export function scoreFeatures(features, model) {
	const x = vector(features);
	const sum = FEATURES.reduce((total, name, index) => total + x[index] * (model.weights[name] ?? 0), 0);
	return Math.round((model.kind === "fitted" ? sigmoid(sum + model.bias) : sum) * 1000) / 10;
}

export function cosine(a, b) {
	let dot = 0;
	let left = 0;
	let right = 0;
	for (let index = 0; index < Math.min(a.length, b.length); index++) {
		dot += a[index] * b[index];
		left += a[index] * a[index];
		right += b[index] * b[index];
	}
	return left && right ? dot / Math.sqrt(left * right) : 0;
}

const STOP_WORDS = new Set("the a an and or of to in on for with at by from is are was were be has have had its it this that as after over new into about than will says said".split(" "));

export function titleWords(title) {
	return new Set(
		String(title ?? "")
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((word) => word.length > 2 && !STOP_WORDS.has(word))
	);
}

export function wordOverlap(a, b) {
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const word of a) if (b.has(word)) shared += 1;
	return shared / Math.min(a.size, b.size);
}

// The best similarity of one text (its vector, or its words) to a list of others.
export function bestSimilarity({ vector: own, words }, others) {
	let best = 0;
	for (const other of others) best = Math.max(best, own && other.vector ? cosine(own, other.vector) : wordOverlap(words, other.words ?? titleWords(other.text)));
	return clamp(best);
}

// The features code can set before triage: everything but Jev's four.
export function baseFeatures({ story, reference, publishers, trustedOutlets, now }) {
	const hosts = story.sources.map(({ host }) => host);
	const record = hosts.map((host) => publishers.get(host)).filter(Boolean);
	const publisher = record.reduce((best, row) => Math.max(best, (row.kept ?? 0) / ((row.kept ?? 0) + (row.dropped ?? 0) + 1), (row.picked ?? 0) / ((row.seen ?? 0) + 4)), 0);
	const trusted = hosts.some((host) => (trustedOutlets ?? []).some((outlet) => host === outlet || host.endsWith(`.${outlet}`))) ? 1 : 0;
	const ageHours = story.publishedAt ? (now.getTime() - new Date(story.publishedAt).getTime()) / 3_600_000 : 48;
	const own = { vector: reference.vectorOf?.(story) ?? null, words: titleWords(`${story.title} ${story.snippet ?? ""}`) };
	return {
		exampleSim: bestSimilarity(own, reference.examples),
		pastSim: Math.round((bestSimilarity(own, reference.kept) - bestSimilarity(own, reference.dropped)) * 1000) / 1000,
		publisher: Math.round(clamp(publisher) * 1000) / 1000,
		trusted,
		independent: clamp((new Set(story.sources.filter(({ sourceKind }) => sourceKind === "reporting" || sourceKind === null).map(({ host }) => host)).size - 1) / 4),
		recency: Math.round(Math.exp(-Math.max(0, ageHours) / 24) * 1000) / 1000,
	};
}
