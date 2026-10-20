import "server-only";

// Workers AI for the writing tools, the way the support assistant calls it (lib/marketing/support-assistant.js): through
// AI Gateway's "default" gateway with its logs and cache off, Qwen3 30B first and gpt-oss-20b when it fails. Only the text
// a writer selects or an issue's draft goes in, never anything about a reader. Never the Anthropic API. This file stays
// apart from lib/marketing so a server without FlockStack Cloud's extras has it.
export const AI_MODELS = ["@cf/qwen/qwen3-30b-a3b-fp8", "@cf/openai/gpt-oss-20b"];
export const GATEWAY = { id: "default", skipCache: true, collectLog: false };

// The Worker's Workers AI binding (wrangler.jsonc, "ai"), or null: a self-hosted server without one, or `next dev`.
export async function getAiBinding() {
	try {
		const { getCloudflareContext } = await import("@opennextjs/cloudflare");
		const { env } = await getCloudflareContext({ async: true });
		return typeof env?.AI?.run === "function" ? env.AI : null;
	} catch {
		return null;
	}
}

// The model's text, whatever shape Workers AI returns for it: { response } for most models, an OpenAI-like
// { choices } for some, the Responses API's { output } for gpt-oss. A thinking block, if any, is dropped.
export function readModelText(result) {
	if (typeof result === "string") return stripThinking(result);
	const fromChoices = result?.choices?.[0]?.message?.content ?? result?.choices?.[0]?.text;
	const fromOutput = Array.isArray(result?.output)
		? result.output
				.filter((item) => item?.type === "message")
				.flatMap((item) => (Array.isArray(item.content) ? item.content : []))
				.filter((part) => part?.type === "output_text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("")
		: null;
	const text = [result?.response, fromChoices, result?.output_text, fromOutput].find((value) => typeof value === "string" && value.trim());
	return text ? stripThinking(text) : "";
}

function stripThinking(text) {
	return text
		.replace(/<think>[\s\S]*?<\/think>/g, "")
		.replace(/^[\s\S]*?<\/think>/, "")
		.trim();
}

// The first model's non-empty answer, or null when both failed. What was sent is never logged.
export async function askModels(ai, { system, user, maxTokens = 900, temperature = 0.6 }) {
	for (const model of AI_MODELS) {
		try {
			// Qwen3 thinks aloud before answering unless told not to; the thinking would cost output tokens and be dropped.
			const prompt = model.includes("qwen3") ? `${system}\n\n/no_think` : system;
			const messages = [
				{ role: "system", content: prompt },
				{ role: "user", content: user },
			];
			const result = await ai.run(model, { messages, max_tokens: maxTokens, temperature }, { gateway: GATEWAY });
			const text = readModelText(result);
			if (text) return { text, model };
			console.warn(`[ai] ${model} gave an empty answer`);
		} catch (error) {
			console.error(`[ai] ${model} failed:`, error?.message);
		}
	}
	return null;
}
