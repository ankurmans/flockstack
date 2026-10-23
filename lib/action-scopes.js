// What an API key or an app connected with OAuth may do, in one place. Every action of the registry belongs to one scope
// class; a key's preset (its level) allows some classes, and may send two of them to the owner for approval instead of
// running them. tests/agent-scopes.test.mjs fails when an action has no class here, and checks each preset against the
// whole registry. Plain JavaScript with no imports: the dashboard, the docs and the tests read it too.

export const SCOPE_CLASSES = ["read", "write-draft", "write", "send", "destructive", "admin"];

// Plain words for each class, as the docs and the dashboard show them.
export const SCOPE_CLASS_INFO = {
	read: { label: "Read", description: "Looks at data and changes nothing." },
	"write-draft": { label: "Write drafts", description: "Creates and edits drafts: campaigns, templates, segments, automations that don't go out." },
	write: { label: "Change settings and content", description: "Changes what is live but sends nothing: settings, pages, contacts, tags." },
	send: { label: "Send", description: "Starts or schedules emails to subscribers. Can't be undone once they go out." },
	destructive: { label: "Delete or replace", description: "Deletes things or changes how the newsletter sends, such as domains. Can't be undone." },
	admin: { label: "Keys, billing and money", description: "API keys, connected apps, webhooks, billing, exports of everything, prices and payments." },
};

// The levels of an API key and of a connected app. full and signups are the two that existed first, and keep their meaning.
export const PRESETS = ["read_only", "drafts", "send_with_approval", "full", "signups"];

export const PRESET_INFO = {
	read_only: {
		label: "Read only",
		consent: ["See your newsletters, campaigns, contacts and reports", "Change nothing"],
		description: "Looks at campaigns, subscribers and reports. Changes nothing.",
		can: "Read everything, including subscribers.",
		cannot: "Change anything.",
	},
	drafts: {
		label: "Drafts only",
		consent: ["See your newsletters, campaigns, contacts and reports", "Write drafts: campaigns, templates, segments and automations", "Send test emails to you", "Not send, schedule, publish, delete or import anything"],
		description: "Reads everything and writes drafts: campaigns, templates, segments and automations that don't go out. Can't send, schedule, publish, delete, import or touch settings.",
		can: "Read everything. Create and edit draft campaigns, templates, snippets, segments and automations, and send test emails to you.",
		cannot: "Send, schedule, publish, delete, import, change settings or billing.",
	},
	send_with_approval: {
		label: "Send with approval",
		consent: [
			"See your newsletters, campaigns, contacts and reports",
			"Write drafts and change settings, pages, contacts and tags",
			"Ask you first on the Approvals page before it sends, schedules, deletes or imports a lot of contacts",
			"Not create API keys, open billing or change prices",
		],
		description: "Does the work, then asks you before anything goes out or can't be undone. Sends, schedules, deletes and large imports wait for your OK on the Approvals page.",
		can: "Everything drafts can, plus settings, pages, contacts and tags. Sends, schedules, deletes and large imports wait for your approval.",
		cannot: "Create keys, open billing, change prices or payments, or approve its own requests.",
	},
	full: {
		label: "Full access",
		consent: ["Read and change your newsletter, campaigns, contacts and domains", "Send campaigns to your subscribers with no review", "Create and revoke API keys, and open billing"],
		description: "Everything the dashboard does, with no review: sending, deleting, API keys and billing. Keep it on a server you control.",
		can: "Everything.",
		cannot: "Approve requests (only you can, in the dashboard).",
	},
	signups: {
		label: "Signups only",
		consent: ["Add contacts"],
		description: "Adds contacts and nothing else, for signup forms on your website.",
		can: "Add contacts.",
		cannot: "Read or change anything else.",
	},
};

// preset -> the classes it may run, and the ones among them that wait for the owner's approval.
export const PRESET_RULES = {
	read_only: { allow: ["read"], approve: [] },
	drafts: { allow: ["read", "write-draft"], approve: [] },
	send_with_approval: { allow: ["read", "write-draft", "write", "send", "destructive"], approve: ["send", "destructive"] },
	full: { allow: SCOPE_CLASSES, approve: [] },
	signups: { allow: [], approve: [] },
};

// What a newsletter's "ask me before an agent sends" adds to any preset that can send or delete.
export const NEWSLETTER_APPROVAL_CLASSES = ["send", "destructive"];

// A call that changes this many contacts at once, or this many in a day, waits for approval from a send with approval key
// even though its class doesn't: a loop of single changes is the same as one big one.
export const SCALE_LIMITS = { perCall: 25, perDay: 100 };

const CLASSES = {
	read: [
		"get_overview", "get_growth_report", "compare_issues", "get_site_report", "export_report",
		"list_newsletters", "get_newsletter", "check_newsletter_slug",
		"list_pages", "get_page", "get_navigation", "list_issue_tags", "get_link_page",
		"list_campaigns", "get_campaign", "get_campaign_report", "list_link_clicks", "preview_campaign_cleanup", "preview_campaign_recipients",
		"list_campaign_versions", "get_campaign_version", "get_campaign_progress", "check_campaign", "get_content_calendar", "preview_feed",
		"list_series", "list_series_runs", "list_templates", "get_template", "list_snippets",
		"list_contacts", "get_contact", "export_contacts",
		"list_forms", "get_form", "get_popup_settings", "get_magic_link",
		"get_post_import", "list_post_imports", "list_redirects",
		"get_referral_settings", "list_referrals", "get_referral_leaderboard",
		"list_recommendations", "get_recommendation_stats", "search_recommendable_newsletters",
		"list_comments", "get_comment", "list_comment_reports",
		"list_audio_voices", "get_audio_usage", "get_audio_version", "get_audio_settings",
		"list_tags", "list_custom_fields", "list_removals",
		"list_segments", "get_segment", "preview_segment",
		"list_polls", "get_poll", "list_poll_voters", "list_surveys", "get_survey", "list_survey_responses", "export_survey_responses",
		"list_automations", "get_automation", "get_automation_report", "list_automation_templates",
		"list_domains", "get_payments_status",
		"get_paid_tier", "get_paid_report", "list_paid_tiers", "list_supporters",
		"get_pledge_report", "list_pledges", "get_pledge_charging", "list_offers", "get_offer", "list_gifts", "list_comps",
		"list_products", "get_product", "list_orders", "get_order",
		"list_images", "list_media", "list_media_folders", "search_stock_photos", "get_ai_usage",
		"list_agent_activity", "list_approvals", "get_approval_status",
	],
	"write-draft": [
		"create_campaign", "update_campaign", "duplicate_campaign", "send_test_email", "restore_campaign_version",
		"create_template", "update_template", "create_snippet", "update_snippet",
		"create_segment", "update_segment", "create_segment_snapshot",
		"create_automation", "update_automation", "create_automation_from_template",
		"send_welcome_test_email",
		"create_page", "update_page",
		"upload_image", "upload_file", "move_media", "rename_media_folder", "use_stock_photo",
		"rewrite_text", "suggest_subject_lines", "suggest_preview_text", "draft_social_posts",
	],
	write: [
		"update_newsletter", "update_navigation", "update_link_page",
		"unschedule_campaign", "undo_campaign_send", "pause_campaign", "update_campaign_archive", "update_published_issue",
		"add_contact", "update_contact_status", "import_contacts",
		"add_tag", "remove_tag", "set_tag_color", "create_custom_field", "update_custom_field", "set_contact_field", "retry_removal",
		"create_form", "update_form", "update_popup_settings",
		"create_post_import", "start_post_import",
		"add_redirect", "import_redirects",
		"update_referral_settings",
		"set_recommendation_settings", "add_recommendation", "update_recommendation",
		"moderate_comment", "set_comment_settings", "block_commenter", "unblock_commenter",
		"create_audio_version", "update_audio_version", "update_audio_settings",
		"create_poll", "update_poll", "create_survey", "update_survey",
		"pause_automation", "check_domain",
		"grant_comp_access", "resend_gift", "resend_order_email",
		"create_series",
	],
	send: [
		"schedule_campaign", "send_campaign", "send_campaign_to_more", "resend_campaign", "resume_campaign",
		"activate_automation", "enroll_contacts",
		"update_series", "run_series",
	],
	destructive: [
		"delete_campaign", "bulk_update_campaigns",
		"delete_page", "delete_template", "delete_snippet", "delete_segment", "delete_automation",
		"delete_contact", "delete_tag", "delete_custom_field",
		"delete_form", "rotate_magic_link", "delete_redirect", "remove_recommendation",
		"delete_audio_version", "delete_poll", "delete_survey", "delete_series",
		"add_domain", "remove_domain",
		"revoke_comp_access",
	],
	admin: [
		"create_newsletter",
		"create_api_key", "revoke_api_key", "list_api_keys", "list_connected_apps", "revoke_connected_app",
		"list_webhook_endpoints", "get_webhook_endpoint", "create_webhook_endpoint", "update_webhook_endpoint", "delete_webhook_endpoint",
		"rotate_webhook_secret", "send_test_webhook", "list_webhook_deliveries", "resend_webhook_delivery",
		"get_billing", "change_plan", "set_extra_emails_limit", "add_dedicated_ip", "set_sent_with_link", "open_billing_portal",
		"export_account_data", "get_account_export",
		"connect_payments",
		"set_paid_tier", "create_paid_tier", "update_paid_tier", "delete_paid_tier", "reorder_paid_tiers", "set_supporter_name",
		"set_pledges", "cancel_pledge", "start_pledge_charging", "stop_pledge_charging",
		"create_offer", "update_offer", "delete_offer", "set_launch_banner", "set_gifts",
		"create_product", "update_product", "archive_product", "set_product_file",
		"decide_approval", "set_agent_approval",
	],
};

export const ACTION_CLASSES = Object.freeze(
	Object.fromEntries(Object.entries(CLASSES).flatMap(([className, names]) => names.map((name) => [name, className])))
);

// An action's class can depend on its input: publishing a page isn't writing a draft, and a series that sends by itself
// is a send.
const ELEVATIONS = {
	create_page: (input) => (input.status === "published" ? "write" : "write-draft"),
	update_page: (input) => (input.status === "published" ? "write" : "write-draft"),
	create_series: (input) => (input.mode === "send" ? "send" : "write"),
	// A test email to the owner is part of drafting; one to addresses the agent names is an email to strangers.
	send_test_email: (input) => (Array.isArray(input.to) && input.to.length > 0 ? "send" : "write-draft"),
};

export function getActionClass(name, input = {}) {
	const base = ACTION_CLASSES[name] ?? null;
	return base && ELEVATIONS[name] ? ELEVATIONS[name](input ?? {}) : base;
}

// Whether a call of this action can wait for the owner's approval (its class, its input, or the size of the change): its MCP tool
// and REST operation then have the approval_required answer next to the action's own.
export function isGateable(name) {
	const classes = [ACTION_CLASSES[name], getActionClass(name, { mode: "send", to: ["someone@example.com"] })];
	return classes.some((className) => NEWSLETTER_APPROVAL_CLASSES.includes(className)) || Object.hasOwn(SCALE_COUNTS, name);
}

// Read actions that show contact data: they are recorded in the activity log although they change nothing.
export const CONTACT_DATA_READS = [
	"list_contacts", "get_contact", "export_contacts", "preview_campaign_recipients",
	"list_poll_voters", "list_survey_responses", "export_survey_responses",
	"list_referrals", "get_referral_leaderboard", "list_comments", "list_comment_reports",
	"list_supporters", "list_orders", "get_order", "list_pledges", "list_gifts", "list_comps",
];

// Actions that change contacts one call or one batch at a time: how many of them a call changes, for SCALE_LIMITS. Signups only
// keys are for websites and are never held back by it.
export const SCALE_COUNTS = {
	import_contacts: (input) => (Array.isArray(input.contacts) ? input.contacts.length : 0),
	update_contact_status: () => 1,
	// Each signup can send a confirmation email to a stranger.
	add_contact: () => 1,
};

// Things an agent may only change while they haven't gone out: a scheduled campaign was approved as it was, an active
// automation is already sending. `presets` are the presets it applies to; `gated` also applies it to any key while the
// newsletter asks for approval.
export const DRAFT_ONLY = {
	update_campaign: { model: "Campaign", statuses: ["draft"], presets: ["drafts", "send_with_approval"], gated: true },
	restore_campaign_version: { model: "Campaign", statuses: ["draft"], presets: ["drafts", "send_with_approval"], gated: true },
	update_automation: { model: "Automation", statuses: ["draft", "paused"], presets: ["drafts", "send_with_approval"], gated: true },
	update_page: { model: "SitePage", statuses: ["draft"], presets: ["drafts"], gated: false },
};

// Where an action's newsletter comes from, for a key limited to one newsletter and for the activity log:
//   input: a `newsletter` field (an ID or slug; left out means the first one, or the key's)
//   newsletter: the `id` is a newsletter's
//   model: the `id` is a document of this model, which names its newsletter
//   field: another field names a document of this model
//   ids: a list of such documents
//   open: nothing to do with a newsletter, harmless for a limited key
//   account: reaches the whole account, so a limited key can't use it
const NEWSLETTER_ID = [
	"get_newsletter", "update_newsletter", "send_welcome_test_email", "get_magic_link", "rotate_magic_link",
	"get_paid_tier", "set_paid_tier", "get_paid_report", "list_paid_tiers", "create_paid_tier", "update_paid_tier", "delete_paid_tier", "reorder_paid_tiers",
	"list_supporters", "set_supporter_name", "set_pledges", "get_pledge_report", "list_pledges", "start_pledge_charging", "get_pledge_charging", "stop_pledge_charging",
	"create_offer", "list_offers", "set_launch_banner", "set_gifts", "list_gifts", "grant_comp_access", "revoke_comp_access", "list_comps",
];

const MODEL_BY_ID = {
	SitePage: ["get_page", "update_page", "delete_page"],
	Campaign: [
		"get_campaign", "get_campaign_report", "list_link_clicks", "update_campaign", "delete_campaign", "duplicate_campaign", "send_test_email",
		"schedule_campaign", "unschedule_campaign", "undo_campaign_send", "send_campaign", "send_campaign_to_more", "resend_campaign", "pause_campaign", "resume_campaign",
		"update_campaign_archive", "update_published_issue", "get_campaign_progress", "check_campaign", "preview_campaign_cleanup", "preview_campaign_recipients", "list_campaign_versions", "get_campaign_version", "restore_campaign_version",
	],
	SeriesPlan: ["update_series", "delete_series", "run_series", "list_series_runs"],
	IssueTemplate: ["get_template", "update_template", "delete_template"],
	Snippet: ["update_snippet", "delete_snippet"],
	Form: ["get_form", "update_form", "delete_form"],
	PostImport: ["start_post_import", "get_post_import"],
	Redirect: ["delete_redirect"],
	Comment: ["get_comment", "moderate_comment"],
	AudioVersion: ["get_audio_version", "update_audio_version", "delete_audio_version"],
	BulkRemoval: ["retry_removal"],
	Segment: ["get_segment", "update_segment", "delete_segment"],
	Poll: ["get_poll", "update_poll", "delete_poll", "list_poll_voters"],
	Survey: ["get_survey", "update_survey", "delete_survey", "list_survey_responses", "export_survey_responses"],
	Automation: ["get_automation", "update_automation", "activate_automation", "pause_automation", "delete_automation", "get_automation_report", "enroll_contacts"],
	Offer: ["get_offer", "update_offer", "delete_offer"],
	Gift: ["resend_gift"],
	Pledge: ["cancel_pledge"],
	Product: ["get_product", "update_product", "archive_product", "set_product_file"],
	Order: ["get_order", "resend_order_email"],
};

const BY_FIELD = {
	get_audio_usage: { field: "campaign", model: "Campaign" },
	create_audio_version: { field: "campaign", model: "Campaign" },
	suggest_subject_lines: { field: "campaign", model: "Campaign" },
	suggest_preview_text: { field: "campaign", model: "Campaign" },
	draft_social_posts: { field: "campaign", model: "Campaign" },
	block_commenter: { field: "contact", model: "Contact" },
	unblock_commenter: { field: "contact", model: "Contact" },
};

const BY_IDS = {
	bulk_update_campaigns: { field: "ids", model: "Campaign" },
	compare_issues: { field: "ids", model: "Campaign" },
	export_report: { field: "ids", model: "Campaign" },
};

const OPEN = [
	"check_newsletter_slug", "preview_feed", "search_recommendable_newsletters", "list_audio_voices", "list_automation_templates",
	"list_images", "upload_image", "upload_file", "list_media", "list_media_folders", "move_media", "rename_media_folder",
	"search_stock_photos", "use_stock_photo", "get_ai_usage", "rewrite_text", "list_domains", "get_payments_status",
	"list_agent_activity", "list_approvals", "get_approval_status",
];

// One of the table's kinds for every action that has none of its own newsletter field; the others are told apart by their
// input having a `newsletter` field (see getNewsletterTarget).
const TARGETS = new Map([
	...NEWSLETTER_ID.map((name) => [name, { kind: "newsletter" }]),
	...Object.entries(MODEL_BY_ID).flatMap(([model, names]) => names.map((name) => [name, { kind: "model", model }])),
	...Object.entries(BY_FIELD).map(([name, target]) => [name, { kind: "field", ...target }]),
	...Object.entries(BY_IDS).map(([name, target]) => [name, { kind: "ids", ...target }]),
	...OPEN.map((name) => [name, { kind: "open" }]),
	["list_newsletters", { kind: "list_newsletters" }],
]);

export function getTargetOf(name) {
	return TARGETS.get(name) ?? null;
}

// hasNewsletterInput: whether the action's input has a `newsletter` field. Anything left over reaches the account.
export function getNewsletterTarget(name, hasNewsletterInput) {
	const target = TARGETS.get(name);
	if (hasNewsletterInput && (!target || target.kind === "field" || target.kind === "ids")) return { kind: "input", ...(target ?? {}) };
	return target ?? { kind: "account" };
}

// The classes a preset may run an action in. action: the registry's (for the signups level, which is its permission).
export function isPresetAllowed(preset, action, input = {}) {
	if (preset === "full") return true;
	if (preset === "signups") return action.permission === "signups";
	const rules = PRESET_RULES[preset];
	const className = getActionClass(action.name, input);
	return Boolean(rules && className && rules.allow.includes(className));
}

// The legacy level of a key or a grant, then the preset it is: keys made before presets have full or nothing (signups).
export function normalizePreset(level) {
	return PRESETS.includes(level) ? level : "signups";
}

// What the preset itself sends to the owner. Newsletter settings add to this (lib/agent-guard.js).
export function presetNeedsApproval(preset, className) {
	return Boolean(PRESET_RULES[preset]?.approve.includes(className));
}

// Plain-words lines of what a preset lets a connected app or key do, for the consent page and the API keys page.
export function describePreset(preset) {
	const info = PRESET_INFO[preset];
	return info ? [info.can, info.cannot].filter(Boolean) : [];
}

// OAuth: one scope per preset a client can ask for. flockstack:full stays what every client already asks for.
export const OAUTH_ACCESS_SCOPES = {
	"flockstack:read": "read_only",
	"flockstack:drafts": "drafts",
	"flockstack:send": "send_with_approval",
	"flockstack:full": "full",
};

const PRESET_RANK = ["read_only", "drafts", "send_with_approval", "full"];

// The highest preset among the granted scopes, or null when none is a FlockStack scope.
export function getPresetOfScopes(scopes) {
	const presets = (scopes ?? []).map((scope) => OAUTH_ACCESS_SCOPES[scope]).filter(Boolean);
	if (presets.length === 0) return null;
	return presets.reduce((best, preset) => (PRESET_RANK.indexOf(preset) > PRESET_RANK.indexOf(best) ? preset : best));
}

// The presets an owner can narrow a request to on the consent page: the requested one and the ones below it.
export function getPresetsUpTo(preset) {
	const index = PRESET_RANK.indexOf(preset);
	return index === -1 ? [] : PRESET_RANK.slice(0, index + 1);
}

// The lower of two presets: a grant never does more than the app asked for or the owner chose.
export function lowerPreset(a, b) {
	if (!a) return b;
	if (!b) return a;
	return PRESET_RANK.indexOf(a) <= PRESET_RANK.indexOf(b) ? a : b;
}

// What the docs say about who can run an action: the lowest level that may, and what happens to it there.
export function describeActionAccess(action) {
	const className = getActionClass(action.name, {});
	const lowest = ["read_only", "drafts", "send_with_approval", "full"].find((preset) => isPresetAllowed(preset, action, {})) ?? "full";
	const parts = [lowest === "full" ? "Full access only" : `${PRESET_INFO[lowest].label} keys and up`];
	if (action.permission === "signups") parts.push("signups only keys too");
	if (NEWSLETTER_APPROVAL_CLASSES.includes(className)) parts.push("a send with approval key or app waits for the owner's approval first");
	return parts.join(", ");
}
