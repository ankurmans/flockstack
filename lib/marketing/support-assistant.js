import "server-only";
import { getCurrentAccount } from "@/lib/auth";
import { getAppHost, getAppUrl } from "@/lib/config";
import { getAiBinding, getSupportAddress } from "@/lib/marketing/support-config";
import { getSupportIndex } from "@/lib/marketing/support-corpus";
import { getSupportContext } from "@/lib/marketing/support-context";
import { DONT_KNOW, buildSystemPrompt, isDontKnow, readCitations, readModelText } from "@/lib/marketing/support-prompt";
import { search } from "@/lib/marketing/support-search";
import { sendPlatformEmail } from "@/lib/platform-email";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";

// FlockStack Cloud's support assistant behind POST /api/support/chat and POST /api/support/email (siteExtensions.
// supportAssistant). Nothing a person types is stored: the conversation lives in their browser tab, comes with each
// question, goes to Workers AI for the answer (with AI Gateway's logs off for it) and is gone. The server keeps only the
// rate-limit counters, keyed by IP address or user ID. Never log a message's text.

// Qwen3 30B (a mixture of experts with 3B active) is the lowest-priced model on Workers AI's price list that follows these
// rules and cites reliably; gpt-oss-20b answers when it fails. Both take a messages array.
export const SUPPORT_MODELS = ["@cf/qwen/qwen3-30b-a3b-fp8", "@cf/openai/gpt-oss-20b"];
// The default gateway is created on its first request. No logs, so the gateway keeps no prompt or answer, and no cache,
// since an answer depends on the account.
export const GATEWAY = { id: "default", skipCache: true, collectLog: false };
const MAX_OUTPUT_TOKENS = 800;

export const CHAT_LIMITS = { maxMessages: 20, maxQuestionChars: 1000, maxAnswerChars: 4000, maxBodyChars: 40_000, modelHistory: 8, excerpts: 4 };

// About 28 neurons an answer (some 3,500 tokens in, 400 out), so 300 a day fit Workers AI's 10,000 free neurons a day.
// Each region's database counts its own.
export const DEFAULT_DAILY_LIMIT = 300;

export const RATE_LIMITS = {
	ip: { name: "support-chat-ip", limit: 12, window: "10 m" },
	ipDaily: { name: "support-chat-ip-day", limit: 60, window: "1 d" },
	user: { name: "support-chat-user", limit: 30, window: "1 h" },
	userDaily: { name: "support-chat-user-day", limit: 80, window: "1 d" },
	email: { name: "support-email-user", limit: 3, window: "1 h" },
	emailDaily: { name: "support-email-user-day", limit: 6, window: "1 d" },
};

export function getSupportDailyLimit(env = process.env) {
	const limit = Number.parseInt(env.SUPPORT_DAILY_LIMIT, 10);
	return Number.isInteger(limit) && limit >= 0 && limit <= 1_000_000 ? limit : DEFAULT_DAILY_LIMIT;
}

function answer(body, status = 200) {
	return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function refuse(status, code, message) {
	return answer({ error: { code, message } }, status);
}

// The conversation as the browser sends it: [{ role: "user" | "assistant", content }], a question last. An assistant
// turn's empty or missing content becomes "": Workers AI refuses `content: null`.
export function readConversation(messages, { endsWithQuestion = true } = {}) {
	const { maxMessages, maxQuestionChars, maxAnswerChars } = CHAT_LIMITS;
	if (!Array.isArray(messages) || messages.length === 0) return { error: "Ask a question first." };
	if (messages.length > maxMessages) return { error: "This conversation is long: start a new one to ask more." };
	const clean = [];
	for (const message of messages) {
		const role = message?.role;
		if (role !== "user" && role !== "assistant") return { error: "That message isn't one the assistant can read." };
		const raw = message.content ?? "";
		if (typeof raw !== "string") return { error: "That message isn't one the assistant can read." };
		const content = raw.trim();
		if (role === "user" && content.length > maxQuestionChars) return { error: `Keep a question under ${maxQuestionChars.toLocaleString("en-US")} characters.` };
		if (role === "assistant" && content.length > maxAnswerChars) return { error: "That message isn't one the assistant can read." };
		if (role === "user" && !content) return { error: "Ask a question first." };
		clean.push({ role, content });
	}
	if (endsWithQuestion && clean.at(-1).role !== "user") return { error: "Ask a question first." };
	if (!clean.some(({ role }) => role === "user")) return { error: "Ask a question first." };
	return { messages: clean };
}

async function readBody(request) {
	const length = Number(request.headers.get("content-length") ?? 0);
	if (length > CHAT_LIMITS.maxBodyChars) return { tooLarge: true };
	const text = await request.text().catch(() => "");
	if (text.length > CHAT_LIMITS.maxBodyChars) return { tooLarge: true };
	try {
		return { body: JSON.parse(text) };
	} catch {
		return { body: null };
	}
}

async function readSignedIn() {
	try {
		return await getCurrentAccount();
	} catch {
		return null;
	}
}

// The first limit that refuses, or null. Short windows first, so a script stopped by them doesn't use up the day.
async function findLimit(checks) {
	for (const { limit, key, code, message } of checks) {
		if (await isRateLimited({ ...limit, key })) return { code, message };
	}
	return null;
}

const TOO_FAST = "You've asked a lot in a short time. Try again in a few minutes, or email a human.";
const DAY_USED = "The assistant has answered all it can today. Email a human instead, or try again tomorrow.";

export async function answerSupportChat(request) {
	const ai = await getAiBinding();
	if (!ai) return refuse(503, "support_unavailable", "The support assistant isn't available on this server.");
	const { body, tooLarge } = await readBody(request);
	if (tooLarge) return refuse(413, "invalid_request", "This conversation is too long: start a new one.");
	const conversation = readConversation(body?.messages);
	if (conversation.error) return refuse(400, "invalid_request", conversation.error);

	const signedIn = await readSignedIn();
	const ip = getClientIp(request.headers);
	const userId = signedIn ? String(signedIn.user.id) : null;
	const limited = await findLimit([
		{ limit: RATE_LIMITS.ip, key: ip, code: "rate_limited", message: TOO_FAST },
		...(userId ? [{ limit: RATE_LIMITS.user, key: userId, code: "rate_limited", message: TOO_FAST }] : []),
		{ limit: RATE_LIMITS.ipDaily, key: ip, code: "daily_limit", message: DAY_USED },
		...(userId ? [{ limit: RATE_LIMITS.userDaily, key: userId, code: "daily_limit", message: DAY_USED }] : []),
		{ limit: { name: "support-chat-day", limit: getSupportDailyLimit(), window: "1 d" }, key: "all", code: "daily_limit", message: DAY_USED },
	]);
	if (limited) return refuse(429, limited.code, limited.message);

	const index = await getSupportIndex(getAppUrl());
	const excerpts = findExcerpts(index, conversation.messages);
	if (excerpts.length === 0) return answer({ answer: NOTHING_FOUND, sources: [], handoff: true, signedIn: Boolean(signedIn) });

	const context = signedIn ? await getSupportContext(signedIn.account) : null;
	const history = toModelHistory(conversation.messages);
	const reply = await askModel(ai, { excerpts, context, history });
	if (!reply) return refuse(502, "support_failed", "The assistant couldn't answer just now. Try again, or email a human.");
	const text = reply.slice(0, CHAT_LIMITS.maxAnswerChars);
	const handoff = isDontKnow(text);
	return answer({ answer: text, sources: handoff ? [] : readCitations(text, excerpts), handoff, signedIn: Boolean(signedIn) });
}

// What the last question matches first; the question before it only fills the rest, for a follow-up like "and on the
// yearly plan?" that names little itself.
export function findExcerpts(index, messages) {
	const questions = messages.filter(({ role }) => role === "user").map(({ content }) => content);
	const { excerpts: limit } = CHAT_LIMITS;
	const found = [...search(index, questions.at(-1), { limit }), ...search(index, questions.slice(-2).join("\n"), { limit })];
	const chunks = [...new Set(found.map(({ chunk }) => chunk))].slice(0, limit);
	return chunks.map((chunk, position) => ({ number: position + 1, title: chunk.title, href: chunk.href, text: chunk.text }));
}

const NOTHING_FOUND =`${DONT_KNOW}: FlockStack's docs don't cover that. Ask about FlockStack, or email a human below.`;

// The latest turns, starting with a question.
export function toModelHistory(messages) {
	const recent = messages.slice(-CHAT_LIMITS.modelHistory);
	const start = recent.findIndex(({ role }) => role === "user");
	return recent.slice(start).map(({ role, content }) => ({ role, content: content ?? "" }));
}

export async function askModel(ai, { excerpts, context, history }) {
	for (const model of SUPPORT_MODELS) {
		try {
			const messages = [{ role: "system", content: buildSystemPrompt({ excerpts, context, model }) }, ...history];
			const result = await ai.run(model, { messages, max_tokens: MAX_OUTPUT_TOKENS, temperature: 0.2 }, { gateway: GATEWAY });
			const text = readModelText(result);
			if (text) return text;
			console.warn(`[support] ${model} gave an empty answer`);
		} catch (error) {
			console.error(`[support] ${model} failed:`, error?.message);
		}
	}
	return null;
}

const SPEAKERS = { user: "Customer", assistant: "FlockStack assistant" };

// "Email a human": only from the person's click, signed in, with what the button says it sends: this conversation and
// their account email, to support, who reply to that address.
export async function emailSupportTranscript(request) {
	const signedIn = await readSignedIn();
	if (!signedIn) return refuse(401, "unauthorized", `Sign in to send this from here, or email ${getSupportAddress()}.`);
	const { body, tooLarge } = await readBody(request);
	if (tooLarge) return refuse(413, "invalid_request", "This conversation is too long to send.");
	const conversation = readConversation(body?.messages, { endsWithQuestion: false });
	if (conversation.error) return refuse(400, "invalid_request", conversation.error);

	const userId = String(signedIn.user.id);
	const limited = await findLimit([
		{ limit: RATE_LIMITS.email, key: userId, code: "rate_limited", message: "You've sent a few already. Support will answer those first." },
		{ limit: RATE_LIMITS.emailDaily, key: userId, code: "rate_limited", message: "You've sent a few already. Support will answer those first." },
	]);
	if (limited) return refuse(429, limited.code, limited.message);

	const email = signedIn.user.email;
	try {
		await sendPlatformEmail({
			to: getSupportAddress(),
			replyTo: email,
			subject: `Support chat from ${email}`,
			text: formatTranscriptEmail({ email, messages: conversation.messages }),
		});
	} catch (error) {
		console.error("[support] Transcript email failed:", error?.message);
		return refuse(502, "support_failed", `It didn't send. Email ${getSupportAddress()} instead.`);
	}
	return answer({ sent: true });
}

export function formatTranscriptEmail({ email, messages }) {
	return [
		`${email} asked for a person from the support assistant on ${getAppHost()}. Reply to this email to answer them.`,
		"",
		...messages.flatMap(({ role, content }) => [`${SPEAKERS[role]}:`, content || "(no answer)", ""]),
	].join("\n");
}
