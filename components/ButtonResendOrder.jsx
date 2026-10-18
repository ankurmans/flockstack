"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { resendOrder } from "@/app/(app)/orders/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { useToastError } from "@/lib/use-toast-error";

// Emails the buyer a new download link; the old one stops working.
export default function ButtonResendOrder({ id, email }) {
	const [isPending, startTransition] = useTransition();
	const toastError = useToastError();

	function onClick() {
		if (!window.confirm(`Email ${email} a new download link? The earlier link stops working.`)) return;
		startTransition(async () => {
			const result = await resendOrder(id);
			if (result?.error) toastError(result);
			else toast.success("New link sent");
		});
	}

	return (
		<Button variant="ghost" size="sm" onClick={onClick} disabled={isPending} className="text-muted-foreground">
			{isPending ? <Loader2 className="animate-spin" /> : "Resend link"}
		</Button>
	);
}
