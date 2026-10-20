// Stock photos from Unsplash's free API (UNSPLASH_ACCESS_KEY), read only on the server. Unsplash's API guidelines, which
// this file follows: photos are hotlinked from the URLs the API returns, every photo used triggers its download endpoint,
// and a photo is credited to its photographer and to Unsplash with links carrying the app's name as utm_source.
const API = "https://api.unsplash.com";
const PHOTO_ID = /^[\w-]{6,24}$/;

export function getUnsplashKey(env = process.env) {
	return String(env.UNSPLASH_ACCESS_KEY ?? "").trim() || null;
}

// The name the app is registered under at Unsplash: utm_source on every link back to them.
export function getUnsplashAppName(env = process.env) {
	return String(env.UNSPLASH_APP_NAME ?? "").trim().toLowerCase() || "flockstack";
}

export function isPhotoId(id) {
	return PHOTO_ID.test(String(id ?? ""));
}

export function withUtm(url, env = process.env) {
	const link = new URL(url);
	link.searchParams.set("utm_source", getUnsplashAppName(env));
	link.searchParams.set("utm_medium", "referral");
	return link.toString();
}

async function call(path, key) {
	let response;
	try {
		response = await fetch(`${API}${path}`, { headers: { authorization: `Client-ID ${key}`, "accept-version": "v1" }, signal: AbortSignal.timeout(8000) });
	} catch (error) {
		console.error("[unsplash] Request failed:", error?.message);
		return { error: "unavailable" };
	}
	if (response.status === 404) return { error: "not_found" };
	if (!response.ok) {
		// 403 is Unsplash's hourly limit; the key itself never shows.
		console.error(`[unsplash] ${path.split("?")[0]} answered ${response.status}`);
		return { error: response.status === 403 ? "rate_limited" : "unavailable" };
	}
	return { data: await response.json() };
}

// The parts of a photo FlockStack uses, with links back to Unsplash as its guidelines ask.
export function toPhoto(raw) {
	return {
		id: String(raw.id),
		description: String(raw.alt_description || raw.description || "").slice(0, 200),
		width: Number(raw.width) || 0,
		height: Number(raw.height) || 0,
		color: raw.color ?? null,
		thumbUrl: raw.urls?.small ?? raw.urls?.thumb ?? "",
		url: raw.urls?.regular ?? "",
		pageUrl: raw.links?.html ? withUtm(raw.links.html) : withUtm("https://unsplash.com/"),
		photographer: {
			name: String(raw.user?.name ?? "").slice(0, 100),
			url: withUtm(raw.user?.links?.html ?? `https://unsplash.com/@${raw.user?.username ?? ""}`),
		},
	};
}

export async function searchPhotos({ query, page = 1, perPage = 24, key }) {
	const params = new URLSearchParams({ query, page: String(page), per_page: String(perPage), content_filter: "high" });
	const { data, error } = await call(`/search/photos?${params}`, key);
	if (error) return { error };
	return { photos: (data.results ?? []).map(toPhoto), total: data.total ?? 0, totalPages: data.total_pages ?? 0 };
}

// Reads the photo from Unsplash by its ID (never from what a client sent) and reports the download its use counts as.
export async function takeUnsplashPhoto({ id, key }) {
	const { data, error } = await call(`/photos/${encodeURIComponent(id)}`, key);
	if (error) return { error };
	const location = data.links?.download_location;
	if (typeof location === "string" && location.startsWith(`${API}/`)) {
		const tracked = await call(location.slice(API.length), key);
		if (tracked.error === "unavailable") console.error("[unsplash] The download wasn't reported");
	}
	return { photo: toPhoto(data) };
}

function escapeHtml(text) {
	return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The credit line: "Photo by <name> on Unsplash", both linked.
export function getCreditHtml(photo) {
	return `<p><em>Photo by <a href="${escapeHtml(photo.photographer.url)}">${escapeHtml(photo.photographer.name || "a photographer")}</a> on <a href="${escapeHtml(withUtm("https://unsplash.com/"))}">Unsplash</a></em></p>`;
}

export function getImageHtml(photo, { width = 600 } = {}) {
	const height = photo.width ? Math.round((photo.height * width) / photo.width) : null;
	return `<img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.description)}" width="${width}"${height ? ` height="${height}"` : ""}>`;
}
