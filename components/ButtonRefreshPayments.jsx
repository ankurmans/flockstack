"use client";

import { useTransition } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { refreshPayments } from "@/app/(app)/payments/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

// Asks Stripe for the account's status again, e.g. after finishing its onboarding in another tab.
export default function ButtonRefreshPayments() {
	const [isPending, startTransition] = useTransition();

	function onClick() {
		startTransition(async () => {
			const result = await refreshPayments();
			if (result?.error) toast.error(result.error);
		});
	}

	return (
		<Button variant="ghost" size="sm" onClick={onClick} disabled={isPending} className="text-muted-foreground">
			{isPending ? <Loader2 className="animate-spin" /> : <RefreshCw data-icon="inline-start" />}
			Check status
		</Button>
	);
}
