import { LIMITS } from "@/lib/content-rules";

// The guide to the content calendar: the docs page and /llms-full.txt print it. paragraphs: plain text, with `code` for names.
// code: an example, as JSON.
export const CONTENT_CALENDAR_GUIDE = [
	{
		title: "Plans are not deliveries",
		paragraphs: [
			"The content calendar plans newsletter issues and the LinkedIn posts around them in one place: copy, visuals, review and a planned day. A planned day is an intention. Giving an item a day, moving it, reordering a day or applying a pattern never sends, schedules or publishes anything, and never changes a campaign. Sending stays with the campaign's own tools (`schedule_campaign`, `send_campaign`) and their approvals.",
			"The calendar shows the two apart. A planned item is `planned`. A campaign that is really going out is `scheduled`, `sending`, `paused` or `sent`, at the time it goes out; an issue's item shows as planned while its campaign is a draft and as the campaign's own status once it is more. LinkedIn is manual: FlockStack keeps the copy and the visuals, you post them, and you record the address of the post. Nothing here posts to LinkedIn or says a post is scheduled.",
		],
	},
	{
		title: "Items, batches and the backlog",
		paragraphs: [
			"A content item is a `newsletter` issue or a `linkedin` post. It has a title, the reader's obstacle and the takeaway, a funnel stage (`TOFU`, `MOFU` or `BOFU`), a content pillar, a hook, the body, a call to action and its destination, references and evidence links, private notes, and a planned day (`plannedDate`, an optional `plannedTime` and an IANA `timeZone`). A newsletter item links an existing campaign with `campaign`; a post can name the issue it is derived from. The campaign is read, never copied or changed, so its subject and status on the item are always its own. An issue belongs to one newsletter item.",
			`A batch groups items that belong together: a launch, a month. \`create_content_item\` takes \`batch\` (an ID or the batch's \`externalId\`), and \`update_content_item\` moves an item between batches. A newsletter holds up to ${LIMITS.itemsPerNewsletter.toLocaleString("en-US")} items and ${LIMITS.batchesPerNewsletter} batches; a batch up to ${LIMITS.itemsPerBatch} items.`,
			"An item with no `plannedDate` is in the backlog. `set_content_slot` gives it a day, moves it, or sends it back with `date: null`; `position` puts it at a place among that day's items, and `reorder_content_items` reorders a day or a batch. Times are wall-clock times in the item's timezone: 09:00 stays 09:00 across a clock change, and a time the clock skips (02:30 on the day Paris springs forward) is stored as the first time that exists.",
			"`get_content_plan` reads up to 100 days, with the backlog if you ask, and filters for channel, funnel stage, pillar, batch and editorial state. In the dashboard it is `/campaigns/calendar`, in a month, a week or an agenda, with a form to move an item to a day instead of dragging it.",
		],
	},
	{
		title: "Visuals and manual posting",
		paragraphs: [
			`Visuals come from the media library: upload with \`upload_image\` or \`upload_file\` (a PDF carousel), or pick one with \`list_media\`, then \`attach_content_asset\` (one, at a position, with alt text) or \`set_content_assets\` (the whole list, in order). Nothing is stored twice: an item points at the library's file, and only the account's own files can be attached. Up to ${LIMITS.assets} visuals; a LinkedIn post takes pictures or one PDF, not both. Each visual's \`url\` is the file to download.`,
			"To post by hand: the item's page has Copy the post (`postText` in the API: the hook, the body, the call to action and the address) and a download for each visual. After posting, `record_content_publication` takes the address of the post on LinkedIn and when it went up, and the item becomes `delivered`. Only an approved item can be recorded, and a newsletter item only once its campaign is sent.",
		],
	},
	{
		title: "Review and approval",
		paragraphs: [
			"The editorial state is separate from a campaign's delivery: `idea`, `drafting`, `ready_for_review`, `changes_requested`, `approved`, `delivered`. An author, a person or an agent, sets `idea` or `drafting` with `update_content_item` and asks for a review with `request_content_review`; `request_batch_review` asks for a whole batch and returns the batch's `reviewUrl`, one page where the owner reviews and approves everything. Only the owner approves or asks for changes, in the dashboard: no key or connected app can. Approving sends, schedules and publishes nothing.",
			"A review is refused while something is missing, and `get_content_item` lists it under `readiness`: a title, the post's copy (within LinkedIn's 3,000 characters), a call to action, a visual with alt text on each picture, or for an issue a linked campaign with a subject. Warnings (no funnel stage, pillar, hook or day) never stop an approval.",
			"Editing what readers would see after approval takes the approval back: changing the title, hook, body, call to action, destination, visuals or linked issue turns an approved item into `changes_requested` and marks it `editedAfterApproval`. Moving it, and changing notes, the pillar or references, keep the approval; a move is recorded in `moves`. An issue's words live on its campaign, so a change there after approval marks the item `editedAfterApproval` too. Every content change keeps a revision (the last 50): `list_content_revisions` reads them and `restore_content_revision` brings one back.",
		],
	},
	{
		title: "Patterns",
		paragraphs: [
			"A batch can carry a recurring pattern: the funnel stages in the order they repeat, such as TOFU, MOFU, BOFU, TOFU, TOFU, and a cadence (weekdays, or every N days, slots per day, a time and a timezone). No account has one unless it makes it, and it does nothing by itself. `apply_editorial_pattern` gives the batch's items without a planned day their slots from a start day: the n-th item takes the n-th slot, items whose stage differs from the pattern's are listed as `mismatches`, `matchStages` picks the next item with the stage each slot wants, and `dryRun` shows the result without writing it. A slot is a planned day for an item of any channel; five posts are five posts, never five issues.",
			"The Briefing issue pattern (`issue: briefing`, with or without stages) makes each slot a sectioned issue, the skeleton a briefing writes: Lead, Market pulse, Earnings and filings, Headline roundup, Deal flow, Regulation and rates, People moves, Product and tech launches and Coming up, or the ones named in `sections`. Every section is dense one-line items with the company, person or product in bold and a source on each, and a section with nothing in it is left out. Applying it answers the sections in the shape `update_briefing` takes and the skeleton as Markdown, and gives each newsletter item it places that has no words and no linked issue the skeleton as its body, with a revision, so a person can write the issue by hand. An item with words, in review or approved keeps them.",
		],
	},
	{
		title: "Safe retries",
		paragraphs: [
			"Send an `externalId` with `create_content_item`, `import_content_items` (up to 25 items) and `create_editorial_batch`: it is your own key, unique in the account. Sending it again returns the item or batch that has it with `created: false` and changes nothing, so an import that failed halfway can simply run again. A newsletter item for a campaign that already has one returns that item. Use `update_content_item` to change one.",
		],
	},
	{
		title: "Keys and levels",
		paragraphs: [
			"Reading the plan is `read_only`. Planning, editing, visuals, review requests, patterns, revisions and recording a publication are drafts only and up: none of it can send, schedule or publish, so a drafts only key can run a whole calendar and cannot send an issue. Deleting an item or a batch waits for the owner on a send with approval key. A key limited to one newsletter reaches only that newsletter's items and batches.",
		],
		code: {
			title: "An agent fills a month: a batch, linked drafts, posts in pattern order, a review",
			value: [
				{ tool: "create_editorial_batch", arguments: { name: "November", externalId: "nov-2026", pattern: { stages: ["TOFU", "MOFU", "BOFU", "TOFU", "TOFU"], cadence: { weekdays: [1, 3, 5], time: "09:00", timeZone: "Europe/Paris" } } } },
				{ tool: "create_content_item", arguments: { channel: "newsletter", campaign: "<a draft's id>", batch: "nov-2026" } },
				{ tool: "upload_image", arguments: { url: "https://example.com/visual.png" } },
				{ tool: "create_content_item", arguments: { channel: "linkedin", title: "Why replies beat opens", funnelStage: "TOFU", hook: "…", body: "…", cta: "Read the issue", destinationUrl: "https://example.com/issue", batch: "nov-2026", externalId: "nov-post-1", assets: [{ media: "<the image's id>", altText: "…" }] } },
				{ tool: "apply_editorial_pattern", arguments: { id: "<the batch's id>", startDate: "2026-11-02", matchStages: true } },
				{ tool: "request_batch_review", arguments: { id: "<the batch's id>" } },
			],
		},
	},
];

export function getContentCalendarMarkdown() {
	return CONTENT_CALENDAR_GUIDE.flatMap(({ title, paragraphs, code }) => [
		`### ${title}`,
		"",
		...paragraphs.flatMap((paragraph) => [paragraph, ""]),
		...(code ? ["```json", JSON.stringify(code.value, null, 2), "```", ""] : []),
	]).join("\n");
}
