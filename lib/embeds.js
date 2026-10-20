// Embeds the editor places from a link: a post or video of one of these services. The link is all an issue stores
// (<div data-embed="https://...">); the frame on the web and the card in emails are built from what parseEmbed reads
// out of it, so nothing else a writer or the API sends ever becomes a frame's address.

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const SPOTIFY_KINDS = new Set(["track", "album", "playlist", "episode", "show", "artist"]);

export const EMBED_PROVIDERS = {
	youtube: { name: "YouTube", action: "Watch on YouTube" },
	x: { name: "X", action: "View the post on X" },
	instagram: { name: "Instagram", action: "View on Instagram" },
	tiktok: { name: "TikTok", action: "Watch on TikTok" },
	bluesky: { name: "Bluesky", action: "View the post on Bluesky" },
	spotify: { name: "Spotify", action: "Listen on Spotify" },
	apple_podcasts: { name: "Apple Podcasts", action: "Listen on Apple Podcasts" },
};

function hostOf(url) {
	return url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
}

function youtube(url, host, parts) {
	let id = null;
	if (host === "youtu.be") id = parts[0];
	else if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "music.youtube.com") {
		if (parts[0] === "watch") id = url.searchParams.get("v");
		else if (["shorts", "embed", "live", "v"].includes(parts[0])) id = parts[1];
	}
	if (!YOUTUBE_ID.test(id ?? "")) return null;
	return {
		provider: "youtube",
		id,
		url: `https://www.youtube.com/watch?v=${id}`,
		frame: { src: `https://www.youtube-nocookie.com/embed/${id}`, ratio: "16 / 9" },
		thumbnail: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
	};
}

function x(host, parts) {
	if (host !== "x.com" && host !== "twitter.com") return null;
	const [user, status, id] = parts;
	if (!/^[A-Za-z0-9_]{1,15}$/.test(user ?? "") || status !== "status" || !/^\d{1,25}$/.test(id ?? "")) return null;
	return {
		provider: "x",
		id,
		url: `https://x.com/${user}/status/${id}`,
		frame: { src: `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true`, height: 560 },
	};
}

function instagram(host, parts) {
	if (host !== "instagram.com") return null;
	const [kind, code] = parts;
	if (!["p", "reel", "tv"].includes(kind) || !/^[A-Za-z0-9_-]{5,40}$/.test(code ?? "")) return null;
	return {
		provider: "instagram",
		id: code,
		url: `https://www.instagram.com/${kind}/${code}/`,
		frame: { src: `https://www.instagram.com/${kind}/${code}/embed`, height: 640 },
	};
}

function tiktok(host, parts) {
	if (host !== "tiktok.com") return null;
	const [user, video, id] = parts;
	if (!/^@[A-Za-z0-9_.]{1,40}$/.test(user ?? "") || video !== "video" || !/^\d{1,25}$/.test(id ?? "")) return null;
	return {
		provider: "tiktok",
		id,
		url: `https://www.tiktok.com/${user}/video/${id}`,
		frame: { src: `https://www.tiktok.com/embed/v2/${id}`, height: 740 },
	};
}

// Bluesky's embed frame takes the author's DID; a link with a handle gets the card on the web too.
function bluesky(host, parts) {
	if (host !== "bsky.app") return null;
	const [profile, actor, post, rkey] = parts;
	if (profile !== "profile" || post !== "post" || !/^[A-Za-z0-9]{8,20}$/.test(rkey ?? "")) return null;
	const isDid = /^did:(plc|web):[A-Za-z0-9._:%-]{4,100}$/.test(actor ?? "");
	if (!isDid && !/^[A-Za-z0-9.-]{3,253}$/.test(actor ?? "")) return null;
	return {
		provider: "bluesky",
		id: rkey,
		url: `https://bsky.app/profile/${actor}/post/${rkey}`,
		frame: isDid ? { src: `https://embed.bsky.app/embed/${actor}/app.bsky.feed.post/${rkey}`, height: 420 } : null,
	};
}

function spotify(host, parts) {
	if (host !== "open.spotify.com") return null;
	const offset = /^intl-[a-z-]+$/.test(parts[0] ?? "") ? 1 : 0;
	const [kind, id] = parts.slice(offset);
	if (!SPOTIFY_KINDS.has(kind) || !/^[A-Za-z0-9]{22}$/.test(id ?? "")) return null;
	const isSingle = kind === "track" || kind === "episode";
	return {
		provider: "spotify",
		id,
		url: `https://open.spotify.com/${kind}/${id}`,
		frame: { src: `https://open.spotify.com/embed/${kind}/${id}`, height: isSingle ? 152 : 352 },
	};
}

function applePodcasts(url, host, parts) {
	if (host !== "podcasts.apple.com") return null;
	const [country, podcast, name, show] = parts;
	if (!/^[a-z]{2}$/.test(country ?? "") || podcast !== "podcast" || !/^[a-z0-9-]{1,120}$/.test(name ?? "") || !/^id\d{1,15}$/.test(show ?? "")) return null;
	const episode = url.searchParams.get("i");
	const query = /^\d{1,20}$/.test(episode ?? "") ? `?i=${episode}` : "";
	const path = `${country}/podcast/${name}/${show}${query}`;
	return {
		provider: "apple_podcasts",
		id: show,
		url: `https://podcasts.apple.com/${path}`,
		frame: { src: `https://embed.podcasts.apple.com/${path}`, height: query ? 175 : 450 },
	};
}

// { provider, id, url, frame: { src, height | ratio } | null, thumbnail? } for a link to a post or video of a known
// service, else null. url is rebuilt from what was read, so it can go into markup as it is.
export function parseEmbed(value) {
	const text = String(value ?? "").trim();
	if (!text || text.length > 500 || !URL.canParse(text)) return null;
	const url = new URL(text);
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.username || url.password || url.port) return null;
	const host = hostOf(url);
	const parts = url.pathname.split("/").filter(Boolean).map(decodeSafely);
	const embed =
		youtube(url, host, parts) ??
		x(host, parts) ??
		instagram(host, parts) ??
		tiktok(host, parts) ??
		bluesky(host, parts) ??
		spotify(host, parts) ??
		applePodcasts(url, host, parts);
	return embed ? { ...embed, ...EMBED_PROVIDERS[embed.provider] } : null;
}

function decodeSafely(part) {
	try {
		return decodeURIComponent(part);
	} catch {
		return "";
	}
}
