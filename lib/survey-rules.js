// What a survey's questions and answers look like, with nothing that touches the database (lib/surveys.js has the
// rest), so the builder, the reader's page and the actions read them the same way. An answer is stored as compactly as
// it can be: text, a number, true or false, or an array of options, by question ID.

export const QUESTION_TYPES = ["short_text", "long_text", "single_choice", "multi_choice", "rating", "nps", "yes_no"];
export const QUESTION_TYPE_LABELS = {
	short_text: "Short answer",
	long_text: "Long answer",
	single_choice: "One choice",
	multi_choice: "Several choices",
	rating: "Rating, 1 to 5",
	nps: "0 to 10, how likely to recommend",
	yes_no: "Yes or no",
};
// The custom field types an answer can be saved to.
export const FIELD_TYPES_FOR_QUESTION = {
	short_text: ["text"],
	long_text: ["text"],
	single_choice: ["text", "list"],
	multi_choice: ["list"],
	rating: ["number"],
	nps: ["number"],
	yes_no: ["boolean"],
};
export const SURVEY_PLACEMENTS = ["afterSignup", "onUnsubscribe"];
export const MAX_QUESTIONS = 20;
export const MAX_CHOICES = 10;
export const MAX_SURVEYS_PER_NEWSLETTER = 20;
const TEXT_LIMITS = { short_text: 200, long_text: 2000 };
const RANGES = { rating: [1, 5], nps: [0, 10] };
const QUESTION_ID_PATTERN = /^q[a-z0-9]{2,12}$/;

export function isChoice(type) {
	return type === "single_choice" || type === "multi_choice";
}

// A question's problem, or null. id: kept when it fits, so answers stay with their question across edits.
export function getQuestionProblem(question, index) {
	const where = `questions[${index + 1}]`;
	if (!QUESTION_TYPES.includes(question.type)) return `${where}: type is one of ${QUESTION_TYPES.join(", ")}`;
	if (!question.label?.trim()) return `${where}: ask something`;
	if (isChoice(question.type)) {
		const options = (question.options ?? []).map((option) => String(option).trim());
		if (options.length < 2 || options.length > MAX_CHOICES) return `${where}: a choice has 2 to ${MAX_CHOICES} options`;
		if (options.some((option) => !option || option.includes(","))) return `${where}: options need words and no commas`;
		if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) return `${where}: two options are the same`;
	}
	return null;
}

export function isQuestionId(value) {
	return QUESTION_ID_PATTERN.test(String(value ?? ""));
}

// One answer as the reader sent it (text, or several values for a multi_choice) -> { value } in its stored form,
// { value: null } for no answer, or { problem }.
export function parseAnswer(question, input) {
	const values = (Array.isArray(input) ? input : [input]).map((item) => String(item ?? "").trim()).filter(Boolean);
	if (values.length === 0) return question.required ? { problem: `${question.label}: answer this one` } : { value: null };
	const [first] = values;
	switch (question.type) {
		case "short_text":
		case "long_text":
			return first.length <= TEXT_LIMITS[question.type] ? { value: first } : { problem: `${question.label}: ${TEXT_LIMITS[question.type]} characters at most` };
		case "single_choice": {
			const option = question.options.find((item) => item.toLowerCase() === first.toLowerCase());
			return option ? { value: option } : { problem: `${question.label}: pick one of the options` };
		}
		case "multi_choice": {
			const chosen = new Set(values.map((item) => item.toLowerCase()));
			const picked = question.options.filter((item) => chosen.has(item.toLowerCase()));
			return picked.length === chosen.size ? { value: picked } : { problem: `${question.label}: pick from the options` };
		}
		case "rating":
		case "nps": {
			const [min, max] = RANGES[question.type];
			const number = Number(first);
			return Number.isInteger(number) && number >= min && number <= max ? { value: number } : { problem: `${question.label}: pick ${min} to ${max}` };
		}
		default: {
			const word = first.toLowerCase();
			if (["yes", "true"].includes(word)) return { value: true };
			return ["no", "false"].includes(word) ? { value: false } : { problem: `${question.label}: yes or no` };
		}
	}
}

// Every answer of a submission -> { answers } (questions left blank are left out) or { problem }.
export function parseAnswers(questions, read) {
	const answers = {};
	for (const question of questions) {
		const parsed = parseAnswer(question, read(question));
		if (parsed.problem) return { problem: parsed.problem };
		if (parsed.value !== null) answers[question.id] = parsed.value;
	}
	return Object.keys(answers).length > 0 ? { answers } : { problem: "Answer at least one question" };
}

// Each question's results: counts per option, the average of a rating, an NPS score, the latest text answers.
export function summarizeResponses(questions, responses) {
	return questions.map((question) => {
		const values = responses.map(({ answers }) => answers?.[question.id]).filter((value) => value !== undefined && value !== null);
		const base = { id: question.id, label: question.label, type: question.type, answered: values.length };
		if (isChoice(question.type)) {
			const counts = Object.fromEntries(question.options.map((option) => [option, 0]));
			for (const value of values) for (const option of [value].flat()) if (option in counts) counts[option] += 1;
			return { ...base, counts: question.options.map((option) => ({ option, count: counts[option] })) };
		}
		if (question.type === "rating" || question.type === "nps") {
			const [min, max] = RANGES[question.type];
			const numbers = values.filter((value) => typeof value === "number");
			const average = numbers.length ? Math.round((numbers.reduce((sum, value) => sum + value, 0) / numbers.length) * 10) / 10 : null;
			const counts = Array.from({ length: max - min + 1 }, (_, index) => ({ option: String(min + index), count: numbers.filter((value) => value === min + index).length }));
			const nps =
				question.type === "nps" && numbers.length
					? Math.round(((numbers.filter((value) => value >= 9).length - numbers.filter((value) => value <= 6).length) / numbers.length) * 100)
					: null;
			return { ...base, average, counts, ...(question.type === "nps" && { nps }) };
		}
		if (question.type === "yes_no") {
			return { ...base, counts: [{ option: "Yes", count: values.filter((value) => value === true).length }, { option: "No", count: values.filter((value) => value === false).length }] };
		}
		return { ...base, latest: values.slice(0, 10).map(String) };
	});
}

// An answer as one CSV cell.
export function answerText(value) {
	if (value === undefined || value === null) return "";
	if (Array.isArray(value)) return value.join(", ");
	if (typeof value === "boolean") return value ? "Yes" : "No";
	return String(value);
}
