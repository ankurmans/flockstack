import "server-only";
import { APP_NAME } from "@/lib/config";

const API_URL = "https://api.telegram.org";
const TIMEOUT_MS = 5000;
// Telegram refuses messages over 4,096 characters.
const MAX_LINE_LENGTH = 500;

export function isTelegramConfigured(env = process.env) {
	return Boolean(String(env.TELEGRAM_BOT_TOKEN ?? "").trim() && String(env.TELEGRAM_CHAT_ID ?? "").trim());
}

// What Telegram's HTML mode needs escaped outside its tags.
export function escapeTelegramHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

// The app's name comes first, as a chat can get several apps' alerts. Then a line each: what happened, what to do,
// a link.
export function formatTelegramAlert({ title, lines = [] }) {
	const body = lines.filter(Boolean).map((line) => escapeTelegramHtml(String(line).slice(0, MAX_LINE_LENGTH)));
	return [`<b>${APP_NAME}</b> · ${escapeTelegramHtml(title)}`, ...(body.length > 0 ? ["", ...body] : [])].join("\n");
}

// The token is in the URL, so no error says where the request went.
export async function sendTelegramMessage(text, env = process.env) {
	let response;
	try {
		response = await fetch(`${API_URL}/bot${env.TELEGRAM_BOT_TOKEN.trim()}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID.trim(), text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		throw new Error(`Telegram didn't answer (${error?.name ?? "Error"})`);
	}
	if (response.ok) return;
	const body = await response.json().catch(() => null);
	throw new Error(`Telegram answered ${response.status}${body?.description ? `: ${String(body.description).slice(0, 200)}` : ""}`);
}
