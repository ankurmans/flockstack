import "server-only";

// Workers AI: the binding, the gateway settings and the readers of what it answers. The text AI asks it only on a server
// with no Anthropic or Groq key (lib/platform-ai.js, which holds the rule); images (lib/ai-images.js) and Briefings' grouping
// embeddings (lib/briefings/group.js) always use it. Through AI Gateway's "default" gateway with its logs and cache off,
// Qwen3 30B first and gpt-oss-20b when it fails. This file stays apart from lib/marketing so a server without FlockStack
// Cloud's extras has it.
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
