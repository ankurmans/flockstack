import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { startTestApp } from "./helpers/app.mjs";

// The dashboard's automation and segment editors render every step, trigger and condition they can hold.
let app;
let m;

// The words on the page, with the placeholders and labels of its fields.
const text = (markup) =>
	markup
		.replace(/<[^>]+>/g, (tag) => ` ${[...tag.matchAll(/\b(?:placeholder|aria-label)="([^"]*)"/g)].map(([, value]) => value).join(" ")} `)
		.replace(/&#x27;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ");

const CHOICES = {
	fields: [
		{ key: "plan", label: "Plan", type: "text", options: [], multiple: false },
		{ key: "beta", label: "Beta", type: "boolean", options: [], multiple: false },
		{ key: "renews", label: "Renews", type: "date", options: [], multiple: false },
		{ key: "topics", label: "Topics", type: "list", options: ["news", "tips"], multiple: true },
	],
	tags: ["vip"],
	polls: [{ id: "6650f1c2e9b1d4a0123456a1", question: "Which?", options: ["A", "B"] }],
	issues: [{ id: "6650f1c2e9b1d4a0123456a2", subject: "Issue one", links: [{ index: 0, url: "https://example.com/a" }] }],
	lists: [{ id: "6650f1c2e9b1d4a0123456a3", name: "Launch list" }],
};
const SEGMENTS = [{ id: "6650f1c2e9b1d4a0123456a4", name: "VIPs" }];
const AUTOMATIONS = [{ id: "6650f1c2e9b1d4a0123456a5", name: "Target" }];
const PRODUCTS = [{ id: "6650f1c2e9b1d4a0123456a6", title: "Workbook" }];

const STEPS = [
	{ id: "s1", type: "email", subject: "Welcome", previewText: "", format: "rich", content: "<p>Hi</p>" },
	{ id: "s2", type: "wait", weekday: "friday", time: "09:00", timeZone: "UTC" },
	{ id: "s3", type: "set_field", field: "plan", value: "pro" },
	{ id: "s4", type: "webhook", name: "crm" },
	{
		id: "s5",
		type: "branch",
		condition: { match: "all", conditions: [{ type: "tier", op: "is", value: "paid" }] },
		paths: [
			{ steps: [{ id: "s6", type: "add_tag", tag: "paid" }] },
			{
				steps: [
					{
						id: "s7",
						type: "split",
						paths: [
							{ name: "Left", percent: 50, steps: [{ id: "s8", type: "move", automation: "6650f1c2e9b1d4a0123456a5" }] },
							{ percent: 50, steps: [{ id: "s9", type: "end" }] },
						],
					},
				],
			},
		],
	},
];

function automation(overrides = {}) {
	return {
		id: "6650f1c2e9b1d4a0123456b1",
		newsletterId: "6650f1c2e9b1d4a0123456b2",
		name: "Series",
		status: "draft",
		trigger: { type: "manual" },
		steps: STEPS,
		summary: "",
		pauseReason: null,
		updatedAt: "2026-10-20T00:00:00.000Z",
		enrollments: { active: 3, completed: 4, exited: 1 },
		...overrides,
	};
}

const REPORT_STEPS = [
	{ id: "s1", type: "email", label: "", level: 1, parentId: null, pathIndex: null, waiting: 0, ran: 7, sent: 7, opened: 3 },
	{ id: "s5", type: "branch", label: "", level: 1, parentId: null, pathIndex: null, waiting: 0, ran: 7, pathRuns: [4, 3] },
	{ id: "s6", type: "add_tag", label: "", level: 2, parentId: "s5", pathIndex: 0, waiting: 2, ran: 4 },
];

function report(overrides = {}) {
	return { automation: automation(overrides), entered: 8, exits: { unsubscribed: 1, bounced: 0 }, steps: REPORT_STEPS, rates: {} };
}

before(async () => {
	app = await startTestApp();
	m = {
		FormAutomation: (await import("../components/FormAutomation.jsx")).default,
		EditorTrigger: (await import("../components/EditorTrigger.jsx")).default,
		EditorStep: (await import("../components/EditorStep.jsx")).default,
		FormSegment: (await import("../components/FormSegment.jsx")).default,
		DialogNewAutomation: (await import("../components/DialogNewAutomation.jsx")).default,
		CardEnrollContacts: (await import("../components/CardEnrollContacts.jsx")).default,
		editor: await import("../lib/automation-editor.js"),
		templates: await import("../lib/automation-templates.js"),
	};
});

after(() => app?.stop());

const render = (element) => text(renderToStaticMarkup(element));

describe("the automation page", () => {
	const props = { choices: CHOICES, segments: SEGMENTS, automations: AUTOMATIONS, products: PRODUCTS };

	test("shows the steps as a tree with each path under its branch or split, and what each ran for", () => {
		const out = render(createElement(m.FormAutomation, { automation: automation(), report: report(), ...props }));
		for (const expected of ["Welcome", "Until Friday at 09:00", "Set Plan to pro", "crm", "Matches the conditions?", "paid", "50% / 50%", "Target", "Contacts are done"]) {
			assert.ok(out.includes(expected), expected);
		}
		for (const expected of ["Contacts who match", "Everyone else", "4 contacts took it", "3 contacts took it", "ran for 7", "2 waiting for it", "7 sent, 3 opened"]) {
			assert.ok(out.includes(expected), expected);
		}
		assert.ok(out.includes("Add a step"), "a draft can be added to");
		assert.equal((out.match(/Add a step/g) ?? []).length, 3, "each list that doesn't end in a branch or a split");
		assert.equal((out.match(/ends this list: add the steps that follow it to its paths/g) ?? []).length, 2, "the main list and the second path");
		assert.ok(out.includes("8 Entered"), "the report's numbers");
		assert.ok(!out.includes("One address on each line"), "a manual trigger takes contacts only once it's active");
	});

	test("is fixed while active, and takes contacts by hand for a manual trigger", () => {
		const out = render(createElement(m.FormAutomation, { automation: automation({ status: "active" }), report: report({ status: "active" }), ...props }));
		assert.ok(out.includes("It's active. Pause it"));
		assert.ok(!out.includes("Add a step"));
		assert.ok(out.includes("One address on each line"));
		const other = render(createElement(m.FormAutomation, { automation: automation({ status: "active", trigger: { type: "tag_added", tag: "vip" } }), report: report(), ...props }));
		assert.ok(!other.includes("One address on each line"));
	});

	test("shows the reason it paused", () => {
		const out = render(createElement(m.FormAutomation, { automation: automation({ status: "paused", pauseReason: "Step 1: add a subject" }), report: report(), ...props }));
		assert.ok(out.includes("Paused by FlockStack: Step 1: add a subject"));
		assert.ok(out.includes("Resume"));
	});
});

describe("the trigger editor", () => {
	const TRIGGERS = [
		[{ type: "subscribed", tag: "vip" }, "Only contacts from this source"],
		[{ type: "tag_added", tag: "vip" }, "Trigger Tag"],
		[{ type: "tag_removed", tag: "vip" }, "Trigger Tag"],
		[{ type: "segment_joined", segment: "6650f1c2e9b1d4a0123456a4" }, "Also start it for the contacts already in the segment"],
		[{ type: "segment_left", segment: "6650f1c2e9b1d4a0123456a4" }, "checked about every hour"],
		[{ type: "date_field", field: "renews", offsetDays: -7 }, "Negative days start it before the date"],
		[{ type: "field_changed", field: "plan" }, "Custom field"],
		[{ type: "upgraded" }, "Trigger"],
		[{ type: "downgraded" }, "Trigger"],
		[{ type: "product_bought" }, "Product"],
		[{ type: "referral_credited", referrals: 3 }, "Only when they reach"],
		[{ type: "unengaged", days: 60 }, "No opens or clicks for"],
		[{ type: "link_clicked", url: "https://example.com/a" }, "The link's address"],
		[{ type: "manual" }, "Add contacts from this page"],
		[{ type: "api" }, "enroll_contacts"],
	];

	test("renders every trigger's settings", () => {
		for (const [trigger, expected] of TRIGGERS) {
			const out = render(createElement(m.EditorTrigger, { trigger, onChange() {}, segments: SEGMENTS, choices: CHOICES, products: PRODUCTS, isDisabled: false }));
			assert.ok(out.includes(expected), `${trigger.type}: ${expected}`);
		}
	});
});

describe("the step editor", () => {
	test("renders every step's settings, with the branch's builder, a split's shares and a wait in each form", () => {
		const editor = m.editor;
		const render1 = (step) => render(createElement(m.EditorStep, { step, onChange() {}, isDisabled: false, choices: CHOICES, segments: SEGMENTS, automations: AUTOMATIONS }));
		const [email, wait, setField, webhook, branch] = editor.fromApiSteps(STEPS);
		assert.ok(render1(email).length > 0);
		assert.ok(render1(wait).includes("Day of the week"), "a weekday wait");
		assert.ok(render1({ ...wait, waitMode: "until", until: "2026-12-01T09:00" }).includes("Date and time"));
		assert.ok(render1({ ...wait, waitMode: "duration", amount: 2, unit: "days" }).includes("Amount"));
		assert.ok(render1(setField).includes("Clear the field instead"));
		for (const field of CHOICES.fields) assert.ok(render1({ ...setField, field: field.key, value: field.type === "boolean" ? "true" : "" }).includes("Clear the field instead"), field.key);
		assert.ok(render1(webhook).includes("automation.step"));
		assert.ok(render1(branch).includes("Contacts who match"), "the conditions builder");
		assert.ok(render1({ ...branch, mode: "segment", segment: "6650f1c2e9b1d4a0123456a4" }).includes("Segment"));
		const split = editor.newStep("split");
		assert.ok(render1(split).includes("The shares add up to 100%."));
		assert.ok(render1({ ...split, paths: split.paths.map((path) => ({ ...path, percent: 30 })) }).includes("The shares add up to 60%: they have to add up to 100%."));
		assert.ok(render1(editor.newStep("move")).includes("Pick an automation"));
		assert.ok(render1(editor.newStep("add_tag")).length > 0);
		assert.ok(render1(editor.newStep("end")).includes("done with the automation"));
	});
});

describe("the segment builder", () => {
	test("renders the new conditions, a saved list, and the templates dialog", () => {
		const rules = {
			match: "all",
			conditions: [
				{ type: "tier", op: "is", value: "paid" },
				{ type: "country", op: "is_any_of", values: ["US", "DE"] },
				{ type: "referrals", op: "gte", value: 2 },
				{ type: "source", op: "is_none_of", values: ["api"] },
				{ type: "tag", op: "is_any_of", values: ["vip"] },
				{ type: "poll", poll: "6650f1c2e9b1d4a0123456a1", op: "is_any_of", options: [0] },
				{ type: "issue", campaign: "6650f1c2e9b1d4a0123456a2", action: "clicked", link: 0 },
				{ type: "snapshot", segment: "6650f1c2e9b1d4a0123456a3" },
				{ type: "field", field: "topics", op: "is_none_of", values: ["news"] },
			],
		};
		const newsletter = { id: "6650f1c2e9b1d4a0123456b2", name: "News" };
		const out = render(createElement(m.FormSegment, { newsletter, segment: { id: "x", name: "Mixed", description: "", rules, kind: "dynamic", status: "ready" }, ...CHOICES }));
		for (const expected of ["Condition", "Countries", "Referrals", "credited referrals", "Sources", "Tags", "What they did", "Saved list", "Save as a list"]) assert.ok(out.includes(expected), expected);
		const list = render(createElement(m.FormSegment, { newsletter, segment: { id: "x", name: "Launch list", description: "", rules: { match: "all", conditions: [{ type: "snapshot", segment: "x" }] }, kind: "static", status: "ready", members: 12, savedAt: "2026-10-20T00:00:00.000Z" }, ...CHOICES }));
		assert.ok(list.includes("12 contacts, saved"));
		assert.ok(!list.includes("Save as a list"));

		const templates = m.templates.AUTOMATION_TEMPLATES.map(({ id, name, description }) => ({ id, name, description }));
		const dialog = renderToStaticMarkup(createElement(m.DialogNewAutomation, { newsletterId: "6650f1c2e9b1d4a0123456b2", templates }));
		assert.ok(dialog.includes("New"));
		assert.ok(render(createElement(m.DialogNewAutomation, { newsletterId: null, templates })).includes("New"));
		assert.ok(render(createElement(m.CardEnrollContacts, { id: "x" })).includes("One address on each line"));
	});
});
