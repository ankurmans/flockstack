// FlockStack Cloud's pieces of the shared pages, in place of components/SiteExtensions.jsx (next.config.mjs and
// tests/setup/hooks.mjs resolve it here where this file exists). Only the analytics and its footer link so far: the rest
// stays empty, as in the open source.
export { default as SiteAnalytics } from "@/components/marketing/SiteAnalytics";
export { default as FooterCookies } from "@/components/marketing/FooterCookies";
export const SiteBand = null;
export const SigninAside = null;
export const FooterCredit = null;
export const FooterNote = null;
export const PricingNote = null;
export const SupportChat = null;
