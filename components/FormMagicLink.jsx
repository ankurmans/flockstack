"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { rotateMagicLink } from "@/app/(app)/forms/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

// Retiring the link: every copy of it stops working at once, and the page shows the new one.
export default function FormMagicLink({ newsletterId, keyId }) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();

	function rotate() {
		if (!window.confirm("Retire this link? Every copy of it stops working, wherever you shared it.")) return;
		startTransition(async () => {
			const result = await rotateMagicLink(newsletterId);
			if (result?.error) return void toast.error(result.error);
			toast.success("The old link no longer works");
			router.refresh();
		});
	}

	return (
		<section className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card p-4 shadow-border">
			<p className="text-sm text-muted-foreground">
				Key {keyId}. Retire the link if it was shared where it shouldn&apos;t be, or addresses that didn&apos;t ask are signing up.
			</p>
			<Button type="button" variant="outline" onClick={rotate} disabled={isPending}>
				{isPending && <Loader2 className="animate-spin" />}
				Retire this link
			</Button>
		</section>
	);
}
