// Automations to start from: each is the input create_automation takes, written to be read and changed before it is
// switched on. They are drafts, so nothing is sent until the owner activates them.

export const AUTOMATION_TEMPLATES = [
	{
		id: "welcome-series",
		name: "Welcome series",
		description: "Three emails over a week for every new subscriber: a welcome, where to start, and a question that invites a reply.",
		automationName: "Welcome series",
		trigger: { type: "subscribed" },
		steps: [
			{
				type: "email",
				subject: "Welcome, {{first_name|friend}}",
				previewText: "What to expect, and how to reach me",
				content:
					"Thanks for joining, {{first_name|friend}}.\n\nHere is what you will get: one issue on a steady schedule, written to be read in a few minutes. If you ever want less of something, hit reply and say so.\n\nNext issue is on its way.",
			},
			{ type: "wait", amount: 2, unit: "days" },
			{
				type: "email",
				subject: "Where to start",
				previewText: "Three issues worth your time",
				content: "If you are new here, these are the issues readers come back to most. Add your three best links here, with one line on why each is worth it.",
			},
			{ type: "wait", amount: 5, unit: "days" },
			{
				type: "email",
				subject: "A question for you",
				previewText: "Reply with one line",
				content: "What are you hoping to get from this newsletter? Hit reply and tell me in a line. I read every answer, and it shapes what I write next.",
			},
			{ type: "add_tag", tag: "welcomed" },
		],
	},
	{
		id: "re-engagement",
		name: "Re-engagement",
		description: "For contacts with no opens or clicks for 60 days: one email to check they still want to hear from you, then a tag for those who did not answer so you can leave them out of sends.",
		automationName: "Re-engagement",
		trigger: { type: "unengaged", days: 60 },
		steps: [
			{
				type: "email",
				subject: "Still want these emails?",
				previewText: "A quick check before I stop sending",
				content: "It has been a while since you opened one of these. If you still want them, click any link in this email or hit reply. If not, the unsubscribe link below is fine by me.",
			},
			{ type: "wait", amount: 7, unit: "days" },
			{
				type: "branch",
				condition: { match: "all", conditions: [{ type: "engagement", kind: "opened_or_clicked", days: 7 }] },
				paths: [
					{ name: "Came back", steps: [{ type: "add_tag", tag: "re-engaged" }] },
					{ name: "Still quiet", steps: [{ type: "add_tag", tag: "unengaged" }, { type: "end" }] },
				],
			},
		],
	},
	{
		id: "paid-onboarding",
		name: "Paid onboarding",
		description: "When a reader upgrades to a paid subscription: a thank-you, then a tour of what they now get.",
		automationName: "Paid onboarding",
		trigger: { type: "upgraded" },
		steps: [
			{
				type: "email",
				subject: "Thank you for supporting {{first_name|this newsletter}}",
				previewText: "Here is what you now get",
				content: "Thank you for becoming a paid subscriber. You now get every issue in full, including the ones that stop at the paywall for free readers.\n\nIf anything about your subscription is not working, reply to this email and I will sort it out.",
			},
			{ type: "wait", amount: 3, unit: "days" },
			{
				type: "email",
				subject: "Getting the most from your subscription",
				previewText: "Three things worth knowing",
				content: "A few things paid readers tend to miss: the full archive on the website, replying to any issue to reach me directly, and the preferences link at the bottom of every email. List what is specific to your newsletter here.",
			},
			{ type: "add_tag", tag: "paid-onboarded" },
		],
	},
	{
		id: "product-buyer-thank-you",
		name: "Product buyer thank-you",
		description: "After a reader buys one of your products: a thank-you, and a note a week later asking how it is going. Pick a product in the trigger to limit it to one.",
		automationName: "Product buyer thank-you",
		trigger: { type: "product_bought" },
		steps: [
			{
				type: "email",
				subject: "Thank you for your order",
				previewText: "Your download link is in a separate email",
				content: "Thank you for buying. Your download link comes in its own email and works for 30 days. If it does not turn up, check your spam folder or reply here.",
			},
			{ type: "wait", amount: 7, unit: "days" },
			{
				type: "email",
				subject: "How is it going?",
				previewText: "One question, and a way to reach me",
				content: "It has been a week. Have you had a chance to use it? Reply and tell me what worked and what did not. I use it to improve what I make next.",
			},
			{ type: "add_tag", tag: "customer" },
		],
	},
	{
		id: "paid-upsell",
		name: "Paid upgrade offer",
		description: "Two weeks after someone joins, if they are still on the free plan: an email about what paid readers get, and one reminder a week later for those who have not upgraded. Add your subscribe link where the text says so.",
		automationName: "Paid upgrade offer",
		trigger: { type: "subscribed" },
		steps: [
			{ type: "wait", amount: 14, unit: "days" },
			{
				type: "branch",
				condition: { match: "all", conditions: [{ type: "tier", value: "free" }] },
				paths: [
					{
						name: "Still free",
						steps: [
							{
								type: "email",
								subject: "What paid readers get",
								previewText: "If you like these issues, there is more",
								content: "You have been reading for two weeks, so you know what this newsletter is like. Paid readers get every issue in full, including the ones that stop at the paywall for free readers. List what is specific to your newsletter here, and add your subscribe link: it is on your website's Subscribe page.\n\nNo pressure. The free issues keep coming either way.",
							},
							{ type: "wait", amount: 7, unit: "days" },
							{
								type: "branch",
								condition: { match: "all", conditions: [{ type: "tier", value: "free" }] },
								paths: [
									{
										name: "Not yet paid",
										steps: [
											{
												type: "email",
												subject: "One last note about paid issues",
												previewText: "Then I will leave it alone",
												content: "This is the last time I will bring it up. If supporting this newsletter is something you would like to do, add your subscribe link here. If not, thank you for reading, and the free issues carry on.",
											},
											{ type: "add_tag", tag: "upsold" },
										],
									},
									{ name: "Upgraded", steps: [{ type: "end" }] },
								],
							},
						],
					},
					{ name: "Already paid", steps: [{ type: "end" }] },
				],
			},
		],
	},
	{
		id: "referral-thanks",
		name: "Referral thanks",
		description: "Each time a subscriber's referral is credited: a thank-you with their count and link. Set referrals in the trigger to thank them at a milestone instead.",
		automationName: "Referral thanks",
		trigger: { type: "referral_credited" },
		steps: [
			{
				type: "email",
				subject: "Thank you for sharing",
				previewText: "Someone you sent just joined",
				content: "Someone you sent just joined, and I am grateful. You have referred {{referral_count}} so far.\n\nYour link, in case you want to share it again: {{referral_link}}",
			},
			{ type: "add_tag", tag: "referrer" },
		],
	},
];

export function findAutomationTemplate(id) {
	return AUTOMATION_TEMPLATES.find((template) => template.id === id) ?? null;
}
