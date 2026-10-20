import { getCustomFaq } from "@/lib/custom-tier";
import { formatNumber, formatUsdCents } from "@/lib/format";
import { PRICE_INCREASE_NOTICE_DAYS } from "@/lib/legal";
import { EXTRA_EMAILS, FREE_GUARDS, FREE_PLAN } from "@/lib/plans";

// Product facts the support assistant answers from (lib/marketing/support-corpus.js): the questions people ask about
// FlockStack Cloud and the price promise. Both read their numbers from lib/plans.js, lib/custom-tier.js and the terms, so
// they can't say more than those do. The marketing website keeps its own copy of the FAQ for its home page, which is a
// separate program: change both when an answer changes.

// What the terms of service already promise (their Plans and billing, Selling and Changes sections), in short: never
// more than they say. The website's pricing page and the support assistant print it.
export const PRICE_PROMISE = [
	{
		title: `${PRICE_INCREASE_NOTICE_DAYS} days' notice`,
		text: `If a price goes up, we email existing customers at least ${PRICE_INCREASE_NOTICE_DAYS} days before it takes effect. Until then, you keep paying the price you have.`,
	},
	{
		title: "Published prices",
		text: `Every plan, add-on and price is on the pricing page. Past your plan's emails, extra emails are ${formatUsdCents(EXTRA_EMAILS.pricePerThousand)} per 1,000, up to a monthly limit you set. Nothing else is billed on top of your plan.`,
	},
	{ title: "No cut of your sales", text: "Readers pay your own Stripe account, and FlockStack takes 0% of what you sell. Stripe's own fees apply." },
];

export const FAQ = [
	{
		question: "Is FlockStack open source?",
		answer: [
			"Yes. FlockStack is licensed under the AGPL-3.0: you can read the code, change it and run it on your own server.",
			"FlockStack Cloud, at flockstack.io, runs the same code for people who would rather not host it.",
		],
	},
	{
		question: "Where does my data live?",
		answer: [
			"On Cloudflare, in the region you pick when you sign up: the United States or the European Union. Your newsletters, subscribers and campaigns are stored in D1, and your images in R2, in that region. An account lives in one region. The docs list where each kind of data is stored.",
		],
	},
	{
		question: "Can I import from beehiiv or Substack?",
		answer: [
			"Yes. Export your subscribers as a CSV from beehiiv, Substack, Mailchimp, Kit or another platform, and import the file. The exports work as they are.",
		],
	},
	{
		question: "Is there a free plan?",
		answer: [
			`Yes. Free is $0 with no card: ${formatNumber(FREE_PLAN.subscribers)} subscribers, ${formatNumber(FREE_PLAN.emailsPerMonth)} emails a month, one newsletter, your own sending and archive domain, polls, surveys, forms, the API and MCP, and ${FREE_PLAN.automations} automations besides the welcome email. In return, your emails and website carry a small “Sent with FlockStack” link, which any paid plan removes.`,
			`Free can't go past its limits: at the email limit, a send that wouldn't fit is refused up front, with the numbers, and nothing is billed. Your first ${FREE_GUARDS.firstCampaigns.count} campaigns go to ${formatNumber(FREE_GUARDS.firstCampaigns.recipients)} people at most while we get to know your sending.`,
			"FlockStack takes 0% of what you sell.",
		],
	},
	{
		question: "What happens when I hit my email limit?",
		answer: [
			`On Free, nothing is billed: a campaign that wouldn't fit in the month's emails is refused up front, with the numbers, until the month resets or you upgrade. On a paid plan, sending goes on: extra emails cost ${formatUsdCents(EXTRA_EMAILS.pricePerThousand)} per 1,000, billed with your plan at the end of the period. You set a monthly limit on them on the billing page, the plan's own emails by default, and we email you at 80% and 100% of it.`,
			"At that limit, campaigns and welcome emails pause until you raise it, upgrade or the next month starts. Signups keep working, and confirmation emails still go out. A paid plan that ends puts the account on Free: nothing is deleted, but campaigns wait until it is under Free's limits or you upgrade.",
			"Each plan also sets how many subscribers you can hold, shown next to its emails on the pricing page.",
		],
	},
	getCustomFaq(),
	{
		question: "Can AI agents use it?",
		answer: [
			"Yes. Everything the dashboard does is also in the REST API and in an MCP server, so ChatGPT, Claude, Cursor or Codex can write, schedule and send for you, under the same checks and limits as a person.",
		],
		link: { href: "/docs/mcp", label: "Connect an agent" },
	},
	{
		question: "Is there a mobile app?",
		answer: [
			"No, FlockStack has no app of its own. The dashboard works in a phone's browser, and the ChatGPT and Claude mobile apps can use FlockStack through its MCP server.",
		],
		link: { href: "/docs/mcp", label: "Connect an agent" },
	},
];
