"use client";

import { useMemo, useState } from "react";
import SliderPricing from "@/components/SliderPricing";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PaywallContext } from "@/lib/use-paywall";

// What an account without a plan can't do opens this instead, with the plans as the pricing page shows them. Every account
// on FlockStack Cloud has a plan, Free at least, so hasPlan is true there and it stays shut. pricing: lib/pricing.js.
export default function ProviderPaywall({ hasPlan, pricing, children }) {
	const [state, setState] = useState({ isOpen: false, reason: "default" });
	const value = useMemo(() => ({ hasPlan, open: (reason = "default") => setState({ isOpen: true, reason }) }), [hasPlan]);

	return (
		<PaywallContext value={value}>
			{children}
			{!hasPlan && (
				<Dialog open={state.isOpen} onOpenChange={(isOpen) => setState((current) => ({ ...current, isOpen }))}>
					<DialogContent className="max-h-[calc(100dvh-2rem)] gap-6 overflow-y-auto p-5 sm:max-w-4xl sm:p-8">
						<DialogHeader className="gap-1.5 pr-8">
							<DialogTitle className="text-xl font-semibold tracking-tight text-balance sm:text-2xl">
								{TITLES[state.reason] ?? TITLES.default}
							</DialogTitle>
							<DialogDescription className="text-[15px] text-pretty">
								Your newsletter and drafts are saved.
							</DialogDescription>
						</DialogHeader>
						<SliderPricing {...pricing} />
					</DialogContent>
				</Dialog>
			)}
		</PaywallContext>
	);
}

const TITLES = {
	default: "Upgrade to keep going",
	send: "Upgrade to send your campaign",
	schedule: "Upgrade to schedule your campaign",
	test: "Upgrade to send test emails",
	import: "Upgrade to add subscribers",
	contact: "Upgrade to add more contacts",
	domain: "Upgrade to send from your own domain",
	apiKey: "Upgrade to use the API",
	webhook: "Upgrade to use webhooks",
	upload: "Upgrade to upload more images",
	website: "Upgrade to put your website online",
	sell: "Upgrade to sell to your readers",
};
