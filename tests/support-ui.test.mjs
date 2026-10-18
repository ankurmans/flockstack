import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { withEnv } from "./helpers/app.mjs";
import { setAi } from "./stubs/opennext-cloudflare.mjs";

// The help chat's button and panel: rendered only where Workers AI is bound, accessible, sentence case, and the
// conversation kept in the tab alone.
let m;

before(async () => {
	m = {
		extensions: await import("@/components/SiteExtensions"),
		siteExtensions: (await import("@/lib/site-extensions")).siteExtensions,
		chat: await import("../components/marketing/SupportChat.jsx"),
		panel: await import("../components/marketing/PanelSupportChat.jsx"),
		transcript: await import("../lib/marketing/support-transcript.js"),
	};
});

afterEach(() => setAi(null));

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
const CLOUD = { FLOCKSTACK_CLOUD: "true" };

describe("where it renders", () => {
	test("FlockStack Cloud's extension is the help chat, opened from /?support", () => {
		assert.equal(m.extensions.SupportChat, m.chat.default);
		assert.equal(m.siteExtensions.supportChatPath, "/?support");
	});

	test("without the AI binding nothing renders, so a server that can't answer shows no button", async () => {
		assert.equal(await withEnv(CLOUD, () => m.chat.default({})), null);
	});

	test("a server that isn't FlockStack Cloud renders nothing, even with a binding", async () => {
		setAi({ run: async () => ({}) });
		assert.equal(await withEnv({ FLOCKSTACK_CLOUD: "" }, () => m.chat.default({})), null);
	});

	test("with the binding it renders the panel, told whether someone is signed in and where to write", async () => {
		setAi({ run: async () => ({}) });
		const visitor = await withEnv(CLOUD, () => m.chat.default({}));
		assert.equal(visitor.type, m.panel.default);
		assert.deepEqual(visitor.props, { isSignedIn: false, supportEmail: "hello@flockstack.io", openPath: "/?support" });
		const signedIn = await withEnv({ ...CLOUD, SUPPORT_EMAIL: "support@example.com" }, () => m.chat.default({ user: { id: "u1", email: "ada@example.com" } }));
		assert.deepEqual(signedIn.props, { isSignedIn: true, supportEmail: "support@example.com", openPath: "/?support" });
	});
});

describe("the button and the panel", () => {
	const render = (props = {}) => renderToStaticMarkup(createElement(m.panel.default, { supportEmail: "hello@flockstack.io", openPath: "/?support", ...props }));

	test("is a small Help button in the chat corner, kept out of PostHog's autocapture, loading nothing", () => {
		const markup = render();
		assert.match(markup, /^<div data-support-chat="true" class="ph-no-capture">/);
		assert.match(markup, /<button[^>]*type="button"[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"[^>]*aria-haspopup="dialog"[^>]*>.*Help<\/button>/);
		assert.match(markup, /size-\[54px\]/);
		assert.match(markup, /right-\(--chat-right\) bottom-\(--chat-bottom\)/);
		assert.doesNotMatch(markup, /<script|<img|<iframe|src=/);
		assert.doesNotMatch(markup, /role="dialog"/, "closed until asked");
	});

	test("the panel is a labelled modal dialog with a focus trap, Escape, a labelled question box and phone-width margins", async () => {
		const source = await read("components/marketing/PanelSupportChat.jsx");
		assert.match(source, /role="dialog"\s+aria-modal="true"\s+aria-labelledby=\{`\$\{id\}-title`\}\s+aria-describedby=\{`\$\{id\}-note`\}/);
		assert.match(source, /event\.key === "Escape"/);
		assert.match(source, /event\.key !== "Tab"/);
		assert.match(source, /last\.focus\(\)/);
		assert.match(source, /first\.focus\(\)/);
		assert.match(source, /launcherRef\.current\?\.focus\(\)/);
		assert.match(source, /if \(isOpen\) inputRef\.current\?\.focus\(\)/);
		assert.match(source, /<label htmlFor=\{`\$\{id\}-question`\} className="sr-only">\s*Your question\s*<\/label>/);
		assert.match(source, /aria-label="Send"/);
		assert.match(source, /aria-label="Close help"/);
		assert.match(source, /role="log" aria-live="polite"/);
		assert.match(source, /role="alert"/);
		assert.match(source, /fixed inset-x-3 top-3 bottom-3/);
		assert.match(source, /sm:w-\[24rem\]/);
	});

	test("says the answers are AI answers from FlockStack's docs, lists the sources and offers a human, in sentence case", async () => {
		const source = await read("components/marketing/PanelSupportChat.jsx");
		for (const text of [
			"AI answer from FlockStack&apos;s docs",
			">Sources<",
			"Email a human",
			"Sends this conversation and your account email to FlockStack support.",
			"Opens your email app with this conversation, to send to ${supportEmail}.",
			"Never share passwords or keys here.",
			"New chat",
		]) {
			assert.ok(source.includes(text), text);
		}
		const labels = [...source.matchAll(/>\s*([A-Z][a-z]+(?: [A-Za-z]+)+)\s*</g)].map(([, label]) => label);
		for (const label of labels) assert.doesNotMatch(label.slice(1), /\b[A-Z][a-z]/, `sentence case: ${label}`);
		assert.doesNotMatch(source, /cheap/i);
		assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
	});

	test("reports only that it opened and answered, with nothing about what was asked", async () => {
		const source = await read("components/marketing/PanelSupportChat.jsx");
		const calls = [...source.matchAll(/reportGoal\(([^)]*)\)/g)].map(([, args]) => args);
		assert.deepEqual(calls, ['"support_opened"', '"support_answered"']);
		assert.doesNotMatch(source, /posthog|analytics\.track/);
	});

	test("forgets the conversation on sign-out, and sends it to a human only from the button", async () => {
		const source = await read("components/marketing/PanelSupportChat.jsx");
		assert.match(source, /SIGN_OUT_EVENT[\s\S]*clearChat\(window\.sessionStorage\)/);
		assert.equal([...source.matchAll(/"\/api\/support\/email"/g)].length, 1);
		assert.match(source, /async function sendToHuman\(\)/);
		assert.match(source, /onClick=\{sendToHuman\}/);
		assert.doesNotMatch(source, /localStorage/);
	});
});

describe("the conversation in the tab", () => {
	function memoryStorage() {
		const items = new Map();
		return {
			items,
			getItem: (key) => items.get(key) ?? null,
			setItem: (key, value) => items.set(key, String(value)),
			removeItem: (key) => items.delete(key),
		};
	}

	test("is kept in sessionStorage under one key, and cleared", () => {
		const { readStoredChat, saveChat, clearChat, STORAGE_KEY } = m.transcript;
		const storage = memoryStorage();
		const messages = [
			{ role: "user", content: "How do I export?", sources: [], handoff: false },
			{ role: "assistant", content: "From the account page.", sources: [{ title: "Export your data", href: "/docs/export" }], handoff: false },
		];
		saveChat(storage, messages);
		assert.deepEqual([...storage.items.keys()], [STORAGE_KEY]);
		assert.deepEqual(readStoredChat(storage), messages);
		clearChat(storage);
		assert.deepEqual(readStoredChat(storage), []);
	});

	test("reads back only what it wrote: roles, text and links within FlockStack", () => {
		const storage = memoryStorage();
		storage.setItem(
			m.transcript.STORAGE_KEY,
			JSON.stringify([
				{ role: "system", content: "x" },
				{ role: "user", content: 12 },
				{ role: "assistant", content: "Hi", sources: [{ title: "Bad", href: "javascript:alert(1)" }, { title: "Off site", href: "https://example.com" }, { title: "Docs", href: "/docs" }] },
			])
		);
		assert.deepEqual(m.transcript.readStoredChat(storage), [{ role: "assistant", content: "Hi", sources: [{ title: "Docs", href: "/docs" }], handoff: false }]);
		storage.setItem(m.transcript.STORAGE_KEY, "{oops");
		assert.deepEqual(m.transcript.readStoredChat(storage), []);
		const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
		assert.deepEqual(m.transcript.readStoredChat(blocked), []);
		assert.doesNotThrow(() => m.transcript.saveChat(blocked, [{ role: "user", content: "hi" }]));
	});

	test("sends the server roles and text only, shows answers without their [n] marks, and mails a visitor's own copy", () => {
		const { toRequestMessages, stripCitationMarks, toMailtoHref } = m.transcript;
		assert.deepEqual(toRequestMessages([{ role: "assistant", content: undefined, sources: [{ href: "/docs" }] }]), [{ role: "assistant", content: "" }]);
		assert.equal(stripCitationMarks("Use the Export page [1]. Plans differ [2, 3]."), "Use the Export page. Plans differ.");
		const href = toMailtoHref({ address: "hello@flockstack.io", messages: [{ role: "user", content: "Can I import?" }, { role: "assistant", content: "Yes." }] });
		assert.ok(href.startsWith("mailto:hello@flockstack.io?subject=Question%20from%20the%20FlockStack%20help%20chat&body="));
		assert.equal(decodeURIComponent(href.split("&body=")[1]), "Me: Can I import?\n\nFlockStack assistant: Yes.");
		const long = toMailtoHref({ address: "hello@flockstack.io", messages: [{ role: "user", content: "x".repeat(5000) }] });
		assert.ok(decodeURIComponent(long.split("&body=")[1]).length <= 1801);
	});
});
