import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { as } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { findAll, renderShallow, submit } from "./helpers/shallow.mjs";

// React resets a form once its action returns, even when the save was refused, so what was typed would be gone. Dashboard
// forms submit through lib/submit-keeping-fields.js instead: the submit's default is prevented, so React never resets
// the form, and the same useActionState action runs with the form's fields.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
let t;
let m;

before(async () => {
	t = await setupAudienceTests();
	m = {
		DialogAddContact: (await import("../components/DialogAddContact.jsx")).default,
		FormAddDomain: (await import("../components/FormAddDomain.jsx")).default,
		FormAddNewsletter: (await import("../components/FormAddNewsletter.jsx")).default,
	};
});

after(() => t?.app.stop());

// Submits the form a component renders with these fields, then runs what useActionState was handed with them, as the
// signed-in user: the server's answer.
async function submitAndSave(user, element, fields, options) {
	const { tree, dispatched, actions } = renderShallow(element, options);
	const forms = findAll(tree, "form");
	assert.equal(forms.length, 1, "one form");
	assert.equal(submit(forms[0], fields), true, "the browser's submit and React's reset of the form are prevented");
	assert.equal(dispatched.length, 1, "useActionState's action got the submit");
	assert.deepEqual(Object.fromEntries(dispatched[0]), fields, "with every field typed");
	return as(user, () => actions[0](null, dispatched[0]));
}

describe("a refused save keeps what was typed", () => {
	test("adding a contact", async () => {
		const user = await t.customer("keep-contact@example.com");
		const element = createElement(m.DialogAddContact, { newsletter: { id: user.newsletterId, name: "News" } });
		const fields = { newsletterId: user.newsletterId, email: "jane@", consent: "on" };
		const result = await submitAndSave(user, element, fields, { expand: ["FormContact"] });
		assert.match(result.error, /email/i);
	});

	test("adding a domain", async () => {
		const user = await t.customer("keep-domain@example.com");
		const element = createElement(m.FormAddDomain, { fromLocalPart: "hi", hasArchiveHost: true });
		const result = await submitAndSave(user, element, { domain: "not a domain", archiveHost: "" });
		assert.ok(result.error, JSON.stringify(result));
	});

	test("a new newsletter", async () => {
		const user = await t.customer("keep-newsletter@example.com");
		const element = createElement(m.FormAddNewsletter, { sharedDomain: null, domains: ["elsewhere.example"], startsFrom: null, isAtLimit: false });
		const fields = { name: "Second news", description: "Every week", fromEmail: "hi@elsewhere.example" };
		const result = await submitAndSave(user, element, fields);
		assert.ok(result.error, JSON.stringify(result));
	});

	test("a submit button's own name and value go with the fields", () => {
		const { tree, dispatched } = renderShallow(createElement(m.FormAddDomain, { fromLocalPart: "hi", hasArchiveHost: false }));
		submit(findAll(tree, "form")[0], { domain: "example.com" }, { submitter: { name: "intent", value: "add" } });
		assert.deepEqual(Object.fromEntries(dispatched[0]), { domain: "example.com", intent: "add" });
	});
});

// The dashboard's components: every form of theirs that a useActionState action submits goes through submitKeepingFields.
test("every dashboard form submits through submitKeepingFields", async () => {
	const DASHBOARD_ACTIONS = /from "@\/app\/(\(app\)|\(account\)|admin|welcome)\//;
	const checked = [];
	for (const file of (await readdir(join(ROOT, "components"))).filter((name) => name.endsWith(".jsx"))) {
		const source = await readFile(join(ROOT, "components", file), "utf8");
		if (!source.includes("useActionState") || !DASHBOARD_ACTIONS.test(source)) continue;
		const forms = [...source.matchAll(/<form\b[^>]*?\baction=\{action\}[^>]*>/gs)].map(([tag]) => tag);
		const onboarding = /onSubmit=\{onSubmit\}/.test(forms.join("")) && /submitKeepingFields\(action\)\(event\)/.test(source);
		for (const tag of forms) assert.ok(tag.includes("onSubmit={submitKeepingFields(action)}") || onboarding, `${file}: ${tag.replace(/\s+/g, " ")}`);
		if (forms.length > 0) checked.push(file);
	}
	for (const file of ["DialogAddContact.jsx", "FormAddDomain.jsx", "FormAddNewsletter.jsx", "FormProfile.jsx", "FormOnboarding.jsx", "CardExtraEmails.jsx", "MenuAccount.jsx"]) {
		assert.ok(checked.includes(file), `${file} was checked`);
	}
});
