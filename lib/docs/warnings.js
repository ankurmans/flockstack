import { LIMITS, POSTMASTER, WATCH } from "@/lib/config";

// 0.0008 and 0.05 as people read them: 0.08%, 5%.
const percent = (rate) => `${Number((rate * 100).toFixed(2))}%`;

// The warnings before an automatic block, the blocks and what to do: the docs page and /llms-full.txt print it, from the
// levels the code uses. paragraphs: plain text.
export function getWarningsGuide() {
	const { pause, block } = LIMITS;
	return [
		{
			title: "Early warnings",
			paragraphs: [
				`Before an automatic block, FlockStack warns you. You get an email with the numbers and a notice on your dashboard when, over your last 7 days of sends, more than ${percent(WATCH.bounceRate)} of your emails hard bounce (at least ${WATCH.minBounces}) or more than ${percent(WATCH.complaintRate)} are marked as spam (at least ${WATCH.minComplaints}), when Gmail reports a spam rate of ${percent(WATCH.gmailRate)} or more for your emails, or when the email provider reports a finding on your sending that isn't high impact. Nothing is stopped by a warning.`,
				`The email comes once per issue every ${WATCH.periodDays} days while it lasts. The notice goes as soon as a check finds the rate back under the level, or ${WATCH.periodDays} days after it was last seen.`,
			],
		},
		{
			title: "What pauses a send and what blocks an account",
			paragraphs: [
				`A campaign pauses on its own past ${percent(pause.bounceRate)} hard bounces (at least ${pause.minBounces}) or ${percent(pause.complaintRate)} complaints (at least ${pause.minComplaints}). You are emailed, and you can resume it.`,
				`The account is blocked past ${percent(block.bounceRate)} hard bounces (at least ${block.minBounces}) or ${percent(block.complaintRate)} complaints (at least ${block.minComplaints}), on a campaign, on the first slice of a first send or over the last 7 days, when Gmail's spam rate reaches ${percent(POSTMASTER.blockRate)}, and when the email provider pauses your sending or reports a high-impact finding. A blocked account sends nothing until an admin unblocks it, and the reason is on your dashboard and in the email you get.`,
				"One bad send can pass the block level on its own, faster than a warning over 7 days: contacts you have never emailed go out in steps, a first slice and then the rest after a check, so a bad list shows itself in the slice.",
			],
		},
		{
			title: "Spam traps block at once",
			paragraphs: [
				"A spam trap is an address that never signed up for anything: it shows up on bought, scraped or very old lists. One email to a trap blocks the account at once, with no warning first, by design: a list with one trap usually has more, and every send to them costs the sending reputation all customers share.",
			],
		},
		{
			title: "What to do after a warning",
			paragraphs: [
				"Remove contacts you can't vouch for: an old list, one from somewhere else, or addresses that never opened. Delete them, or leave their import or segment out of your next sends.",
				"Turn on confirmed opt-in in the newsletter's settings, so new signups prove their address before they get anything.",
				"Turn on the list cleanup, so readers who stopped opening get one last-chance email and then stop receiving issues.",
				"Keep the unsubscribe link easy to find: a reader who can't leave marks the email as spam instead.",
			],
		},
	];
}

export function getWarningsMarkdown() {
	return getWarningsGuide()
		.flatMap(({ title, paragraphs }) => [`### ${title}`, "", ...paragraphs.flatMap((paragraph) => [paragraph, ""])])
		.join("\n");
}
