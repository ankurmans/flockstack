import { CUSTOM_BUTTON, CUSTOM_PATH, CUSTOM_REPLY_WITHIN } from "./custom-choices.js";
import { formatCompact, formatNumber } from "./format.js";
import { PLANS } from "./plans.js";

// The Custom plan: no price and no checkout, a conversation. It gauges interest, so it says only what is true today, and
// plainly what isn't. tests/custom-plan.test.mjs checks that nothing here claims a feature FlockStack doesn't have.

// What FlockStack doesn't have. The /custom page and the FAQ print it; nothing else may name these.
export const CUSTOM_MISSING = "SOC 2, SSO or SAML, SCIM, audit logs, an uptime SLA and team seats with roles";

export const CUSTOM_NOT_YET = `FlockStack doesn't have ${CUSTOM_MISSING} yet. We build things like these when customers need them, so tell us which ones you would need and we'll build the right ones first. Ticking a box doesn't promise a date.`;

// Words that would claim a feature of a bigger plan. They appear only in CUSTOM_NOT_YET and in the form's own choices.
export const CUSTOM_UNAVAILABLE = /SOC ?2|SSO|SAML|SCIM|audit logs?|\bSLAs?\b|seats|compliance|certified|guarantee/i;

// The card after Max, in the plans slider and the billing page. Everything comes from lib/plans.js's largest plan.
export function getCustomPlan() {
	const max = PLANS.at(-1);
	return {
		id: "custom",
		name: "Custom",
		price: "Let's talk",
		href: CUSTOM_PATH,
		button: CUSTOM_BUTTON,
		emails: `Over ${formatNumber(max.emailsPerMonth)}`,
		emailsShort: `${formatCompact(max.emailsPerMonth)}+`,
		subscribers: `Over ${formatNumber(max.subscribers)}`,
		reply: `We reply personally within ${CUSTOM_REPLY_WITHIN}.`,
		bullets: [
			`Limits beyond ${max.name}: over ${formatNumber(max.subscribers)} subscribers or ${formatNumber(max.emailsPerMonth)} emails a month`,
			"A dedicated IP included",
			"Migration help from beehiiv, Substack and others",
			"A direct line to the people who build FlockStack",
		],
	};
}

// The FAQ's answer (lib/site-faq.js), also for the support assistant.
export function getCustomFaq() {
	const plan = getCustomPlan();
	return {
		question: "Do you offer SOC 2, SSO or a custom plan?",
		answer: [
			`A custom plan, yes, for lists with ${plan.subscribers.toLowerCase()} subscribers or ${plan.emails.toLowerCase()} emails a month: limits set for you, a dedicated IP included, help moving over from beehiiv, Substack or another platform, and a direct line to the people who build FlockStack. There is no price list: tell us what you send and we reply personally within ${CUSTOM_REPLY_WITHIN}.`,
			"SOC 2 and SSO, no. FlockStack doesn't have a SOC 2 report or single sign-on yet, and it doesn't have SCIM, audit logs, an uptime SLA or team seats either. We build them when customers need them, so the form asks which you would need and we build the right ones first.",
		],
		link: { href: CUSTOM_PATH, label: CUSTOM_BUTTON },
	};
}
