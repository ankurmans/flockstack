"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { resendWebhookDelivery } from "@/app/(app)/webhooks/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { useToastError } from "@/lib/use-toast-error";

// Sends a delivery's event again, with the same webhook-id, so a receiver that has it already can skip it.
export default function ButtonResendDelivery({ endpointId, deliveryId }) {
	const [isPending, startTransition] = useTransition();
	const toastError = useToastError();

	function onClick() {
		startTransition(async () => {
			const result = await resendWebhookDelivery(endpointId, deliveryId);
			if (result?.error) toastError(result);
			else toast.success("Sent again");
		});
	}

	return (
		<Button variant="ghost" size="sm" onClick={onClick} disabled={isPending} className="text-muted-foreground">
			{isPending ? <Loader2 className="animate-spin" /> : "Resend"}
		</Button>
	);
}
