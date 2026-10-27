import "server-only";
import { actionError } from "@/lib/actions/errors";
import { GATEWAY, getAiBinding } from "@/lib/ai";
import { takeAiRequest } from "@/lib/ai-usage";
import { detectImageType } from "@/lib/image-files";
import { getImageStorageProblem } from "@/lib/image-storage";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-image";

export const AI_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

// Check the JPEG's frame and dimensions before placing provider bytes on the public image store.
export function readGeneratedImage(value) {
	if (typeof value !== "string" || value.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
	const bytes = new Uint8Array(Buffer.from(value, "base64"));
	if (Buffer.from(bytes).toString("base64") !== value) return null;
	if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES || detectImageType(bytes)?.contentType !== "image/jpeg" || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return null;
	let width = 0, height = 0, scan = false;
	for (let at = 2; at + 3 < bytes.length;) {
		if (bytes[at++] !== 255) return null;
		while (bytes[at] === 255) at++;
		const marker = bytes[at++];
		const length = bytes[at] * 256 + bytes[at + 1];
		if (length < 2 || at + length > bytes.length) return null;
		if (marker === 218) { scan = length >= 6 && at + length < bytes.length - 2; break; }
		if ([192, 193, 194].includes(marker)) {
			if (length < 8) return null;
			height = bytes[at + 3] * 256 + bytes[at + 4];
			width = bytes[at + 5] * 256 + bytes[at + 6];
		}
		at += length;
	}
	return scan && width > 0 && height > 0 && width <= 4096 && height <= 4096 ? { bytes, width, height } : null;
}

export async function generateImage(account, prompt) {
	const problem = getImageStorageProblem();
	if (problem) throw actionError("unavailable", problem);
	const ai = await getAiBinding();
	if (!ai) throw actionError("unavailable", "AI images aren't available on this server");
	const usage = await takeAiRequest(account);
	if (!usage.allowed) throw actionError("ai_daily_limit", `You've used all ${usage.limit} AI requests for today. The count starts over at midnight UTC.`);
	let response;
	try {
		response = await ai.run(AI_IMAGE_MODEL, { prompt, steps: 4 }, { gateway: GATEWAY });
	} catch {
		throw actionError("unavailable", "The image couldn't be generated. This attempt was counted; try again later.");
	}
	const image = readGeneratedImage(response?.image);
	if (!image) throw actionError("unavailable", "The AI returned no usable JPEG under 4 MB. This attempt was counted.");
	return { ...image, usage: { used: usage.used, limit: usage.limit, resetsAt: usage.resetsAt }, model: AI_IMAGE_MODEL };
}
