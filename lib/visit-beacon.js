// What a page tells the website's counter (lib/web-analytics.js): which kind of page it is, from the address the visitor sees,
// and whether the browser asked not to be measured.
const ISSUE_PATH = /\/p\/([a-z0-9][a-z0-9-]{0,119})\/?$/;
const HOME_PATH = /^\/(archive\/[a-z0-9-]+\/?)?$/;

export function readVisitedPage(pathname) {
	const post = ISSUE_PATH.exec(pathname)?.[1];
	if (post) return { kind: "issue", post };
	return { kind: HOME_PATH.test(pathname) ? "home" : "other" };
}

// Do Not Track as the browsers spell it, and Global Privacy Control.
export function hasOptedOut({ navigator: nav = {}, window: win = {} } = {}) {
	return nav.doNotTrack === "1" || win.doNotTrack === "1" || nav.msDoNotTrack === "1" || nav.globalPrivacyControl === true;
}

export function buildVisit({ slug, pathname, referrer }) {
	return { n: slug, ...readVisitedPage(pathname), ...(referrer && { ref: referrer }) };
}
