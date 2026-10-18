// What FlockStack Cloud's marketing site shows on shared pages, resolved like lib/site-extensions.js (to
// components/marketing/SiteExtensions.jsx). The open source has none of them: each is null and renders nothing.
// SiteAnalytics also counts the steps shared markup names with data-goal attributes (autocapture keeps them). It goes
// in the layouts of FlockStack's own pages only, never the root layout, a newsletter's pages, the pages readers use or
// the admin; on the dashboard it gets the signed-in user and account. FooterCookies is the "Cookie settings" list item
// beside the legal links. SupportChat, the help chat, goes beside SiteAnalytics on the same pages (the signed-in user on
// the dashboard), opens in place from links to siteExtensions.supportChatPath and renders [data-support-chat].
export const SiteAnalytics = null;
export const FooterCookies = null;
export const SiteBand = null;
export const SigninAside = null;
export const FooterCredit = null;
export const FooterNote = null;
export const PricingNote = null;
export const SupportChat = null;
