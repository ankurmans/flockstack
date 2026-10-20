// A subject line test: up to 4 subjects (with their preview texts) go to a slice of a send's audience, and the one
// that did best goes to everyone else once the wait is over (lib/ab-tests.js). variants[0] is always the campaign's
// own subject and preview text.
export const AB_TEST = {
	maxVariants: 4,
	percent: { min: 5, max: 50, default: 20 },
	// QStash wakes the pick up; the wait is from the end of the test slice's send.
	waitMinutes: { min: 30, max: 2880, default: 240 },
	recheckMinutes: 15,
};
// Clicks by default: Apple Mail Privacy Protection opens every email it receives, so opens favor no subject.
export const AB_TEST_METRICS = ["clicks", "opens"];
export const AB_TEST_STATUSES = ["testing", "picked"];
export const VARIANT_LABELS = ["A", "B", "C", "D"];

export function hasAbTest(campaign) {
	return (campaign?.abTest?.variants?.length ?? 0) >= 2;
}

// The variants as stored: the campaign's own subject first, then the others, each with its counters kept.
export function buildVariants({ subject, previewText }, others, current = []) {
	const counters = (index) => ({ sent: current[index]?.sent ?? 0, opened: current[index]?.opened ?? 0, clicked: current[index]?.clicked ?? 0 });
	return [{ subject, previewText }, ...others].map((variant, index) => ({
		subject: variant.subject ?? "",
		previewText: variant.previewText ?? "",
		...counters(index),
	}));
}

// How many of the audience the test goes to: its share, rounded up, and at least one per subject.
export function getTestSize(audience, { testPercent = AB_TEST.percent.default, variants }) {
	if (audience <= 0) return 0;
	return Math.min(audience, Math.max(variants.length, Math.ceil((audience * testPercent) / 100)));
}

// The test slice takes the subjects in turn, most engaged reader first, so each one reaches readers alike.
export function createVariantPicker(campaign) {
	if (campaign?.abTest?.status !== "testing" || !hasAbTest(campaign)) return () => undefined;
	let next = 0;
	const count = campaign.abTest.variants.length;
	return () => next++ % count;
}

// What one email of the campaign says: its variant's subject and preview text while testing, the winner's for the rest.
export function getVariantContent(campaign, variant) {
	if (!hasAbTest(campaign)) return campaign;
	const index = Number.isInteger(variant) ? variant : campaign.abTest.status === "picked" ? campaign.abTest.winner : null;
	const chosen = Number.isInteger(index) ? campaign.abTest.variants[index] : null;
	if (!chosen || index === 0) return campaign;
	return { ...campaign, subject: chosen.subject || campaign.subject, previewText: chosen.previewText || campaign.previewText };
}

function rate(part, total) {
	return total > 0 ? part / total : 0;
}

// The best variant by unique clicks (or opens) per email sent; a tie goes to the other measure, then to the earlier one.
export function pickWinner(variants, metric = "clicks") {
	const [first, second] = metric === "opens" ? ["opened", "clicked"] : ["clicked", "opened"];
	let best = 0;
	for (let index = 1; index < variants.length; index++) {
		const candidate = variants[index];
		const leader = variants[best];
		const byFirst = rate(candidate[first], candidate.sent) - rate(leader[first], leader.sent);
		const bySecond = rate(candidate[second], candidate.sent) - rate(leader[second], leader.sent);
		if (byFirst > 0 || (byFirst === 0 && bySecond > 0)) best = index;
	}
	return best;
}
