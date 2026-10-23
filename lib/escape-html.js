// Text safe to put in HTML, in its own file: a module that only needs this (the click redirect's page, the platform emails) must not
// load the Markdown parser that lib/render-email.js carries.
export function escapeHtml(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
