// BM25 over the support assistant's chunks, in memory: the corpus is a few hundred chunks of FlockStack's own docs,
// small enough that an index per Worker isolate costs less than any vector search would.
const K1 = 1.2;
const B = 0.75;
// A chunk's title counts as much as this many copies of its words in the text: a heading names what the section is about.
const TITLE_WEIGHT = 3;

const STOP_WORDS = new Set(
	"a an and are as at be but by can do does for from has have how i if in is it its me my no not of on or our so that the their them then there these they this to us was we what when where which who why will with you your yours i'm i've don't can't".split(
		" "
	)
);

// Lowercased words without stop words, with a plural or verb ending taken off, so "domains" finds "domain" and
// "verified" finds "verify".
export function tokenize(text) {
	return (
		String(text ?? "")
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[̀-ͯ]/g, "")
			.match(/[a-z0-9][a-z0-9_]*(?:'[a-z]+)?/g) ?? []
	)
		.filter((word) => !STOP_WORDS.has(word))
		.map(stem)
		.filter((word) => word.length > 1);
}

// A final e goes too, so "price", "prices" and "pricing" meet.
function stem(word) {
	const base = stripEnding(word);
	return base.length > 3 && base.endsWith("e") && !/\d/.test(base) ? base.slice(0, -1) : base;
}

function stripEnding(word) {
	if (word.length <= 4 || /\d/.test(word)) return word;
	if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
	if (word.endsWith("ied")) return `${word.slice(0, -3)}y`;
	if (word.endsWith("ing") && word.length > 6) return word.slice(0, -3);
	if (word.endsWith("ed") && word.length > 5) return word.slice(0, -2).replace(/(.)\1$/, "$1");
	if (word.endsWith("es") && /(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
	if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
	return word;
}

// chunks: [{ title, text, weight?, ... }]. The index keeps them as they are; weight scales a chunk's score.
export function buildIndex(chunks) {
	const documents = chunks.map((chunk) => {
		const terms = new Map();
		const add = (words, weight) => {
			for (const word of words) terms.set(word, (terms.get(word) ?? 0) + weight);
		};
		const titleWords = tokenize(chunk.title);
		const textWords = tokenize(chunk.text);
		add(titleWords, TITLE_WEIGHT);
		add(textWords, 1);
		return { chunk, terms, length: titleWords.length * TITLE_WEIGHT + textWords.length };
	});
	const frequency = new Map();
	for (const { terms } of documents) for (const word of terms.keys()) frequency.set(word, (frequency.get(word) ?? 0) + 1);
	const averageLength = documents.reduce((sum, { length }) => sum + length, 0) / Math.max(documents.length, 1);
	return { documents, frequency, averageLength };
}

// The best chunks for a question, best first, each with its score. Nothing that shares no word with the question.
export function search(index, query, { limit = 5, minScore = 0 } = {}) {
	const words = [...new Set(tokenize(query))];
	if (words.length === 0) return [];
	const count = index.documents.length;
	const results = [];
	for (const { chunk, terms, length } of index.documents) {
		let score = 0;
		for (const word of words) {
			const tf = terms.get(word);
			if (!tf) continue;
			const df = index.frequency.get(word);
			const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
			score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / index.averageLength)));
		}
		score *= chunk.weight ?? 1;
		if (score > minScore) results.push({ chunk, score });
	}
	return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
