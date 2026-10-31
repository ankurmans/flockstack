import { BRIEFING_ISSUE_SECTIONS } from "@/lib/briefing-issue-pattern";
import {
	DEFAULT_BUDGET_USD,
	DEFAULT_DISCOVERY,
	DEFAULT_MIN_SCORE,
	DEFAULT_SCHEDULE,
	DEFAULT_STEP_BUDGETS,
	DEFAULT_STORIES,
	DISCOVERY_MAXIMUMS,
	MANUAL_RUNS_PER_DAY,
	MAX_AI_KEYS_PER_ACCOUNT,
	MAX_BLOCKED_HOSTS,
	MAX_BRIEF_ITEMS,
	MAX_BUDGET_USD,
	MAX_EXAMPLES,
	MAX_FULL_STORIES,
	MAX_SECTIONS,
	MAX_SECTION_ITEMS,
	MAX_STYLE_GUIDE_LENGTH,
	MAX_TOPIC_LENGTH,
	MAX_TRUSTED_OUTLETS,
	SEEN_RETENTION_DAYS,
	VERDICT_LINK_DAYS,
} from "@/lib/briefing-rules";

// The Briefings guide, "Run a newsletter with an agent": the docs page (/docs/briefings) and /llms-full.txt print it.
// paragraphs: plain text, with `code` for names and [label](/path) for a link. list: a bulleted list after the paragraphs.
// code: an example, as JSON.
export const BRIEFINGS_INTRO =
	"A briefing turns a topic into a sourced draft issue on a schedule. You say what to look for and who reads it; it searches the web, picks the stories, reads the original pages, writes the issue in your newsletter's style, checks it and leaves it as a draft for you. An agent can set it up and look after it over MCP or the REST API, with the same rules as the dashboard.";

const usd = (value) => `$${value.toFixed(2)}`;
const STEP_SHARES = Object.entries(DEFAULT_STEP_BUDGETS)
	.map(([step, percent]) => `${step} ${percent}%`)
	.join(", ");

export const BRIEFINGS_GUIDE = [
	{
		title: "What a briefing does",
		paragraphs: [
			"A briefing belongs to a newsletter, one per newsletter. There is no list of sources to keep up. On each run it:",
		],
		list: [
			"Searches the open web from your brief: free news indexes (the GDELT Project and Hacker News), the feeds of your trusted outlets, and your own search key if you add one.",
			"Drops what earlier runs already found, groups copies of the same story, and ranks the rest for your readers.",
			"Reads the original page of each story it keeps. A paywall or a block is never worked around: a story keeps only what public pages say, or is dropped.",
			"Writes the issue in your style guide's voice, with every paragraph and every line linked to its source.",
			"Checks the issue, then saves it as a draft campaign, sends a test email of it to your test address, and sends you a separate note with the checks, the cost and a keep or drop link per story.",
		],
		after: ["A briefing never sends by itself. Each issue waits as a draft until you, or an agent with a key allowed to send, sends it like any other campaign."],
	},
	{
		title: "Set the brief",
		paragraphs: [
			`The brief is what discovery searches from and what the ranker judges against. \`topic\` is what the briefing is about (${MAX_TOPIC_LENGTH} characters at most). \`audience\` says who reads it and what they do. \`useful\` says what makes a story worth their time. \`examples\` are up to ${MAX_EXAMPLES} stories you would have wanted, each with a short note on why.`,
			"Be specific. \"Battery manufacturing in Europe\" finds more than \"batteries\". \"New plants, prices and rules that change what they build or buy\" tells the ranker what to keep. Examples work best when they differ from each other: a plant opening, a price report, a new rule.",
			`The style guide (\`styleGuide\`, ${MAX_STYLE_GUIDE_LENGTH.toLocaleString("en-US")} characters at most) sets the voice: length, tone, words to avoid, how numbers are written.`,
		],
		code: {
			title: "create_briefing",
			value: {
				newsletter: "my-newsletter",
				name: "Morning briefing",
				brief: {
					topic: "Battery manufacturing in Europe",
					audience: "Engineers and buyers at small battery companies",
					useful: "New plants, prices and rules that change what they build or buy",
					examples: [{ url: "https://news.example.com/plant-opens", note: "A new plant, with its capacity and start date" }],
				},
				trustedOutlets: ["news.example.com"],
				blockedHosts: ["paywalled.example.org"],
				schedule: { days: [1, 2, 3, 4, 5], time: "06:00", timeZone: "Europe/Paris" },
			},
		},
	},
	{
		title: "Trusted outlets and blocked hosts",
		paragraphs: [
			`Trusted outlets (\`trustedOutlets\`, up to ${MAX_TRUSTED_OUTLETS} host names like example.com) add to a story's score, and their feeds are read on every run. They never limit the search: stories from other sites still come in.`,
			`Blocked hosts (\`blockedHosts\`, up to ${MAX_BLOCKED_HOSTS}) are never fetched or cited for this briefing, whatever their robots.txt allows. Use it for a publisher whose terms forbid automated reading, or one you don't want to cite.`,
			"Pages are read by the FlockStack-Briefings fetcher, which obeys robots.txt: see [the FlockStack-Briefings fetcher](/docs/briefings-bot).",
		],
	},
	{
		title: "Your keys",
		paragraphs: [
			`Briefings run on your own keys, so the model and search costs are yours, under your own provider's terms. Add them on the [AI keys](/ai-keys) page (${MAX_AI_KEYS_PER_ACCOUNT} at most). A key is encrypted when you save it and never shown again: the dashboard and the API show only its name and last four characters. Add keys in the dashboard rather than through an agent when you can, so a key doesn't pass through a model's context.`,
			"Each step picks a model key and a model: `query` (writes the searches), `triage` (scores the shortlist), `extract` (reads each page into facts), `write`, `check` and `translate` (only with more than one language). The check step has to use a different model from the write step, so a model never checks its own work. A TypeSafe key can triage and check, not write.",
			"Model keys: OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Together AI, DeepInfra, Fireworks, Mistral, DeepSeek, Cloudflare Workers AI on your own Cloudflare account, TypeSafe, or any OpenAI-compatible server on a public https address.",
			"A search key is optional. Without one, discovery uses the free indexes and your trusted outlets' feeds. With a TinyFish key (`discovery.searchKeyId`), discovery also searches through TinyFish, under the key holder's own TinyFish account and terms, paced to TinyFish's published free limits. Paid search stays off until you set `discovery.discoveryBudgetUsd` above 0.",
			"`check_ai_key` makes one small request to the provider and records whether it took the key. A key a briefing uses can't be deleted until you choose another one there.",
		],
	},
	{
		title: "Sections",
		paragraphs: [
			`Without sections, an issue is full stories (a paragraph or two each, ${DEFAULT_STORIES.minFull} to ${DEFAULT_STORIES.maxFull} by default, ${MAX_FULL_STORIES} at most) and then one-line items (${DEFAULT_STORIES.briefItems} by default, ${MAX_BRIEF_ITEMS} at most). A story needs a score of ${DEFAULT_MIN_SCORE} out of 100 (\`minScore\`) to be a full story.`,
			`With sections, the issue is a labelled skeleton you set once: up to ${MAX_SECTIONS} sections in reading order, each with an \`id\`, a \`title\`, a \`purpose\` (what belongs in it), a \`format\` and \`maxItems\`, the most stories it holds (1 to ${MAX_SECTION_ITEMS}).`,
		],
		list: [
			"Each story goes into the section whose purpose it fits best, or into none, and a section keeps its best stories up to its `maxItems`.",
			"`sentences` gives each story a sentence or two with its numbers. `one-liners` gives each story one line, with the company, person or product in bold and its source.",
			"`budgetShare` is a section's percent of the extract and write steps' budget. The shares you give add up to 100 at most; with none, that budget is split evenly between the sections.",
			"When the budget runs short, sections with a lower `priority` are written first (1 first); without priorities, the reading order decides. A section that runs out of its share is skipped, and the note says so.",
			"A section with no story is left out of the issue, heading included, and the note lists it as empty.",
		],
		after: [
			`The Briefing issue pattern is a skeleton to start from, generic for any topic: ${BRIEFING_ISSUE_SECTIONS.map(({ title }) => title).join(", ")}. \`apply_editorial_pattern\` with \`pattern.issue\` set to \`briefing\` answers these sections in the shape \`update_briefing\` takes, and gives each empty newsletter item it plans the same skeleton as Markdown, for an issue written by hand. See [the content calendar](/docs/content-calendar).`,
			"`update_briefing` replaces the list when you send it, and `sections: []` goes back to full stories then one-line items.",
		],
		code: {
			title: "update_briefing",
			value: {
				sections: [
					{ id: "lead", title: "Lead", format: "sentences", maxItems: 1, budgetShare: 30, priority: 1, purpose: "The story that matters most to readers today, with its numbers" },
					{ id: "deal-flow", title: "Deal flow", format: "one-liners", maxItems: 8, budgetShare: 40, priority: 2, purpose: "Acquisitions and funding rounds, each with the amount" },
					{ id: "people", title: "People moves", format: "one-liners", maxItems: 5, purpose: "Hires and departures, with the person, the role and the organization" },
				],
			},
		},
	},
	{
		title: "The news window",
		paragraphs: [
			`A run reads news from the last ${DEFAULT_DISCOVERY.lookbackHours} hours before it starts (\`discovery.lookbackHours\`), and from the last ${DEFAULT_DISCOVERY.mondayLookbackHours} hours on a Monday in the schedule's time zone (\`discovery.mondayLookbackHours\`), so the weekend is covered. Both go up to ${DISCOVERY_MAXIMUMS.lookbackHours} hours. The window counts back from the run, not from the last run, so a manual run soon after a scheduled one still sees a full day.`,
			`Items older than the window are dropped, and so are addresses an earlier run of the briefing already found (remembered for ${SEEN_RETENTION_DAYS} days). For a weekly briefing, set both windows to ${DISCOVERY_MAXIMUMS.lookbackHours} hours.`,
		],
	},
	{
		title: "Schedule and time zone",
		paragraphs: [
			`\`schedule\` has the days it runs (1 Monday to 7 Sunday), a time (HH:MM) and an IANA time zone such as Europe/Paris. The default is weekdays at ${DEFAULT_SCHEDULE.time} ${DEFAULT_SCHEDULE.timeZone}. The time is wall-clock time in that zone, so 06:00 stays 06:00 across a clock change. \`nextRunAt\` is the next run; a paused briefing has none.`,
			`A new briefing is paused. It turns on with \`resume_briefing\` (or \`status: active\`), which needs the brief's topic and a key and model for each step it uses. \`run_briefing\` asks for a run now, whatever the schedule: the engine takes it within about 10 minutes, ${MANUAL_RUNS_PER_DAY} manual runs per briefing per local day. On the Free plan a briefing runs once a week: its schedule has one day and it has one manual run a week, so set both lookback windows to ${DISCOVERY_MAXIMUMS.lookbackHours} hours. Paid plans have one briefing per newsletter. Where the server doesn't run the briefings engine, it answers \`unavailable\`.`,
		],
	},
	{
		title: "The cost cap",
		paragraphs: [
			`\`budgetUsd\` caps what one run may spend on model calls: ${usd(DEFAULT_BUDGET_USD)} by default, ${usd(MAX_BUDGET_USD)} at most. Each step has a share of it (\`stepBudgets\`, by default ${STEP_SHARES}), so a long extract can't leave nothing for the check.`,
			"Before each call the engine estimates its cost from the input, the most output it allows and the model's price (the built-in price table, or the `prices` you set on the briefing). A call that would pass its step's share or the run's cap is not made. A step that can do less does less, such as reading fewer pages; when the write or the check can't be done within the cap, the run stops as `stopped_at_budget` and nothing half-written is saved. A model with no known price can't run under a cap: add its price to `prices`.",
			"Paid search has its own cap, `discovery.discoveryBudgetUsd`, 0 by default. Raising `budgetUsd` above the default or `discoveryBudgetUsd` above 0 through a send with approval key waits for the owner's approval, like a send.",
		],
	},
	{
		title: "Drafts and the keep or drop email",
		paragraphs: [
			"Each run that writes an issue saves it as a draft campaign, sends a test email of it to the briefing's test address (`testEmail`, yours or a team member's), and sends you a separate note. The note is never part of the issue. It lists the checks, the run's cost, the sections and anything discovery couldn't do, and has a keep and a drop link for every story.",
			`A keep or drop link opens a page that names the story and asks before it records anything, so a mail scanner or a link preview can't vote. Each link works once, for ${VERDICT_LINK_DAYS} days. The run's page in the dashboard, and \`rate_briefing_story\`, take a verdict too. Verdicts teach the ranker: from 30 verdicts on, it weighs stories the way your keeps and drops do. A verdict changes nothing in the draft.`,
			"A run that finds nothing worth sending is `no_news`: no draft, and you get a one-line note.",
		],
	},
	{
		title: "What the checks do, and what holds a draft",
		paragraphs: ["Code checks the draft first, then the check model reads each claim against the source it cites. Each check is a pass, a warning or a blocker."],
		list: [
			"Every paragraph cites a source the run read: a citation of a source the run doesn't have is a blocker, a paragraph with none a warning.",
			"Every number in the draft is on a page it cites (blocker).",
			"Every story links to its original (blocker), and a story written from a feed's summary because its page couldn't be read is a warning.",
			"Every link opens (a broken one is a blocker, one that couldn't be confirmed a warning), and a link no source gave is a warning.",
			"No quote is over 25 words (blocker), and a quote not word for word from its source is a warning.",
			"Length, filler phrases and a subject in title case are warnings.",
			"The check model's verdict on each claim: one its source contradicts or doesn't support is a blocker or a warning.",
		],
		after: [
			"Every issue waits as a draft for now: sending by itself once every check passes isn't available yet (`reviewMode` is `draft`). Each run says why its draft was held in `heldReason`: `review_mode` (drafts only), `checks` (a check didn't pass), `thin` (discovery found fewer stories than an issue needs), `partial` (part of the run didn't finish, such as a provider that failed) or `agent_approval` (the newsletter asks before an agent sends). A run that stopped at the budget or failed makes no draft.",
			"`check_campaign` runs the usual pre-send checks on the draft before you send it.",
		],
	},
	{
		title: "Languages (beta)",
		paragraphs: [
			"`languages` lists the issue's languages from English, Spanish, French, German, Italian and Portuguese. The issue is written in the first; the `translate` step writes each of the others from the checked draft, within its share of the budget, with the same sections. Translations are beta and labelled as such to readers who choose them.",
			"A translation that fails or doesn't fit the budget is skipped and noted on the run (`languages`), and the issue in the first language is saved as usual.",
		],
	},
	{
		title: "What it costs",
		paragraphs: [
			"What each run really cost is recorded per run on the run page: every model call with its step, model, tokens and cost, and the run's total (`get_briefing_run`, `calls` and `costUsd`). `costFrom` says whether a call's cost is the one the provider reported or tokens times the price.",
			"No measured figures are published yet. The design note's reference is an estimate from the prompts, not a measurement: about 100,000 input and 6,000 output tokens for six stories from a 30-story shortlist, on an open model of about 30B parameters, around one US cent at list prices, plus about 60,000 input tokens when TypeSafe triages and checks.",
			"FlockStack's own model use is the embeddings that group copies of a story, counted in the account's daily AI allowance.",
		],
	},
	{
		title: "Run it with an agent",
		paragraphs: [
			"Every briefing action is in the Briefings group of the API reference and is an MCP tool of the same name: `list_briefings`, `get_briefing`, `create_briefing`, `update_briefing`, `pause_briefing`, `resume_briefing`, `delete_briefing`, `run_briefing`, `list_briefing_runs`, `get_briefing_run`, `rate_briefing_story`, `add_ai_key`, `list_ai_keys`, `check_ai_key` and `delete_ai_key`.",
			"`get_agent_brief` is the place to start each session: for each briefing it has the last runs (status, cost against the cap, stories per section, whether the draft was held and why, translations that failed), the next run, and `needsOwner`, the drafts waiting for review and the stories with no keep or drop.",
			"What a key can do: a read only key reads briefings and runs. A drafts only key also gives keep or drop. A send with approval key also creates and changes briefings, and its runs, deletes and budget raises wait for the owner. Adding and checking keys takes a full access key or the dashboard. A key limited to one newsletter reaches only that newsletter's briefing.",
		],
		code: {
			title: "An agent sets up a briefing and looks after it",
			value: [
				{ tool: "list_ai_keys", arguments: {} },
				{ tool: "create_briefing", arguments: { newsletter: "my-newsletter", name: "Morning briefing", brief: { topic: "…", audience: "…", useful: "…" }, steps: { query: { keyId: "<a model key>", model: "…" }, triage: { keyId: "<a model key>", model: "…" }, extract: { keyId: "<a model key>", model: "…" }, write: { keyId: "<a model key>", model: "…" }, check: { keyId: "<another model key>", model: "<another model>" } } } },
				{ tool: "update_briefing", arguments: { id: "<the briefing's id>", sections: "<the sections>" } },
				{ tool: "resume_briefing", arguments: { id: "<the briefing's id>" } },
				{ tool: "get_agent_brief", arguments: { newsletter: "my-newsletter" } },
				{ tool: "get_briefing_run", arguments: { id: "<a run's id>" } },
				{ tool: "check_campaign", arguments: { id: "<the draft's campaign id>" } },
			],
		},
	},
];

function paragraphsOf({ paragraphs = [], list = [], after = [] }) {
	return [...paragraphs.flatMap((paragraph) => [paragraph, ""]), ...(list.length ? [...list.map((item) => `- ${item}`), ""] : []), ...after.flatMap((paragraph) => [paragraph, ""])];
}

export function getBriefingsGuideMarkdown() {
	return [
		BRIEFINGS_INTRO,
		"",
		...BRIEFINGS_GUIDE.flatMap((section) => [`### ${section.title}`, "", ...paragraphsOf(section), ...(section.code ? ["```json", JSON.stringify(section.code.value, null, 2), "```", ""] : [])]),
	].join("\n");
}
