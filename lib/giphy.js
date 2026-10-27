// GIF search from GIPHY's API (GIPHY_API_KEY), read only on the server. Without the key nothing here runs and the editor
// hides the GIFs tab. GIPHY's terms, which this file follows: a GIF is hotlinked from the address the API returns, results
// are limited to the "g" rating, and the picker says the results are powered by GIPHY.
const API = "https://api.giphy.com/v1/gifs";
export const GIPHY_URL = "https://giphy.com/";

export function getGiphyKey(env = process.env) {
	return String(env.GIPHY_API_KEY ?? "").trim() || null;
}

async function call(path, params, key) {
	let response;
	try {
		response = await fetch(`${API}${path}?${new URLSearchParams({ ...params, api_key: key })}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
	} catch (error) {
		console.error("[giphy] Request failed:", error?.name);
		return { error: "unavailable" };
	}
	if (!response.ok) {
		// 429 is GIPHY's hourly limit; the key itself never shows.
		console.error(`[giphy] ${path} answered ${response.status}`);
		return { error: response.status === 429 ? "rate_limited" : "unavailable" };
	}
	return { data: await response.json().catch(() => null) };
}

// Only a GIF served from GIPHY's own media hosts is used, whatever the answer says.
function isGiphyMedia(url) {
	try {
		const { protocol, hostname } = new URL(url);
		return protocol === "https:" && /^(?:media\d*|i)\.giphy\.com$/.test(hostname);
	} catch {
		return false;
	}
}

function pick(images, names) {
	for (const name of names) {
		const image = images?.[name];
		if (image?.url && isGiphyMedia(image.url)) return { url: image.url, width: Number(image.width) || 0, height: Number(image.height) || 0 };
	}
	return null;
}

// The parts of a GIF FlockStack uses. url is "downsized" (under 2 MB, fine for an email); the grid shows a small copy.
export function toGif(raw) {
	const full = pick(raw?.images, ["downsized", "fixed_width", "original"]);
	const thumb = pick(raw?.images, ["fixed_width_small", "fixed_width", "downsized"]);
	if (!raw?.id || !full || !thumb) return null;
	return {
		id: String(raw.id),
		title: String(raw.title ?? "").slice(0, 200),
		width: full.width,
		height: full.height,
		url: full.url,
		thumbUrl: thumb.url,
		pageUrl: typeof raw.url === "string" && raw.url.startsWith("https://giphy.com/") ? raw.url : GIPHY_URL,
	};
}

export async function searchGifs({ query, offset = 0, limit = 24, key }) {
	const { data, error } = await call("/search", { q: query, limit: String(limit), offset: String(offset), rating: "g", lang: "en" }, key);
	if (error) return { error };
	if (!data || !Array.isArray(data.data)) return { error: "unavailable" };
	const gifs = data.data.map(toGif).filter(Boolean);
	const total = Number(data.pagination?.total_count) || gifs.length;
	const next = offset + (Number(data.pagination?.count) || data.data.length);
	return { gifs, total, nextOffset: next < total && data.data.length > 0 ? next : null };
}

function escapeHtml(text) {
	return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The image to put in a rich campaign's content, never wider than the email.
export function getGifHtml(gif, { width = 480 } = {}) {
	const shown = gif.width ? Math.min(width, gif.width) : width;
	const height = gif.width ? Math.round((gif.height * shown) / gif.width) : null;
	return `<img src="${escapeHtml(gif.url)}" alt="${escapeHtml(gif.title)}" width="${shown}"${height ? ` height="${height}"` : ""}>`;
}
