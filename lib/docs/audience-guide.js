import { MAX_STEPS } from "@/lib/automation-rules";
import { MAX_CONDITIONS, MAX_SEGMENTS_PER_NEWSLETTER } from "@/lib/segment-rules";
import { MAX_FIELDS_PER_NEWSLETTER } from "@/lib/custom-fields-rules";
import { MAX_TAGS_PER_CONTACT, MAX_TAGS_PER_NEWSLETTER } from "@/lib/tag-rules";

// The guide to tags, custom fields, merge tags, segments and automations: the docs page and /llms-full.txt print it.
// paragraphs: plain text, with `code` for names. code: an example, as JSON.
export const AUDIENCE_GUIDE = [
	{
		title: "Tags and custom fields",
		paragraphs: [
			`A tag is a free-form label on a contact: vip, webinar-2026, customer. Tags are lowercase with single spaces, up to ${MAX_TAGS_PER_CONTACT} a contact and ${MAX_TAGS_PER_NEWSLETTER} a newsletter. Add and remove them with \`add_tag\` and \`remove_tag\`, in a signup (\`add_contact\` takes \`tags\`), in an import (a \`tags\` column, or tags for the whole file), or from a contact's menu in the dashboard.`,
			`A custom field is a value every contact can have: text, a number or a date (YYYY-MM-DD). Define them per newsletter with \`create_custom_field\` (up to ${MAX_FIELDS_PER_NEWSLETTER}) and set a contact's value with \`set_contact_field\`, in a signup, or from an import column named like the field. A field marked \`onSignupForm\` is asked for on the newsletter's own signup form; visitors never set tags.`,
		],
	},
	{
		title: "Merge tags",
		paragraphs: [
			"Write `{{first_name}}` in a subject, preview text or body, and each contact's email has their own value. After a bar comes the text for contacts without one: `{{first_name|there}}`. `{{email}}` is the contact's address. The name is a custom field's key; there are no spaces inside the braces, and `{{subject}}`, `{{preview_text}}` and `{{unsubscribe_url}}` keep their own meaning.",
			"Values are escaped in HTML, filled in before links are tracked (so a tag works inside a link's address), and test emails and the issue's web page show the fallback. The editor's slash menu inserts them.",
		],
	},
	{
		title: "Segments",
		paragraphs: [
			`A segment is a saved audience: rules over a newsletter's contacts, with live counts (\`list_segments\`, \`preview_segment\`). Rules join conditions with \`all\` (and) or \`any\` (or), and a condition can be a group with its own \`all\` or \`any\`, one level deep. Up to ${MAX_CONDITIONS} conditions at each level and ${MAX_SEGMENTS_PER_NEWSLETTER} segments a newsletter.`,
			"The conditions are status, tag (has or has_not), field (eq, neq, gt, gte, lt, lte, contains, starts_with, is_set, is_not_set; text comparisons are case sensitive), signup_date (from, to), source, engagement (opened, clicked or opened_or_clicked in the last N days, dormant for N days, or never_opened) and imported. They run in the database.",
			"A campaign goes to a segment when you set it with `update_campaign` (`segment`: an ID or name; null goes back to everyone). Sending to a segment is sending: only active contacts get it, suppressed addresses are left out, contacts the account never emailed go in the warm-up's first slice, the list cleanup sends cold contacts their last-chance email, and the plan's emails are counted. The segment is read when the send starts, and the campaign keeps that audience for its next steps. `preview_campaign_recipients` counts who would get it, and whether it fits the plan.",
		],
		code: {
			title: "A segment",
			value: {
				name: "Engaged VIPs",
				rules: {
					match: "all",
					conditions: [
						{ type: "status", value: "active" },
						{ match: "any", conditions: [{ type: "tag", value: "vip" }, { type: "engagement", kind: "opened_or_clicked", days: 30 }] },
					],
				},
			},
		},
	},
	{
		title: "Automations",
		paragraphs: [
			`An automation sends a series of emails and changes tags for each contact it starts for. A trigger starts it: \`subscribed\` (a contact joins, once confirmed, optionally with a tag or from a source), \`tag_added\`, \`segment_joined\` (checked about every hour; only contacts who join after it's activated, unless \`includeExisting\` is true) or \`date_field\` (the day of a date field plus \`offsetDays\`, once or \`yearly\`). Steps run in order, up to ${MAX_STEPS}: \`email\` (subject, content in markdown, rich or html, with merge tags), \`wait\` (minutes, hours or days), \`add_tag\`, \`remove_tag\` and \`end\`.`,
			"`create_automation` makes a draft; nothing is sent until `activate_automation`, which checks every email and can't be undone once emails go out. An active automation's trigger and steps are fixed: `pause_automation` first. Resend all the steps with the IDs you got back, so contacts waiting on a step stay on it.",
			"A contact enters an automation once. Importing contacts doesn't start automations. A contact who unsubscribes, bounces, complains, is suppressed or deleted leaves it, and so does one who isn't active when a step runs. Automated emails go through the sending path of a campaign: an unsubscribe link and List-Unsubscribe headers, suppression, the plan's emails (they wait when the month is used up), the send rate and the account's blocks (nobody moves while the account is blocked). On FlockStack Cloud an account's automations also share a daily room that grows with its proven volume, at least 500 emails.",
			"`get_automation_report` tells how many contacts entered, are in it, finished it or left it and why, and for each step how many wait for it and how its emails did.",
		],
		code: {
			title: "A welcome series",
			value: {
				name: "Welcome series",
				trigger: { type: "subscribed" },
				steps: [
					{ type: "email", subject: "Welcome", content: "Thanks for joining, {{first_name|friend}}." },
					{ type: "wait", amount: 2, unit: "days" },
					{ type: "add_tag", tag: "onboarded" },
					{ type: "email", subject: "Where to start", content: "Here are three issues worth your time." },
				],
			},
		},
	},
];

// The guide as Markdown for /llms-full.txt.
export function getAudienceGuideMarkdown() {
	return AUDIENCE_GUIDE.flatMap(({ title, paragraphs, code }) => [
		`### ${title}`,
		"",
		...paragraphs.flatMap((paragraph) => [paragraph, ""]),
		...(code ? ["```json", JSON.stringify(code.value, null, 2), "```", ""] : []),
	]).join("\n");
}
