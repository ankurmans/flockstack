// What an API key or an app connected with OAuth may do, in one place. Every action of the registry belongs to one scope
// class; a key's preset (its level) allows some classes, and may send two of them to the owner for approval instead of
// running them. tests/agent-scopes.test.mjs fails when an action has no class here, and checks each preset against the
// whole registry. Plain JavaScript with no imports: the dashboard, the docs and the tests read it too.

export const SCOPE_CLASSES = ["read", "write-draft", "write", "send", "destructive", "admin"];

// Plain words for each class, as the docs and the dashboard show them.
export const SCOPE_CLASS_INFO = {
	read: { label: "Read", description: "Looks at data and changes nothing." },
	"write-draft": { label: "Write drafts", description: "Creates and edits drafts: campaigns, templates, segments, automations that don't go out, and the content plan." },
	write: { label: "Change settings and content", description: "Changes what is live but sends nothing: settings, pages, contacts, tags." },
	send: { label: "Send", description: "Starts or schedules subscriber emails, or sends private messages to creators. Can't be undone once they go out." },
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
		consent: ["See your newsletters, campaigns, contacts and reports", "Write drafts: campaigns, templates, segments and automations", "Plan content: items, days, visuals and review requests", "Send test emails to you", "Not send, schedule, publish, delete or import anything"],
		description: "Reads everything and writes drafts: campaigns, templates, segments and automations that don't go out. Can't send, schedule, publish, delete, import or touch settings.",
		can: "Read everything. Create and edit draft campaigns, templates, snippets, segments and automations, plan content (items, days, visuals, review requests), and send test emails to you.",
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
		"read_image_source", "open_campaign_collaboration", "list_editor_threads", "list_editor_collaborators",
		"get_reader_retention_settings", "list_cancellation_responses",
		"get_sponsorship_report", "get_sponsorship_settings", "list_sponsorship_placements", "list_sponsorship_slots", "list_sponsorship_bookings", "get_sponsorship_booking", "list_sponsorship_assets", "preview_sponsorship_asset",
		"get_group_settings", "list_group_subscriptions", "get_group_subscription",
		"get_reply_rules", "get_assistant_settings",
		"get_subscription_revenue_report", "export_subscription_revenue_report",
		"get_creator_match_settings", "get_creator_matches", "list_creator_conversations", "get_creator_conversation",
		"get_issue_links", "list_mailing_lists", "list_subscriber_perks", "preview_campaign_as_reader", "list_newsletter_authors", "get_best_send_time", "get_reader_settings", "list_replies", "get_agent_brief", "get_brand_fleet", "get_overview", "get_growth_report", "compare_issues", "get_site_report", "export_report",
		"list_newsletters", "get_newsletter", "check_newsletter_slug",
		"list_pages", "get_page", "get_navigation", "list_issue_tags", "get_link_page",
		"list_campaigns", "get_campaign", "get_campaign_report", "list_link_clicks", "preview_campaign_cleanup", "preview_campaign_recipients",
		"list_campaign_versions", "get_campaign_version", "get_campaign_progress", "check_campaign", "get_content_calendar", "preview_feed",
		"list_content_items", "get_content_item", "get_content_plan", "list_content_revisions", "list_editorial_batches", "get_editorial_batch",
		"list_series", "list_series_runs", "list_briefings", "get_briefing", "list_briefing_runs", "get_briefing_run", "list_ai_keys", "list_templates", "get_template", "list_snippets",
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
		"get_pledge_report", "list_pledges", "get_pledge_charging", "list_offers", "get_offer", "list_gifts", "list_gift_links", "list_comps",
		"list_products", "get_product", "list_orders", "get_order",
		"list_images", "list_media", "list_media_folders", "search_stock_photos", "search_gifs", "get_ai_usage",
		"list_agent_activity", "list_approvals", "get_approval_status",
	],
	"write-draft": [
		"checkpoint_campaign_collaboration", "create_editor_thread", "reply_editor_thread", "resolve_editor_thread",
		"prepare_sponsorship_block", "detach_sponsorship_booking", "update_sponsorship_creative", "upload_sponsorship_asset",
		"chat_with_assistant",
		"create_short_post_digest",
		"create_campaign", "update_campaign", "duplicate_campaign", "send_test_email", "restore_campaign_version",
		"create_template", "update_template", "create_snippet", "update_snippet",
		"create_segment", "update_segment", "create_segment_snapshot",
		"create_automation", "update_automation", "create_automation_from_template",
		"send_welcome_test_email",
		"create_page", "update_page",
		"upload_image", "upload_file", "move_media", "rename_media_folder", "use_stock_photo",
		"generate_image", "rewrite_text", "suggest_subject_lines", "suggest_preview_text", "draft_social_posts",
		// Planning: items, days, visuals and review requests of the content calendar. None of it sends, schedules or publishes.
		"create_content_item", "import_content_items", "update_content_item", "set_content_slot", "reorder_content_items",
		"attach_content_asset", "set_content_assets", "link_content_campaign", "request_content_review", "record_content_publication", "restore_content_revision",
		"create_editorial_batch", "update_editorial_batch", "apply_editorial_pattern", "request_batch_review",
		// The owner's keep or drop on a briefing's story: it teaches the ranker and changes nothing that goes out.
		"rate_briefing_story",
	],
	write: [
		"refresh_subscription_revenue",
		"set_creator_match_settings", "set_creator_conversation",
		"index_issue_links", "upsert_mailing_list", "set_contact_lists", "upsert_subscriber_perk", "upsert_newsletter_author", "archive_newsletter_author", "set_campaign_author", "update_reader_settings", "archive_reply", "update_newsletter", "update_navigation", "update_link_page",
		"unschedule_campaign", "undo_campaign_send", "pause_campaign", "update_campaign_archive", "update_published_issue",
		"add_contact", "update_contact_status", "import_contacts", "approve_held_signups", "create_gift_link",
		"add_tag", "remove_tag", "set_tag_color", "create_custom_field", "update_custom_field", "set_contact_field", "retry_removal",
		"create_form", "update_form", "update_popup_settings",
		"create_post_import", "start_post_import",
		"add_redirect", "import_redirects",
		"update_referral_settings", "add_referral_codes", "fulfill_referral_rewards",
		"set_recommendation_settings", "add_recommendation", "update_recommendation",
		"moderate_comment", "set_comment_settings", "block_commenter", "unblock_commenter",
		"create_audio_version", "update_audio_version", "update_audio_settings",
		"create_poll", "update_poll", "create_survey", "update_survey",
		"pause_automation", "check_domain",
		"grant_comp_access", "resend_gift", "resend_order_email",
		"create_series",
		"create_briefing", "update_briefing", "pause_briefing", "resume_briefing",
	],
	send: [
		"request_sponsorship", "email_sponsorship_manager", "email_sponsorship_invoice",
		"invite_group_seat", "send_group_manager_link",
		"send_creator_intro", "reply_creator_intro",
		"resume_newsletter_sending", "schedule_campaign", "send_campaign", "send_campaign_to_more", "resend_campaign", "resume_campaign",
		"activate_automation", "enroll_contacts",
		"update_series", "run_series",
		// A briefing run spends the account's own model and search money and emails the test address, like run_series makes an issue.
		"run_briefing",
	],
	destructive: [
		"remove_editor_thread",
		"remove_sponsorship_asset",
		"revoke_group_seat",
		"delete_campaign", "bulk_update_campaigns",
		"delete_page", "delete_template", "delete_snippet", "delete_segment", "delete_automation",
		"delete_contact", "reject_held_signups", "delete_tag", "delete_custom_field",
		"delete_form", "rotate_magic_link", "delete_redirect", "remove_recommendation",
		"delete_audio_version", "delete_poll", "delete_survey", "delete_series", "delete_briefing", "delete_ai_key",
		"onboard_brand_domains", "add_domain", "remove_domain",
		"revoke_comp_access", "revoke_gift_link",
		"delete_content_item", "delete_editorial_batch",
	],
	admin: [
		"set_reader_retention_settings", "refresh_reader_billing", "schedule_reader_pause", "cancel_reader_pause", "resume_reader_subscription", "accept_reader_save_offer", "cancel_reader_subscription",
		"set_sponsorship_settings", "save_sponsorship_placement", "save_sponsorship_slot", "accept_sponsorship_booking", "approve_sponsorship_creative", "create_sponsorship_invoice", "refresh_sponsorship_invoice", "cancel_sponsorship_booking",
		"set_group_subscriptions", "create_group_checkout", "refresh_group_subscription", "open_group_billing_portal", "list_group_invoices",
		"set_reply_rules",
		"create_assistant_grant",
		"import_stripe_subscribers", "select_team_workspace", "accept_team_invitation", "list_team_members", "invite_team_member", "update_team_member",
		"bootstrap_newsletter", "preview_agent_workspace", "claim_agent_workspace", "create_newsletter",
		"add_ai_key", "check_ai_key",
		"create_api_key", "revoke_api_key", "list_api_keys", "list_connected_apps", "revoke_connected_app",
		"list_webhook_endpoints", "get_webhook_endpoint", "create_webhook_endpoint", "update_webhook_endpoint", "delete_webhook_endpoint",
		"rotate_webhook_secret", "send_test_webhook", "list_webhook_deliveries", "resend_webhook_delivery",
		"get_billing", "change_plan", "set_extra_emails_limit", "add_dedicated_ip", "set_sent_with_link", "open_billing_portal",
		"export_account_data", "get_account_export",
		"connect_payments",
		"set_paid_tier", "create_paid_tier", "update_paid_tier", "delete_paid_tier", "reorder_paid_tiers", "set_supporter_name",
		"set_pledges", "cancel_pledge", "start_pledge_charging", "stop_pledge_charging",
		"create_offer", "update_offer", "delete_offer", "set_launch_banner", "set_gifts", "set_gift_links",
		"create_product", "update_product", "archive_product", "set_product_file",
		"decide_approval", "set_agent_approval", "decide_content_review",
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
	// A briefing that sends once its checks pass (not accepted yet) sends by itself, and one allowed to spend more than the default
	// of the account's own model money per run, or any paid search, spends what can't be taken back: both wait like a send.
	create_briefing: (input) => (isBriefingSend(input) ? "send" : "write"),
	update_briefing: (input) => (isBriefingSend(input) ? "send" : "write"),
	// A test email to the owner is part of drafting; one to addresses the agent names is an email to strangers.
	send_test_email: (input) => (Array.isArray(input.to) && input.to.length > 0 ? "send" : "write-draft"),
};

// DEFAULT_BUDGET_USD and the default discoveryBudgetUsd (lib/briefing-rules.js), repeated here: this file imports nothing.
const BRIEFING_DEFAULT_BUDGET_USD = 0.25;
function isBriefingSend(input) {
	return input.reviewMode === "send_if_checks_pass" || Number(input.budgetUsd ?? 0) > BRIEFING_DEFAULT_BUDGET_USD || Number(input.discovery?.discoveryBudgetUsd ?? 0) > 0;
}

export function getActionClass(name, input = {}) {
	const base = ACTION_CLASSES[name] ?? null;
	return base && ELEVATIONS[name] ? ELEVATIONS[name](input ?? {}) : base;
}

// Whether a call of this action can wait for the owner's approval (its class, its input, or the size of the change): its MCP tool
// and REST operation then have the approval_required answer next to the action's own.
export function isGateable(name) {
	const classes = [ACTION_CLASSES[name], getActionClass(name, { mode: "send", to: ["someone@example.com"], reviewMode: "send_if_checks_pass" })];
	return classes.some((className) => NEWSLETTER_APPROVAL_CLASSES.includes(className)) || Object.hasOwn(SCALE_COUNTS, name);
}

// Read actions that show contact data: they are recorded in the activity log although they change nothing.
export const CONTACT_DATA_READS = [
	"refresh_reader_billing", "list_cancellation_responses",
	"list_sponsorship_bookings", "get_sponsorship_booking", "refresh_sponsorship_invoice",
	"get_creator_conversation", "list_creator_conversations",
	"preview_campaign_as_reader", "list_replies",
	"list_group_subscriptions", "get_group_subscription", "list_group_invoices",
	"list_contacts", "get_contact", "export_contacts", "preview_campaign_recipients",
	"list_poll_voters", "list_survey_responses", "export_survey_responses",
	"list_referrals", "get_referral_leaderboard", "list_comments", "list_comment_reports",
	"list_supporters", "list_orders", "get_order", "list_pledges", "list_gifts", "list_comps",
];

// Actions that change contacts one call or one batch at a time: how many of them a call changes, for SCALE_LIMITS. Signups only
// keys are for websites and are never held back by it.
export const SCALE_COUNTS = {
	set_contact_lists: () => 1,
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
	"get_reader_retention_settings", "set_reader_retention_settings", "list_cancellation_responses",
	"get_sponsorship_settings", "set_sponsorship_settings",
	"get_group_settings", "set_group_subscriptions",
	"resume_newsletter_sending",
	"get_newsletter", "update_newsletter", "send_welcome_test_email", "get_magic_link", "rotate_magic_link",
	"get_paid_tier", "set_paid_tier", "get_paid_report", "list_paid_tiers", "create_paid_tier", "update_paid_tier", "delete_paid_tier", "reorder_paid_tiers",
	"list_supporters", "set_supporter_name", "set_pledges", "get_pledge_report", "list_pledges", "start_pledge_charging", "get_pledge_charging", "stop_pledge_charging",
	"create_offer", "list_offers", "set_launch_banner", "set_gifts", "set_gift_links", "list_gifts", "grant_comp_access", "revoke_comp_access", "list_comps",
];

const MODEL_BY_ID = {
	EditorThread: ["reply_editor_thread", "resolve_editor_thread", "remove_editor_thread"],
	Contact: ["refresh_reader_billing", "schedule_reader_pause", "cancel_reader_pause", "resume_reader_subscription", "accept_reader_save_offer", "cancel_reader_subscription"],
	SponsorshipBooking: ["prepare_sponsorship_block", "detach_sponsorship_booking", "get_sponsorship_report","get_sponsorship_booking", "accept_sponsorship_booking", "update_sponsorship_creative", "approve_sponsorship_creative", "create_sponsorship_invoice", "refresh_sponsorship_invoice", "email_sponsorship_invoice", "email_sponsorship_manager", "cancel_sponsorship_booking", "upload_sponsorship_asset", "list_sponsorship_assets", "preview_sponsorship_asset", "remove_sponsorship_asset"],
	GroupSubscription: ["get_group_subscription", "refresh_group_subscription", "invite_group_seat", "revoke_group_seat", "send_group_manager_link", "list_group_invoices", "open_group_billing_portal"],
	CreatorConversation: ["get_creator_conversation", "reply_creator_intro", "set_creator_conversation"],
	Reply: ["archive_reply"],
	SitePage: ["get_page", "update_page", "delete_page"],
	Campaign: ["open_campaign_collaboration", "checkpoint_campaign_collaboration", "list_editor_threads", "list_editor_collaborators", "create_editor_thread", "get_issue_links",
		"get_campaign", "get_campaign_report", "list_link_clicks", "update_campaign", "delete_campaign", "duplicate_campaign", "send_test_email",
		"schedule_campaign", "unschedule_campaign", "undo_campaign_send", "send_campaign", "send_campaign_to_more", "resend_campaign", "pause_campaign", "resume_campaign",
		"update_campaign_archive", "update_published_issue", "get_campaign_progress", "check_campaign", "preview_campaign_cleanup", "preview_campaign_recipients", "list_campaign_versions", "get_campaign_version", "restore_campaign_version",
	],
	SeriesPlan: ["update_series", "delete_series", "run_series", "list_series_runs"],
	Briefing: ["get_briefing", "update_briefing", "pause_briefing", "resume_briefing", "delete_briefing", "run_briefing", "list_briefing_runs"],
	BriefingRun: ["get_briefing_run", "rate_briefing_story"],
	ContentItem: [
		"get_content_item", "update_content_item", "delete_content_item", "set_content_slot", "attach_content_asset", "set_content_assets", "link_content_campaign",
		"request_content_review", "decide_content_review", "record_content_publication", "list_content_revisions", "restore_content_revision",
	],
	EditorialBatch: ["get_editorial_batch", "update_editorial_batch", "delete_editorial_batch", "apply_editorial_pattern", "request_batch_review"],
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
	GiftLink: ["revoke_gift_link"],
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
	reorder_content_items: { field: "ids", model: "ContentItem" },
};

const OPEN = [
	"check_newsletter_slug", "preview_feed", "search_recommendable_newsletters", "list_audio_voices", "list_automation_templates",
	"list_images", "upload_image", "upload_file", "list_media", "list_media_folders", "move_media", "rename_media_folder",
	"search_stock_photos", "search_gifs", "read_image_source", "use_stock_photo", "get_ai_usage", "rewrite_text", "list_domains", "get_payments_status",
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
