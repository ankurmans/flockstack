// Counts of page views only count people: crawlers, link previews, headless browsers and scripts announce themselves.
const BOT_PATTERN = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|curl|wget|python|axios|go-http/i;

export function isLikelyBot(userAgent) {
	return !userAgent || BOT_PATTERN.test(userAgent);
}
