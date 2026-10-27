const FIELD_PROBLEMS = [
	"takes one option",
	"must be true or false",
	"must be a number",
	"must be a date and time like 2026-03-14T09:30:00Z",
	"must be a real date like 2026-03-14",
	"must be a date like 2026-03-14",
];

// Older reader endpoints return English strings. Translate only known system patterns; preserve authored labels,
// options and moderation reasons, and leave an unknown provider message intact.
export function translateReaderProblem(t, message) {
	if (typeof message !== "string") return "";
	let match;
	if (message.startsWith("Reply Rules: ")) return t("Reply Rules: {rule}", { rule: message.slice("Reply Rules: ".length) });
	const number = (value) => {
		const parsed = Number(value.replaceAll(",", ""));
		return /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(value) && Number.isSafeInteger(parsed) && parsed >= 0 ? new Intl.NumberFormat(t.language).format(parsed) : value;
	};
	if ((match = /^Keep your name under (\d+) characters\.$/.exec(message)) || (match = /^Use (\d+) characters or fewer for your name\.$/.exec(message))) return t("Use {max} characters or fewer for your name.", { max: number(match[1]) });
	if ((match = /^Use (\d+) to (\d+) characters for your name$/.exec(message))) return t("Use {min} to {max} characters for your name", { min: number(match[1]), max: number(match[2]) });
	if ((match = /^Pick a day within (\d+) days$/.exec(message))) return t("Pick a day within {days} days", { days: number(match[1]) });
	if (message.startsWith("Commenting is turned off for you: ")) return t("Commenting is turned off for you: {reason}", { reason: message.slice("Commenting is turned off for you: ".length) });
	if ((match = /^A comment can have up to ([\d,]+) (characters|links)\.$/.exec(message))) return t(match[2] === "links" ? "A comment can have up to {max} links." : "A comment can have up to {max} characters.", { max: number(match[1]) });
	if ((match = /^(.{1,100}) must be (\d+) characters or fewer$/.exec(message))) return t("{field} must be {max} characters or fewer", { field: match[1], max: number(match[2]) });
	if ((match = /^(.{1,100}) must be one of (.{1,1000})$/.exec(message))) return t("{field} must be one of {options}", { field: match[1], options: match[2] });
	for (const suffix of FIELD_PROBLEMS) {
		if (message.endsWith(` ${suffix}`)) return t(`{field} ${suffix}`, { field: message.slice(0, -suffix.length - 1) });
	}
	return t(message);
}
