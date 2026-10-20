import { APP_NAME } from "./config.js";

export const SOURCE_URL = "https://github.com/ankurmans/flockstack";

// The small link a Free account's emails and website carry (lib/free-plan.js): a paid plan can turn it off.
export const SENT_WITH_TEXT = "Sent with FlockStack";
export const SENT_WITH_URL = "https://flockstack.io/?ref=newsletter-footer";

export const TAGLINE = "The affordable newsletter for the agentic era";

// Pages leave openGraph to the public layout: a page's openGraph would replace the layout's, share image
// included. Social cards take the page's title and description from these, and "./" resolves to each page's own
// address.
export const SITE_OPEN_GRAPH = { type: "website", siteName: APP_NAME, locale: "en_US", url: "./" };

export function getPageMetadata({ title, description, path }) {
	return { title, description, alternates: { canonical: path } };
}
