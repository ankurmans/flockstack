// The headers every response of the app carries (next.config.mjs sends them with Next.js), and so does every response of the lean
// API Worker (workers/api), which has no Next.js to add them. No imports: next.config.mjs reads this file too.

// No script-src: Next.js's inline scripts would need per-request nonces, which archive pages can't have
// while they're cached (ISR). script-src-attr still blocks inline event handlers everywhere.
export const CONTENT_SECURITY_POLICY = ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "script-src-attr 'none'"].join("; ");

export const SECURITY_HEADERS = [
	{ key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
	{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
	{ key: "X-Frame-Options", value: "DENY" },
	{ key: "X-Content-Type-Options", value: "nosniff" },
	// The origin only, FlockStack's own pages included: a URL like a contacts search can hold a subscriber's email,
	// and the page it leads to can send its referrer to analytics.
	{ key: "Referrer-Policy", value: "strict-origin" },
];
