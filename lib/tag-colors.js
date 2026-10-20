// The colors a tag can have (models/Tag.js), and the classes that draw them. The class names are written out whole so
// Tailwind finds them. No color is the neutral gray the tags always had.
export const TAG_COLORS = ["gray", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink"];

const PILLS = {
	gray: "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300",
	red: "bg-red-500/15 text-red-800 dark:text-red-300",
	orange: "bg-orange-500/15 text-orange-800 dark:text-orange-300",
	amber: "bg-amber-500/20 text-amber-900 dark:text-amber-200",
	green: "bg-green-500/15 text-green-800 dark:text-green-300",
	teal: "bg-teal-500/15 text-teal-800 dark:text-teal-300",
	blue: "bg-blue-500/15 text-blue-800 dark:text-blue-300",
	violet: "bg-violet-500/15 text-violet-800 dark:text-violet-300",
	pink: "bg-pink-500/15 text-pink-800 dark:text-pink-300",
};

const SWATCHES = {
	gray: "bg-zinc-500",
	red: "bg-red-500",
	orange: "bg-orange-500",
	amber: "bg-amber-500",
	green: "bg-green-500",
	teal: "bg-teal-500",
	blue: "bg-blue-500",
	violet: "bg-violet-500",
	pink: "bg-pink-500",
};

const UNCOLORED = "bg-muted text-muted-foreground";

export function isTagColor(value) {
	return TAG_COLORS.includes(value);
}

export function getTagPillClasses(color) {
	return PILLS[color] ?? UNCOLORED;
}

export function getTagSwatchClasses(color) {
	return SWATCHES[color] ?? "bg-muted-foreground/40";
}
