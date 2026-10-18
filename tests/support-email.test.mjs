import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { after, afterEach, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, as, platformEmails, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { setAi } from "./stubs/opennext-cloudflare.mjs";

// "Email a human" sends the conversation and the person's account email to support, only when they click it, and the
// legal pages say what the assistant keeps.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		email: await import("../app/api/support/email/route.js"),
		chat: await import("../app/api/support/chat/route.js"),
		legal: await import("../lib/legal.js"),
		subprocessors: await import("../lib/subprocessors.js"),
		privacy: await import("../app/(site)/privacy/page.js"),
		regions: await import("../lib/docs/regions.js"),
	};
});

afterEach(() => setAi(null));
after(() => app?.stop());

const CONVERSATION = [
	{ role: "user", content: "My domain won't verify after two days." },
	{ role: "assistant", content: "I don't know. The docs don't cover that." },
];

function post(route, path, body, user) {
	const request = new Request(`http://localhost:3000${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.10" },
		body: JSON.stringify(body),
	});
	const run = () => route.POST(request);
	return user ? as(user, run) : anonymous(run);
}

const sendToHuman = (body, user) => post(m.email, "/api/support/email", body, user);

describe("email a human", () => {
	test("sends the conversation and the account email to support, answerable to that email, and nothing more", async () => {
		const user = await signIn("needs-help@example.com");
		const before = platformEmails.length;
		const response = await sendToHuman({ messages: CONVERSATION }, user);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { sent: true });
		const sent = platformEmails.slice(before);
		assert.equal(sent.length, 1);
		const [email] = sent;
		assert.deepEqual(email.to, ["hello@flockstack.io"]);
		assert.equal(email.reply_to, "needs-help@example.com");
		assert.equal(email.subject, "Support chat from needs-help@example.com");
		assert.equal(
			email.text,
			[
				"needs-help@example.com asked for a person from the support assistant on localhost:3000. Reply to this email to answer them.",
				"",
				"Customer:",
				"My domain won't verify after two days.",
				"",
				"FlockStack assistant:",
				"I don't know. The docs don't cover that.",
				"",
			].join("\n")
		);
		assert.ok(!email.text.includes(String(user.accountId)) && !email.text.includes(String(user.userId)));
	});

	test("goes to SUPPORT_EMAIL when it is set", async () => {
		const user = await signIn("needs-help-2@example.com");
		await withEnv({ SUPPORT_EMAIL: "support@example.com" }, () => sendToHuman({ messages: CONVERSATION }, user));
		assert.deepEqual(platformEmails.at(-1).to, ["support@example.com"]);
	});

	test("needs a signed-in person, and says where to write otherwise", async () => {
		const before = platformEmails.length;
		const response = await sendToHuman({ messages: CONVERSATION });
		assert.equal(response.status, 401);
		assert.match((await response.json()).error.message, /hello@flockstack\.io/);
		assert.equal(platformEmails.length, before);
	});

	test("refuses an empty conversation, and a fourth in an hour", async () => {
		const user = await signIn("needs-help-3@example.com");
		assert.equal((await sendToHuman({ messages: [] }, user)).status, 400);
		for (let index = 0; index < 3; index++) assert.equal((await sendToHuman({ messages: CONVERSATION }, user)).status, 200);
		const before = platformEmails.length;
		assert.equal((await sendToHuman({ messages: CONVERSATION }, user)).status, 429);
		assert.equal(platformEmails.length, before);
	});

	test("asking the assistant emails nobody: only the click does", async () => {
		setAi({ run: async () => ({ response: "Use the Export page [1]." }) });
		const user = await signIn("asks-only@example.com");
		const before = platformEmails.length;
		assert.equal((await post(m.chat, "/api/support/chat", { messages: [{ role: "user", content: "How do I export my data?" }] }, user)).status, 200);
		assert.equal(platformEmails.length, before);
	});

	test("the assistant's server code writes nothing: no model, only the rate-limit counters", async () => {
		for (const file of ["support-assistant", "support-corpus", "support-prompt", "support-search", "support-page-text"]) {
			const source = await readFile(`${ROOT}lib/marketing/${file}.js`, "utf8");
			assert.doesNotMatch(source, /@\/models\//, file);
			assert.doesNotMatch(source, /console\.\w+\([^)]*content/, file);
		}
	});
});

describe("the legal pages", () => {
	const textOf = (markup) => markup.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&").replace(/\s+/g, " ");

	test("say what the assistant keeps: nothing on the server, Workers AI for the answer, the support inbox only on request", async () => {
		const { SUPPORT_CHAT_STORED, SUPPORT_CHAT_RETENTION, SUPPORT_AI_PROVIDER_NOTE, getLegalTodos } = m.legal;
		const todos = getLegalTodos().map(([name]) => name);
		assert.ok(!todos.includes("SUPPORT_CHAT_STORED") && !todos.includes("SUPPORT_CHAT_RETENTION"));
		assert.match(SUPPORT_CHAT_STORED, /^nothing by FlockStack/);
		assert.match(SUPPORT_CHAT_STORED, /stays in your browser tab/);
		assert.match(SUPPORT_CHAT_STORED, /Cloudflare Workers AI/);
		assert.match(SUPPORT_CHAT_STORED, /If you click Email a human, the conversation and your account email are emailed to our support inbox/);
		assert.doesNotMatch(SUPPORT_CHAT_STORED, /\.$/);
		assert.match(SUPPORT_CHAT_RETENTION, /gone when you close the tab or sign out/);
		assert.match(SUPPORT_CHAT_RETENTION, /support inbox as long as we need it to answer you/);
		assert.match(SUPPORT_AI_PROVIDER_NOTE, /does not use Customer Content processed by Workers AI to train AI models/);

		const privacy = await withEnv({ LEGAL_PREVIEW: "true" }, () => textOf(renderToStaticMarkup(m.privacy.default())));
		assert.ok(privacy.includes(`Stored: ${SUPPORT_CHAT_STORED}. How long: ${SUPPORT_CHAT_RETENTION} ${SUPPORT_AI_PROVIDER_NOTE}`));
		assert.ok(privacy.includes("questions to the support assistant by IP address and user ID"));
		assert.ok(privacy.includes("the support assistant's conversation in that tab's session storage"));
	});

	test("the sub-processors and the regions page agree: messages may be processed on Cloudflare's global network, and nothing is stored", () => {
		const cloudflare = m.subprocessors.SUBPROCESSORS.find(({ name }) => name === "Cloudflare");
		assert.match(cloudflare.purpose, /support assistant on Workers AI,? through AI Gateway with its logging turned off/);
		assert.match(cloudflare.data, /messages typed to the support assistant/);
		assert.match(cloudflare.us, /Workers AI runs on Cloudflare's global network/);
		assert.match(cloudflare.eu, /may be processed outside the EU/);
		assert.match(m.subprocessors.SUBPROCESSORS.find(({ name }) => name.startsWith("Amazon SES")).purpose, /support conversations people choose to email/);
		assert.ok(m.regions.REGION_LEAVES.some((line) => /support assistant.*global network.*stores none of it/.test(line)));
	});

	test("scripts/check-legal.mjs no longer lists the support assistant's placeholders", () => {
		const result = spawnSync("node", ["scripts/check-legal.mjs"], { cwd: ROOT, encoding: "utf8" });
		assert.doesNotMatch(result.stderr, /SUPPORT_CHAT_/);
	});
});
