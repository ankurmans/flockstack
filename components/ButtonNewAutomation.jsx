"use client";

import { useTransition } from "react";
import Link from "next/link";
import { Loader2, Plus } from "lucide-react";
import { createAutomation } from "@/app/(app)/automations/actions";
import { Button } from "@/components/ui/button";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { toast } from "@/lib/toast";

// A new draft in the open newsletter.
export default function ButtonNewAutomation({ newsletterId }) {
	const [isPending, startTransition] = useTransition();

	if (!newsletterId) {
		return (
			<Button asChild>
				<Link href={ADD_NEWSLETTER_PATH}>
					<Plus data-icon="inline-start" />
					New
				</Link>
			</Button>
		);
	}

	function create() {
		startTransition(async () => {
			const result = await createAutomation(newsletterId);
			if (result?.error) toast.error(result.error);
		});
	}

	return (
		<Button disabled={isPending} onClick={create}>
			{isPending ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Plus data-icon="inline-start" />}
			New
		</Button>
	);
}
