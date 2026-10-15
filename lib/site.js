import { APP_NAME } from "./config.js";

export const SOURCE_URL = "https://github.com/marclou/mailcheap";

export const TAGLINE = "The affordable newsletter for the agentic era";

// Pages leave openGraph to the public layout: a page's openGraph would replace the layout's, share image
// included. Social cards take the page's title and description from these, and "./" resolves to each page's own
// address.
export const SITE_OPEN_GRAPH = { type: "website", siteName: APP_NAME, locale: "en_US", url: "./" };

export function getPageMetadata({ title, description, path }) {
	return { title, description, alternates: { canonical: path } };
}
