import { MAX_NESTING, MAX_SPLIT_PATHS, MAX_STEPS, MAX_TOTAL_STEPS } from "@/lib/automation-rules";
import { MAX_CONDITIONS, MAX_LOOKUP_CONTACTS, MAX_SEGMENTS_PER_NEWSLETTER, MAX_TOTAL_CONDITIONS } from "@/lib/segment-rules";
import { MAX_FIELDS_PER_NEWSLETTER } from "@/lib/custom-fields-rules";
import { MAX_TAGS_PER_CONTACT, MAX_TAGS_PER_NEWSLETTER } from "@/lib/tag-rules";

// The guide to tags, custom fields, merge tags, segments and automations: the docs page and /llms-full.txt print it.
// paragraphs: plain text, with `code` for names. code: an example, as JSON.
export const AUDIENCE_GUIDE = [
	{
		title: "Tags and custom fields",
		paragraphs: [
			`A tag is a free-form label on a contact: vip, webinar-2026, customer. Tags are lowercase with single spaces, up to ${MAX_TAGS_PER_CONTACT} a contact and ${MAX_TAGS_PER_NEWSLETTER} a newsletter. Add and remove them with \`add_tag\` and \`remove_tag\`, in a signup (\`add_contact\` takes \`tags\`), in an import (a \`tags\` column, or tags for the whole file), or from a contact's menu in the dashboard.`,
			`A custom field is a value every contact can have: text, a number, a date (YYYY-MM-DD), a date and time, true or false, or a list (one of its options, or several with \`multiple\`). Define them per newsletter with \`create_custom_field\` (up to ${MAX_FIELDS_PER_NEWSLETTER}) and set a contact's value with \`set_contact_field\`, in a signup, or from an import column named like the field. A field marked \`onSignupForm\` is asked for on the newsletter's own signup form; visitors never set tags.`,
		],
	},
	{
		title: "Preference center",
		paragraphs: [
			"Every email can link to a page on the newsletter's website where a subscriber changes their own details. Mark a custom field `readerEditable` (`create_custom_field`, `update_custom_field`) and the page shows it: a name, a frequency, the topics they want. Nothing else about the contact can be set from it, and they can unsubscribe from it. Turn on `preferencesLink` on the newsletter (`update_newsletter`) for a footer link in every email, or write `{{preferences_url}}` as a link's address in a body.",
			"The link is signed for that subscriber and the newsletter, so it only opens their own page, and it lasts three years. Test emails and the issue's web page have no reader: their link opens nothing.",
		],
	},
	{
		title: "Merge tags",
		paragraphs: [
			"Write `{{first_name}}` in a subject, preview text or body, and each contact's email has their own value. After a bar comes the text for contacts without one: `{{first_name|there}}`. `{{email}}` is the contact's address. The name is a custom field's key; there are no spaces inside the braces, and `{{subject}}`, `{{preview_text}}` and `{{unsubscribe_url}}` keep their own meaning. `{{preferences_url}}` is the reader's own link to the preference center.",
			"Values are escaped in HTML, filled in before links are tracked (so a tag works inside a link's address), and test emails and the issue's web page show the fallback. The editor's slash menu inserts them.",
		],
	},
	{
		title: "Segments",
		paragraphs: [
			`A segment is a saved audience: rules over a newsletter's contacts, with live counts (\`list_segments\`, \`preview_segment\`). Rules join conditions with \`all\` (and) or \`any\` (or), and a condition can be a group with its own \`all\` or \`any\`, one level deep. Up to ${MAX_CONDITIONS} conditions at each level, ${MAX_TOTAL_CONDITIONS} in all, and ${MAX_SEGMENTS_PER_NEWSLETTER} segments a newsletter. Campaign audiences and the branches of automations use the same conditions.`,
			"The conditions are status, tag (has or has_not), field (eq, neq, gt, gte, lt, lte, contains, starts_with, includes, excludes, is_set, is_not_set; text comparisons are case sensitive), signup_date (from, to), source, engagement (opened, clicked or opened_or_clicked in the last N days, dormant for N days, or never_opened), imported, and:",
			"`tier` (free or paid), `country` (two letters, kept from Cloudflare's cf-ipcountry at signup, and from `add_contact`'s `country`; contacts who joined before it was kept have none), `referrals` (credited referrals: eq, neq, gt, gte, lt, lte), `poll` (the answer a subscriber gave, is, is_not, is_any_of, is_none_of, or voted or not) and `issue` (opened or clicked an issue, or one of its links, by its place or its address, or got it and didn't). Status, tag, source, country and field conditions also take `is_any_of` and `is_none_of` with a list of `values`.",
			`A saved list is a segment that doesn't follow the newsletter. \`create_segment_snapshot\` keeps the contacts a segment, or some rules, match right now. People who join later aren't on it and it can't be changed, only renamed or deleted. A list of a few thousand contacts is ready at once; a large one fills in over a few minutes and can't be sent to until its status is ready. A condition \`snapshot\` puts a saved list inside other rules. An issue or saved list condition names up to ${MAX_LOOKUP_CONTACTS.toLocaleString("en-US")} contacts; past that, narrow it.`,
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
			"An automation does things for each contact it starts for: sends emails, waits, changes tags and fields, calls your webhooks, splits contacts into paths. A trigger starts it:",
			"`subscribed` (a contact joins, once confirmed, optionally with a tag or from a source), `tag_added`, `tag_removed`, `segment_joined` and `segment_left` (checked about every hour; only contacts who join after it's activated, unless `includeExisting` is true, and a contact who leaves starts it again each time they leave), `date_field` (the day of a date field plus `offsetDays`, once or `yearly`), `field_changed` (a custom field gets a new value), `upgraded` and `downgraded` (a reader starts or stops paying for the paid tier), `product_bought` (any product, or the one in `product`), `referral_credited` (each credit, or when the referrer reaches `referrals`), `unengaged` (no opens or clicks for `days`, looked at once a day), `link_clicked` (a contact's first click on the link at `url`, in any issue or only `campaign`), `manual` (you add contacts on the automation's page) and `api` (your code adds them with `enroll_contacts`, up to 100 addresses a call).",
			`Steps run in order. \`email\` (subject, content in markdown, rich or html, with merge tags). \`wait\` (minutes, hours or days; or \`until\`, a date and time; or a \`weekday\` at a \`time\` in a \`timeZone\`). \`add_tag\`, \`remove_tag\`. \`set_field\` (a custom field to a value, or null to clear it). \`webhook\` (sends an \`automation.step\` event, with the step's \`name\`, to your webhook endpoints that take it). \`move\` (the contact starts another automation of the newsletter and is done with this one). \`end\`.`,
			`A \`branch\` ends its list with two paths: the first for contacts who match its \`condition\` (rules like a segment's, or a saved \`segment\`), the second for everyone else, judged when they reach the step. A \`split\` ends its list with 2 to ${MAX_SPLIT_PATHS} paths by \`percent\` (adding up to 100). Which path a contact takes is decided by a hash of the split's \`seed\` (its ID by default) and the contact, so a contact takes the same path every time and two splits with the same seed keep the same contacts together. Paths hold steps of their own, nest ${MAX_NESTING} lists deep, and do not join again. Up to ${MAX_STEPS} steps in a list and ${MAX_TOTAL_STEPS} in all.`,
			"`create_automation` makes a draft; nothing is sent until `activate_automation`, which checks every email and can't be undone once emails go out. An active automation's trigger and steps are fixed: `pause_automation` first. Resend all the steps, paths included, with the IDs you got back: a contact waiting on a step stays on it however the steps around it change, and a step without an ID is new. `list_automation_templates` and `create_automation_from_template` start from a welcome series, re-engagement, paid onboarding, a product buyer thank-you or referral thanks.",
			"A contact enters an automation once, except for purchases, referral credits, upgrades, downgrades and leaving a segment, which start it again each time. Importing contacts doesn't start automations. A contact who unsubscribes, bounces, complains, is suppressed or deleted leaves it, and so does one who isn't active when a step runs. Automated emails go through the sending path of a campaign: an unsubscribe link and List-Unsubscribe headers, suppression, the plan's emails (they wait when the month is used up), the send rate and the account's blocks (nobody moves while the account is blocked). On FlockStack Cloud an account's automations also share a daily room that grows with its proven volume, at least 500 emails.",
			"`get_automation_report` tells how many contacts entered, are in it, finished it or left it and why, and for each step, in reading order with its place in the tree, how many contacts it ran for, how many wait for it, how many took each path of a branch or split, and how its emails did.",
		],
		code: {
			title: "A welcome series that treats paid readers differently",
			value: {
				name: "Welcome series",
				trigger: { type: "subscribed" },
				steps: [
					{ type: "email", subject: "Welcome", content: "Thanks for joining, {{first_name|friend}}." },
					{ type: "wait", amount: 2, unit: "days" },
					{
						type: "branch",
						condition: { match: "all", conditions: [{ type: "tier", value: "paid" }] },
						paths: [
							{ steps: [{ type: "add_tag", tag: "paid-welcomed" }] },
							{ steps: [{ type: "email", subject: "Where to start", content: "Here are three issues worth your time." }, { type: "wait", weekday: "friday", time: "09:00", timeZone: "Europe/Paris" }, { type: "add_tag", tag: "onboarded" }] },
						],
					},
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
