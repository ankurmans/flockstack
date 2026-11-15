import {
	ACTION_CLASSES,
	MAX_ALLOWED_ACTIONS,
	NEWSLETTER_APPROVAL_ACTIONS,
	NEWSLETTER_APPROVAL_CLASSES,
	PRESETS,
	PRESET_INFO,
	PRESET_RULES,
	SCALE_LIMITS,
	SCOPE_CLASSES,
	SCOPE_CLASS_INFO,
	TEAM_ROLE_CLASSES,
} from "@/lib/action-scopes";
import {
	ACTIVITY_EXPORT_LIMIT,
	ACTIVITY_PURGE_PER_RUN,
	ACTIVITY_RETENTION_CHOICES,
	ACTIVITY_RETENTION_DAYS,
	MAX_ACTIVITY_RETENTION_DAYS,
} from "@/lib/agent-activity-rules";
import {
	APPROVAL_TTL_HOURS,
	MAX_PENDING_PER_ACTOR,
	RETRY_AFTER_SECONDS,
	STEP_UP_CLASSES,
	STEP_UP_CODE_MINUTES,
	STEP_UP_MAX_ATTEMPTS,
	buildApprovalRequired,
	getStatusUrl,
} from "@/lib/approval-rules";
import { MAX_ALLOWED_IPS } from "@/lib/ip-allowlist";
import { getWebhookEvent } from "@/lib/webhook-events";

// The Agent safety page and its part of /llms-full.txt, from the numbers and tables the code runs on. Sections: { title, id,
// paragraphs, table: { head, rows }, code: [{ title, code }] }.
const SAMPLE_ID = "6650f1c2e9b1d4a0123456a1";
const SAMPLE_CAMPAIGN = "6650f1c2e9b1d4a0123456bb";

const json = (value) => JSON.stringify(value, null, 2);

const LEVEL_NAMES = {
	read_only: "read_only",
	drafts: "drafts",
	send_with_approval: "send_with_approval",
	full: "full",
	signups: "signups",
};

function examplesOf(className) {
	const names = Object.entries(ACTION_CLASSES)
		.filter(([, value]) => value === className)
		.map(([name]) => name);
	return `${names.slice(0, 4).join(", ")}${names.length > 4 ? `, and ${names.length - 4} more` : ""}`;
}

function countOf(className) {
	return Object.values(ACTION_CLASSES).filter((value) => value === className).length;
}

export function getAgentSafetyGuide(appUrl) {
	const pending = {
		_id: SAMPLE_ID,
		action: "send_campaign",
		summary: `Send a campaign now (id: ${SAMPLE_CAMPAIGN})`,
		expiresAt: "2026-10-22T09:00:00.000Z",
	};
	const required = buildApprovalRequired(pending, appUrl);
	const approved = {
		id: SAMPLE_ID,
		status: "approved",
		action: "send_campaign",
		className: "send",
		summary: pending.summary,
		preview: {
			title: "Send a campaign now",
			lines: [
				["Subject", "Issue 12: the long weekend"],
				["Goes to", "4,210 contacts"],
				["Segment", "No segment: the whole audience"],
				["When", "Now"],
			],
			links: [{ label: "Open the draft", href: `${appUrl}/campaigns/${SAMPLE_CAMPAIGN}` }],
		},
		newsletterId: "6650f1c2e9b1d4a0123456aa",
		actor: { type: "key", id: "6650f1c2e9b1d4a0123456b2", name: "Newsletter assistant" },
		via: "api",
		reason: "key",
		createdAt: "2026-10-21T08:00:00.000Z",
		expiresAt: pending.expiresAt,
		decidedAt: "2026-10-21T08:12:00.000Z",
		note: "Looks good, go ahead",
		executed: true,
		execution: { state: "done", error: null },
		result: { id: SAMPLE_CAMPAIGN, status: "sending" },
		statusUrl: getStatusUrl(appUrl, SAMPLE_ID),
		retryAfter: null,
	};
	const decided = getWebhookEvent("approval.decided");

	return [
		{
			id: "idea",
			title: "Agents propose, you approve",
			paragraphs: [
				"An AI agent can do everything up to the point of no return: read your numbers, write drafts, prepare a send. Before anything goes out to subscribers or can't be undone, it stops and asks you. You see what it wants to do, the exact input it will use and who asked, and you approve or reject it on the Approvals page. Nothing happens in between.",
				"Three things make that safe. Each API key and each connected app has a level that says what it may do. The sends and deletes of a send with approval key are stored as requests instead of being run. And everything an agent changes is in a log you can read.",
			],
		},
		{
			id: "levels",
			title: "Levels",
			paragraphs: [
				"Pick a level when you make an API key, and when you connect an app such as ChatGPT or Claude (the consent page offers them). A key that already existed keeps its meaning: full is full, and a key from before levels is signups only.",
			],
			table: {
				head: ["Level", "In the API", "What it can do", "What it can't"],
				rows: PRESETS.map((preset) => [PRESET_INFO[preset].label, LEVEL_NAMES[preset], PRESET_INFO[preset].can, PRESET_INFO[preset].cannot]),
			},
		},
		{
			id: "classes",
			title: "What each level allows",
			paragraphs: [
				"Every action belongs to one class, and a level allows some classes. This is the table the check reads, so it is also the list of what a key can reach: the REST API answers 403 forbidden for the rest, and MCP only lists the tools a key can run.",
			],
			table: {
				head: ["Class", "What it is", "Examples", ...PRESETS.slice(0, 4).map((preset) => PRESET_INFO[preset].label)],
				rows: SCOPE_CLASSES.map((className) => [
					`${SCOPE_CLASS_INFO[className].label} (${countOf(className)})`,
					SCOPE_CLASS_INFO[className].description,
					examplesOf(className),
					...PRESETS.slice(0, 4).map((preset) => {
						const rules = PRESET_RULES[preset];
						if (!rules.allow.includes(className)) return "No";
						return rules.approve.includes(className) ? "Asks you first" : "Yes";
					}),
				]),
			},
			paragraphs2: [
				"Publishing a page is more than writing a draft, so a drafts key can save a page as a draft but not publish one. A series that sends by itself counts as a send. add_contact is the one action a signups only key can run. The API's reference says on each endpoint which level it needs.",
			],
		},
		{
			id: "limits",
			title: "Limit a key",
			paragraphs: [
				"A key can be limited to one newsletter: it reaches nothing of the account's others, lists show only that newsletter, and anything that reaches the whole account (creating newsletters, domains, billing) is refused. A key can have a cap on calls a day, counted per UTC day with reads included, past which it answers 429 daily_cap_reached until midnight UTC. And it can expire: after its time it answers 401 unauthorized, like a revoked key. The API keys page shows each key's level, newsletter, calls today and expiry.",
				`Limit a key to some actions. create_api_key takes actions, a list of up to ${MAX_ALLOWED_ACTIONS} action names its level allows: the key runs those and nothing else, reads included, and answers 403 forbidden for the rest. It can still read the approvals it asked for. Sending is its own class (send), which no drafts key has, so a key that only sends is a send_with_approval or full key with actions such as send_campaign, schedule_campaign and get_campaign: it can't change contacts or settings.`,
				`Limit a key to some addresses. allowedIps takes up to ${MAX_ALLOWED_IPS} IPv4 or IPv6 addresses or CIDR ranges, such as 203.0.113.0/24. A request from anywhere else answers 403 forbidden without saying which addresses are allowed, and the attempt is in the activity log. The address is the one Cloudflare sees; an X-Forwarded-For header never opens the list.`,
			],
			code: [
				{
					title: "A drafting key for one newsletter, capped, for 30 days",
					code: `curl -X POST "${appUrl}/api/v1/api-keys" \\
  -H "Authorization: Bearer $FLOCKSTACK_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({ name: "Drafting assistant", level: "drafts", newsletter: "weekly", dailyCap: 500, expiresInDays: 30 })}'`,
				},
			],
		},
		{
			id: "approval",
			title: "The approval flow",
			paragraphs: [
				`A send with approval key does not run the actions in the ${NEWSLETTER_APPROVAL_CLASSES.join(" and ")} classes (sending, scheduling, resuming, activating an automation, deleting, changing domains). It stores them as a request and answers at once. The owner is emailed and sees a banner in the dashboard.`,
				`The owner reads the request on the Approvals page: the subject, who it goes to and how many, the exact input. Approve runs the stored action once, as the key that asked, with that input; reject drops it and the agent reads the owner's note. Nobody decided in ${APPROVAL_TTL_HOURS} hours: it expires and nothing runs.`,
				`The request can't be edited after it is made: a hash covers the action and its input, and the action that runs is built from what was stored. If the campaign or automation was edited since, approving asks the owner to look again before it runs. Asking twice with the same input is the same request. A key has at most ${MAX_PENDING_PER_ACTOR} waiting at once.`,
				"Only a signed-in person can approve, in the dashboard. No API key, no connected app and no MCP tool can, and there is no endpoint for it: an agent can never approve its own request, even with full access.",
			],
			code: [
				{
					title: `REST: 202 Accepted, Retry-After: ${RETRY_AFTER_SECONDS}`,
					code: `POST ${appUrl}/api/v1/campaigns/${SAMPLE_CAMPAIGN}/send\n\n${json(required)}`,
				},
				{
					title: "MCP: a tool result, not an error",
					code: json({ content: [{ type: "text", text: JSON.stringify(required) }], structuredContent: required }),
				},
				{
					title: "Poll: GET /api/v1/approvals/{id}, or the get_approval_status tool",
					code: json(approved),
				},
			],
			paragraphs2: [
				`Poll every retryAfter seconds, or subscribe to the approval.decided webhook and continue when it arrives. status is pending, approved, rejected or expired; executed is true once the approved action ran, and result is what it answered. If it ran and failed, execution.error says why. list_approvals lists a key's own requests.`,
			],
		},
		{
			id: "webhook",
			title: "The approval.decided webhook",
			paragraphs: [decided.description],
			code: [{ title: "approval.decided", code: json({ type: decided.type, timestamp: "2026-10-21T08:12:00.000Z", data: decided.example }) }],
		},
		{
			id: "newsletter",
			title: "Ask me before an agent sends",
			paragraphs: [
				`On the Approvals page each newsletter has a switch. With it on, anything an API key or connected app does in the send and delete classes waits for you, whatever the key's level, full access included, and so do billing changes (${NEWSLETTER_APPROVAL_ACTIONS.join(", ")}). Only you can switch it, in the dashboard, and every change is in the activity log with who made it.`,
				"It is on from the start for every newsletter of an account made since it became the default. A newsletter of an older account keeps what its keys did before, and the Approvals page offers to turn it on.",
				`A send with approval key also sends large changes of contacts to you: an import of more than ${SCALE_LIMITS.perCall} contacts in one call, or more than ${SCALE_LIMITS.perDay} contacts changed (imported or unsubscribed) in a day, because a loop of small changes is the same as one big one.`,
				"An agent can only change a campaign while it is a draft once it asks first: a scheduled campaign was approved as it was, so a send with approval key must unschedule it, edit it and ask again. The same goes for an active automation.",
			],
		},
		{
			id: "activity",
			title: "Agent activity",
			paragraphs: [
				`Every call from an API key or a connected app that changes something or shows contact data is in the log: the action, which key or app, which newsletter, the time, how it ended (ok, failed, denied or waiting for approval), a short summary and the request's ID (the X-Request-Id header of the REST answer). Every step of an approval is there too. Calls that were refused are recorded, so you see what an agent tried.`,
				`The log keeps ids, option names and counts, never the text of an email, a subject, a body or an address. It is kept ${ACTIVITY_RETENTION_DAYS} days, then deleted, unless you choose ${ACTIVITY_RETENTION_CHOICES.filter((days) => days !== ACTIVITY_RETENTION_DAYS).join(", ")} days on the Agent activity page (${MAX_ACTIVITY_RETENTION_DAYS} at most, because the database has a size cap). A change applies to what is already kept: the hourly purge deletes at most ${ACTIVITY_PURGE_PER_RUN.toLocaleString("en-US")} rows per retention choice in one run, and the next run takes the rest. Calls of every kind, reads included, are also counted per key and per day.`,
				"Each entry names its client: the API key's name, the connected app's (such as Claude or ChatGPT), or the person. A team member's changes in the dashboard are in the same log with their name and role, never their email, and so are the owner's changes to how agents are held: Ask me before an agent sends, the code to approve, team approvers and this retention. The owner's other dashboard changes are not.",
				`See it on the Agent activity page, with filters for the key or app, the action, the newsletter and the result, and a page for each key, or read it with list_agent_activity, which also filters by client and by actorType (key, app or person). export_agent_activity returns the same rows as CSV, ${ACTIVITY_EXPORT_LIMIT.toLocaleString("en-US")} at most per export. A key or app reads its own entries; a key made with auditRead reads the whole account's. No key has it unless you create one with it.`,
			],
			code: [
				{
					title: "An entry of list_agent_activity",
					code: json({
						id: "6650f1c2e9b1d4a0123456c3",
						at: "2026-10-21T08:00:03.000Z",
						kind: "call",
						actor: { type: "key", id: "6650f1c2e9b1d4a0123456b2", name: "Newsletter assistant" },
						via: "api",
						action: "schedule_campaign",
						className: "send",
						newsletterId: "6650f1c2e9b1d4a0123456aa",
						status: "approval_required",
						errorCode: null,
						summary: `Schedule a campaign (id: ${SAMPLE_CAMPAIGN})`,
						requestId: "req_8f2c61d0a94b37e1c5d2",
						approvalId: SAMPLE_ID,
					}),
				},
			],
		},
		{
			id: "approvers",
			title: "Who approves",
			paragraphs: [
				"You, the account owner, approve or reject every request. You can also name team members as approvers for chosen newsletters on the Approvals page: they decide the requests of those newsletters, whatever their role, and nothing else. They can't approve a billing change or a request that reaches the whole account, and they can't change who approves or how. An approval's entry in the activity log names who decided and how.",
				`Code by email to approve. With it on, approving a request in the ${STEP_UP_CLASSES.join(" or ")} class also takes a 6-digit code emailed to the person approving, valid ${STEP_UP_CODE_MINUTES} minutes and ${STEP_UP_MAX_ATTEMPTS} tries, so a signed-in browser left open isn't enough. Rejecting never needs one.`,
			],
		},
		{
			id: "team-roles",
			title: "Team roles",
			paragraphs: ["A team member's role says what they may do in the dashboard, by the same classes as a key's level. Keys, billing, money, exports and approval settings stay the owner's."],
			table: {
				head: ["Role", "Classes", "Can"],
				rows: Object.entries(TEAM_ROLE_CLASSES).map(([role, classes]) => [role, classes.join(", "), classes.map((className) => SCOPE_CLASS_INFO[className].label).join(", ")]),
			},
		},
		{
			id: "apps",
			title: "Connected apps",
			paragraphs: [
				"ChatGPT, Claude and Grok Bot connect with OAuth. The consent page lists the levels up to what the app asked for, in plain words, and starts on send with approval when the app asked for full access. What you pick is what the app may do, and the API keys page lists it for each app. An app can ask for less with the OAuth scopes flockstack:read, flockstack:drafts, flockstack:send (send with approval) and flockstack:full, and never gets more than it asked for. Apps connected before levels existed keep full access until you disconnect them.",
				"On an account with more than one newsletter, the consent page also asks which newsletters the app reaches: all of them, or only one. Limited to one, it is held like a key limited to one newsletter, on every call.",
			],
		},
		{
			id: "setups",
			title: "Setups that work",
			paragraphs: [
				"Read only analyst. A key with level read_only, limited to the newsletter it reports on. It can read campaigns, reports and subscribers, and change nothing. Give it a daily cap and an expiry if it is a one-off analysis.",
				"Drafting assistant. A key with level drafts. It writes campaigns, templates, segments and automations and sends test emails to you, and you send them yourself from the dashboard. It can't schedule, publish, import or delete, so there is nothing to approve.",
				"Send with approval operator. A key with level send_with_approval, or ChatGPT or Claude connected on that level. It drafts, edits settings and contacts, then asks you to send or schedule. You read the request on the Approvals page, or let your own automation read approval.decided. This is the setup to start with for an agent that runs your newsletter.",
				"Full access is for your own scripts on a server you control. If an agent has it, keep Ask me before an agent sends on for the newsletter so its sends still wait for you, and give the key an IP allow-list.",
			],
		},
		{
			id: "dashboard-only",
			title: "What no key can do",
			paragraphs: [
				"Deciding an approval, turning on Ask me before an agent sends, the code to approve, naming team approvers and the activity log's retention are done by a signed-in person in the dashboard only. They are not in the REST API, the OpenAPI document or the MCP tools. A key below full access also can't create keys, open billing, change prices or payments, manage webhooks or export the account.",
			],
		},
	];
}

export function getAgentSafetyMarkdown(appUrl) {
	return getAgentSafetyGuide(appUrl)
		.flatMap(({ title, paragraphs = [], table, paragraphs2 = [], code = [] }) => [
			`### ${title}`,
			"",
			...paragraphs.flatMap((paragraph) => [paragraph, ""]),
			...(table
				? [
						`| ${table.head.join(" | ")} |`,
						`| ${table.head.map(() => "---").join(" | ")} |`,
						...table.rows.map((row) => `| ${row.map((cell) => String(cell).replaceAll("|", "/")).join(" | ")} |`),
						"",
					]
				: []),
			...paragraphs2.flatMap((paragraph) => [paragraph, ""]),
			...code.flatMap(({ title: caption, code: body }) => [`${caption}:`, "", "```", body, "```", ""]),
		])
		.join("\n");
}
