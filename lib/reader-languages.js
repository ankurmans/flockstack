import { READER_COPY as COPY, READER_LANGUAGES } from "./reader-language-copy.js";
import { translateReaderProblem } from "./reader-problem-copy.js";
export { READER_LANGUAGES };
export function getReaderMessages(language) { return COPY[getReaderLanguage(language)]; }
export function getReaderLanguage(value) { const code = typeof value === "object" ? value?.language : value; return READER_LANGUAGES.includes(code) ? code : "en"; }
export function getReaderText(newsletter) {
	const language = getReaderLanguage(newsletter);
	const t = (key, values = {}) => (COPY[language][key] ?? key).replace(/\{([a-z]+)\}/g, (match, name) => values[name] === undefined ? match : String(values[name]));
	t.language = language;
	t.error = (message) => translateReaderProblem(t, message);
	return t;
}
