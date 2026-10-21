import assert from "node:assert/strict";
import { describe, test } from "node:test";

const scopes = await import("../lib/action-scopes.js");
const { ACTIONS, DASHBOARD_ONLY_ACTIONS, getAction } = await import("../lib/actions/registry.js");
const { canKeyUse } = await import("../lib/actions/define-action.js");
const { getKeyLevel } = await import("../lib/api-key-tokens.js");

// The whole registry, the dashboard-only actions too: a class is owed by every action there is.
const ALL = [...ACTIONS, ...DASHBOARD_ONLY_ACTIONS];

function allowed(preset) {
	return ALL.filter((action) => !action.dashboardOnly && scopes.isPresetAllowed(preset, action, {})).map(({ name }) => name);
}

// Said in words, apart from the table, so a wrong class there can't hide behind a test that reads the same table.
const MUST_RUN_READ_ONLY = ["list_campaigns", "get_campaign", "list_contacts", "export_contacts", "get_overview", "get_growth_report", "preview_campaign_recipients", "list_segments", "get_approval_status"];
const MUST_RUN_DRAFTS = ["create_campaign", "update_campaign", "duplicate_campaign", "send_test_email", "create_template", "update_template", "create_segment", "update_segment", "create_automation", "update_automation", "create_snippet"];
const NEVER_DRAFTS = [
	"send_campaign", "schedule_campaign", "send_campaign_to_more", "resend_campaign", "resume_campaign", "delete_campaign", "delete_template", "delete_segment",
	"import_contacts", "delete_contact", "update_contact_status", "add_contact", "update_newsletter", "activate_automation", "enroll_contacts", "add_domain", "remove_domain",
	"change_plan", "create_api_key", "revoke_api_key", "export_account_data", "create_webhook_endpoint",
];
const ADMIN_ONLY = [
	"create_api_key", "revoke_api_key", "list_api_keys", "list_connected_apps", "revoke_connected_app", "create_webhook_endpoint", "get_billing", "change_plan",
	"export_account_data", "get_account_export", "create_newsletter", "connect_payments", "set_paid_tier", "create_product", "start_pledge_charging",
];
const WAIT_FOR_APPROVAL = [
	"send_campaign", "schedule_campaign", "send_campaign_to_more", "resend_campaign", "resume_campaign", "delete_campaign", "bulk_update_campaigns", "delete_contact",
	"delete_template", "delete_segment", "delete_page", "delete_automation", "activate_automation", "enroll_contacts", "add_domain", "remove_domain", "update_series", "run_series",
];

describe("scope classes", () => {
	test("every action in the registry has a class, and the table names no action that isn't there", () => {
		const names = new Set(ALL.map(({ name }) => name));
		assert.deepEqual(
			ALL.filter(({ name }) => !scopes.ACTION_CLASSES[name]).map(({ name }) => name),
			[],
			"an action without a scope class: add it to lib/action-scopes.js"
		);
		assert.deepEqual(Object.keys(scopes.ACTION_CLASSES).filter((name) => !names.has(name)), [], "a class for an action that doesn't exist");
		for (const className of Object.values(scopes.ACTION_CLASSES)) assert.ok(scopes.SCOPE_CLASSES.includes(className), className);
	});

	test("every action says where its newsletter comes from, so a key limited to one newsletter can't reach the others", () => {
		for (const action of ALL) {
			const target = scopes.getNewsletterTarget(action.name, Object.hasOwn(action.input.shape, "newsletter"));
			assert.ok(["input", "newsletter", "model", "field", "ids", "open", "account", "list_newsletters"].includes(target.kind), action.name);
			if (target.kind === "model") assert.ok(Object.hasOwn(action.input.shape, "id"), `${action.name} names a document by id`);
			if (target.kind === "field") assert.ok(Object.hasOwn(action.input.shape, target.field), `${action.name}.${target.field}`);
			if (target.kind === "newsletter") assert.ok(Object.hasOwn(action.input.shape, "id"), action.name);
			// Anything with an id that names a document of the account is checked against it: an action that takes an id and
			// is none of these reaches the whole account, which a limited key is refused.
			if (target.kind === "account") assert.ok(["admin", "destructive", "write", "read"].includes(scopes.ACTION_CLASSES[action.name]), action.name);
		}
	});

	test("what is read-only is read or admin, what can't be undone is send, destructive or admin", () => {
		const ALLOWED_SMALL = new Set(["update_contact_status", "import_contacts"]);
		for (const action of ALL) {
			const className = scopes.ACTION_CLASSES[action.name];
			if (action.readOnly) assert.ok(["read", "admin"].includes(className), `${action.name} is read-only but ${className}`);
			if (action.destructive && !ALLOWED_SMALL.has(action.name)) assert.ok(["send", "destructive", "admin"].includes(className), `${action.name} can't be undone but is ${className}`);
			if (className === "read") assert.equal(action.readOnly, true, `${action.name} is class read but changes something`);
		}
		for (const name of ALLOWED_SMALL) assert.equal(scopes.ACTION_CLASSES[name], "write", `${name} is gated by size, not by class (SCALE_LIMITS)`);
	});

	test("an input can raise a class: publishing a page, a series that sends by itself", () => {
		assert.equal(scopes.getActionClass("create_page", { status: "draft" }), "write-draft");
		assert.equal(scopes.getActionClass("create_page", { status: "published" }), "write");
		assert.equal(scopes.getActionClass("update_page", { status: "published" }), "write");
		assert.equal(scopes.getActionClass("create_series", { mode: "draft" }), "write");
		assert.equal(scopes.getActionClass("create_series", { mode: "send" }), "send");
		assert.equal(scopes.getActionClass("send_test_email", {}), "write-draft", "a test to the owner is drafting");
		assert.equal(scopes.getActionClass("send_test_email", { to: ["someone@example.com"] }), "send", "a test to addresses the agent names is an email to strangers");
		assert.equal(scopes.getActionClass("nonexistent_action"), null);
		for (const name of ["send_test_email", "create_series", "send_campaign", "delete_campaign", "import_contacts", "add_contact"]) assert.equal(scopes.isGateable(name), true, name);
		for (const name of ["create_campaign", "update_campaign", "list_campaigns", "update_newsletter", "pause_campaign"]) assert.equal(scopes.isGateable(name), false, name);
	});
});

describe("presets over the whole registry", () => {
	test("read only runs reads and nothing else", () => {
		const names = allowed("read_only");
		for (const name of MUST_RUN_READ_ONLY) assert.ok(names.includes(name), name);
		for (const action of ALL.filter((a) => !a.dashboardOnly)) {
			assert.equal(names.includes(action.name), scopes.ACTION_CLASSES[action.name] === "read", action.name);
		}
		assert.ok(!names.includes("list_api_keys") && !names.includes("get_billing") && !names.includes("get_webhook_endpoint"), "what holds secrets or money is admin");
	});

	test("drafts only writes drafts and sends nothing, publishes nothing, deletes nothing, imports nothing and changes no settings", () => {
		const names = allowed("drafts");
		for (const name of [...MUST_RUN_READ_ONLY, ...MUST_RUN_DRAFTS]) assert.ok(names.includes(name), name);
		for (const name of NEVER_DRAFTS) assert.ok(!names.includes(name), `${name} must not run on a drafts key`);
		for (const action of ALL.filter((a) => !a.dashboardOnly)) {
			assert.equal(names.includes(action.name), ["read", "write-draft"].includes(scopes.ACTION_CLASSES[action.name]), action.name);
			if (names.includes(action.name)) assert.equal(action.destructive, false, `${action.name} can't be undone`);
		}
		assert.equal(scopes.isPresetAllowed("drafts", getAction("create_page"), { status: "published" }), false, "a published page isn't a draft");
		assert.equal(scopes.isPresetAllowed("drafts", getAction("create_page"), { status: "draft" }), true);
	});

	test("send with approval runs everything but keys, billing, money and webhooks, and sends the sends and deletes to the owner", () => {
		const names = allowed("send_with_approval");
		for (const name of ADMIN_ONLY) assert.ok(!names.includes(name), `${name} is for full access`);
		for (const action of ALL.filter((a) => !a.dashboardOnly)) {
			assert.equal(names.includes(action.name), scopes.ACTION_CLASSES[action.name] !== "admin", action.name);
		}
		for (const name of WAIT_FOR_APPROVAL) {
			assert.ok(names.includes(name), name);
			assert.equal(scopes.presetNeedsApproval("send_with_approval", scopes.getActionClass(name)), true, `${name} waits for the owner`);
		}
		for (const name of ["create_campaign", "update_campaign", "update_newsletter", "add_contact", "pause_campaign", "unschedule_campaign"]) {
			assert.equal(scopes.presetNeedsApproval("send_with_approval", scopes.getActionClass(name)), false, `${name} runs at once`);
		}
		assert.deepEqual(scopes.PRESET_RULES.send_with_approval.approve, ["send", "destructive"]);
	});

	test("full access runs every action, the ones nobody has classified yet too, and approves nothing", () => {
		assert.equal(allowed("full").length, ACTIONS.length);
		assert.equal(scopes.isPresetAllowed("full", { name: "brand_new_action", permission: "full" }, {}), true);
		assert.equal(scopes.isPresetAllowed("read_only", { name: "brand_new_action", permission: "full" }, {}), false, "an action without a class is for full access only");
		assert.deepEqual(scopes.PRESET_RULES.full.approve, []);
	});

	test("signups only runs add_contact, as it always did", () => {
		assert.deepEqual(allowed("signups"), ["add_contact"]);
	});

	test("the registry's own check, which MCP uses to list tools, agrees with the table", () => {
		for (const preset of scopes.PRESETS) {
			assert.deepEqual(
				ACTIONS.filter((action) => canKeyUse(preset, action)).map(({ name }) => name),
				allowed(preset),
				preset
			);
		}
		for (const action of DASHBOARD_ONLY_ACTIONS) for (const preset of scopes.PRESETS) assert.equal(canKeyUse(preset, action), false, `${action.name} for ${preset}`);
	});

	test("a key from before levels counts as signups only, an explicit full as full, and an unknown level as nothing more than signups", () => {
		assert.equal(getKeyLevel({}), "signups");
		assert.equal(getKeyLevel({ level: "signups" }), "signups");
		assert.equal(getKeyLevel({ level: "full" }), "full");
		assert.equal(getKeyLevel({ level: "read_only" }), "read_only");
		assert.equal(getKeyLevel({ level: "root" }), "signups");
		assert.equal(getKeyLevel(null), "signups");
	});

	test("every preset is described in plain words", () => {
		for (const preset of scopes.PRESETS) {
			const info = scopes.PRESET_INFO[preset];
			assert.ok(info.label && info.description.endsWith(".") && info.can && info.cannot && info.consent.length > 0, preset);
			assert.ok(!/\b(scope|class|preset)\b/i.test(info.description), `${preset}: no jargon in ${info.description}`);
		}
	});
});

describe("OAuth scopes", () => {
	test("each scope maps to a preset and the highest one wins", () => {
		assert.deepEqual(scopes.OAUTH_ACCESS_SCOPES, { "flockstack:read": "read_only", "flockstack:drafts": "drafts", "flockstack:send": "send_with_approval", "flockstack:full": "full" });
		assert.equal(scopes.getPresetOfScopes(["openid", "flockstack:drafts"]), "drafts");
		assert.equal(scopes.getPresetOfScopes(["flockstack:read", "flockstack:send", "flockstack:drafts"]), "send_with_approval");
		assert.equal(scopes.getPresetOfScopes(["flockstack:full"]), "full");
		assert.equal(scopes.getPresetOfScopes(["openid", "email"]), null);
		assert.equal(scopes.getPresetOfScopes(undefined), null);
	});

	test("the owner can narrow what an app asked for, never widen it", () => {
		assert.deepEqual(scopes.getPresetsUpTo("send_with_approval"), ["read_only", "drafts", "send_with_approval"]);
		assert.deepEqual(scopes.getPresetsUpTo("read_only"), ["read_only"]);
		assert.equal(scopes.lowerPreset("full", "drafts"), "drafts");
		assert.equal(scopes.lowerPreset("drafts", "full"), "drafts");
		assert.equal(scopes.lowerPreset("full", undefined), "full");
	});
});
