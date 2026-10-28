// What a discovery adapter throws (docs/BRIEFINGS-DESIGN.md, The adapter interface). The engine turns each into a discovery
// note; none of them may carry a key, so adapters build messages from statuses and the provider's own words, scrubbed.
export class DiscoveryError extends Error {
	constructor(message) {
		super(message);
		this.name = "DiscoveryError";
	}
}

// A published limit was reached. scope: "minute", "hour" or "day"; retryAfterMs when the provider says when it resets.
export class DiscoveryLimitError extends DiscoveryError {
	constructor(message, { scope = "minute", retryAfterMs = null } = {}) {
		super(message);
		this.name = "DiscoveryLimitError";
		this.scope = scope;
		this.retryAfterMs = retryAfterMs;
	}
}

// The provider refused the key.
export class DiscoveryAuthError extends DiscoveryError {
	constructor(message) {
		super(message);
		this.name = "DiscoveryAuthError";
	}
}

export function parseJson(text, provider) {
	try {
		return JSON.parse(text);
	} catch {
		throw new DiscoveryError(`${provider} answered something that isn't JSON: ${String(text ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
	}
}

function isoOrNull(value) {
	if (!value) return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function result({ url, title, snippet = "", publishedAt = null, publisher = "" }) {
	return {
		url: String(url ?? "").trim(),
		title: String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
		snippet: String(snippet ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400),
		publishedAt: isoOrNull(publishedAt),
		publisher: String(publisher ?? "").slice(0, 120),
	};
}
