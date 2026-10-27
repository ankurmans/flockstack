import sanitizeHtml from "sanitize-html";
import { CONTENT_TAGS, KEPT_ATTRIBUTES } from "./clean-html.js";

// The cleaners match tags with patterns; this parses the HTML, so whatever they miss can't run on the
// archive page. Client components import clean-html.js and render-email.js, so the package stays here.
const OPTIONS = {
	allowedTags: CONTENT_TAGS,
	allowedAttributes: {
		...KEPT_ATTRIBUTES,
		img: [
			...KEPT_ATTRIBUTES.img,
			{ name: "loading", values: ["lazy"] },
			{ name: "fetchpriority", values: ["high"] },
			{ name: "decoding", values: ["async"] },
		],
		h1: ["id"], h2: ["id"], h3: ["id"],
		div: [
			{ name: "data-toc", values: [""] },
			{ name: "data-callout", values: [""] },
			{ name: "data-button", values: [""] },
			{ name: "data-paywall", values: [""] },
			{ name: "data-columns", values: [""] },
			{ name: "data-column", values: [""] },
			{ name: "data-file", values: [""] },
			"data-size",
			"data-embed",
			"data-poll",
		],
		sup: [{ name: "data-footnote", values: [""] }],
	},
	allowedEmptyAttributes: ["alt", "data-toc", "data-callout", "data-button", "data-paywall", "data-columns", "data-column", "data-file", "data-footnote"],
	allowedSchemes: ["http", "https", "mailto"],
	allowProtocolRelative: false,
	exclusiveFilter: isOffWebImage,
};

function isOffWebImage(frame) {
	return frame.tag === "img" && !/^https?:\/\//i.test(frame.attribs.src ?? "");
}

export function sanitizeIssueHtml(html) {
	return sanitizeHtml(html, OPTIONS);
}
