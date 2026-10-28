import { rankSources } from "./labels.js";

// The second look for the same story found twice (docs/BRIEFINGS-DESIGN.md, Cluster). Clustering at 0.86 cosine keeps unrelated
// stories apart but lets two reports of one event through when their headlines differ ("AmTrust acquires Wakam" and "AmTrust
// International acquires Wakam"; two outlets on The Hartford's quarter). After triage, the best stories are compared again: the
// same company and the same kind of event, or embeddings closer than SIMILAR, make one story, whose primary source is the better
// scored story's and whose other reports become its sources.
export const SIMILAR = 0.78;

const EVENTS = {
	acquisition: /\b(?:acquir\w*|acquisitions?|buys?|buying|takeover|merg(?:e|es|er|ers|ing))\b/i,
	results: /\b(?:q[1-4]|quarter\w*|earnings|results|profits?|revenues?|losses|half-year|full-year)\b/i,
	funding: /\b(?:rais(?:e|es|ed|ing)|funding|series [a-f]|round)\b/i,
	launch: /\b(?:launch\w*|unveil\w*|introduc\w*|debut\w*|rolls? out)\b/i,
	people: /\b(?:appoint\w*|hires?|hired|ceo|chief \w+ officer|steps down|resign\w*)\b/i,
	enforcement: /\b(?:fined?|fines|penalt\w*|lawsuit|sues?|sued|probe|investigat\w*)\b/i,
	partnership: /\b(?:partner\w*|alliance|teams up)\b/i,
	rates: /\b(?:rates?|pricing)\b/i,
};
const NOT_NAMES = new Set(
	"the a an and or of in on for to with at by from new us uk eu its it this that how why what who when after over into about as is are was were be has have had will says said report reports year quarter q1 q2 q3 q4 january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday".split(" ")
);

export function eventsOf(text) {
	return new Set(Object.entries(EVENTS).filter(([, pattern]) => pattern.test(String(text ?? ""))).map(([name]) => name));
}

function isEventWord(word) {
	return Object.values(EVENTS).some((pattern) => pattern.test(word));
}

// The names in a headline: capitalised words that aren't common words or event words. The first word is capitalised in any
// headline, so it counts only with a capital inside it (AmTrust, AIG), or when the other headline has it as a name too.
export function namesOf(title) {
	const words = String(title ?? "")
		.split(/\s+/)
		.map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
		.filter(Boolean);
	const name = (word) => /^\p{Lu}/u.test(word) && word.length > 1 && !NOT_NAMES.has(word.toLowerCase()) && !isEventWord(word);
	const inner = (word) => /^\p{Lu}.*\p{Lu}/u.test(word);
	const middle = new Set(words.slice(1).filter(name).map((word) => word.toLowerCase()));
	const first = words[0] && name(words[0]) ? words[0].toLowerCase() : null;
	return { middle, first, firstIsName: Boolean(first && inner(words[0])) };
}

export function sharesName(a, b) {
	const one = namesOf(a);
	const two = namesOf(b);
	if ([...one.middle].some((word) => two.middle.has(word))) return true;
	if (one.first && (two.middle.has(one.first) || (one.first === two.first && (one.firstIsName || two.firstIsName)))) return true;
	return Boolean(two.first && one.middle.has(two.first));
}

export function sameEvent(a, b) {
	const one = eventsOf(a.title);
	const two = eventsOf(b.title);
	return [...one].some((event) => two.has(event)) && sharesName(a.title, b.title);
}

// stories: scored, best first. similar: { storyKey: [storyKey, ...] } with embedding similarity over SIMILAR. Only the first
// `window` stories are compared, the ones that can still be picked.
export function mergeDuplicates(stories, { similar = {}, trustedOutlets = [], window = stories.length } = {}) {
	const head = stories.slice(0, window);
	const merged = new Set();
	const result = [];
	for (const story of head) {
		if (merged.has(story.key)) continue;
		let combined = { ...story, sources: [...story.sources], foundBy: [...(story.foundBy ?? [])] };
		for (const other of head) {
			if (other === story || merged.has(other.key) || result.some((kept) => kept.key === other.key)) continue;
			const close = (similar[story.key] ?? []).includes(other.key) || (similar[other.key] ?? []).includes(story.key);
			if (!close && !sameEvent(story, other)) continue;
			merged.add(other.key);
			const known = new Set(combined.sources.map(({ urlHash }) => urlHash));
			const [primary, ...rest] = combined.sources;
			combined = {
				...combined,
				sources: [primary, ...rankSources([...rest, ...other.sources.filter(({ urlHash }) => !known.has(urlHash))], { trustedOutlets })],
				foundBy: [...new Set([...combined.foundBy, ...(other.foundBy ?? [])])],
				publishedAt: [combined.publishedAt, other.publishedAt].filter(Boolean).sort().at(-1) ?? null,
				mergedKeys: [...(combined.mergedKeys ?? []), other.key],
			};
		}
		result.push(combined);
	}
	return [...result, ...stories.slice(window)];
}
