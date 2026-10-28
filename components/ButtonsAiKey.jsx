"use client";

import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { checkAiKey, deleteAiKey } from "@/app/(app)/ai-keys/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

// Checks an AI key with its provider, or deletes it. A key a briefing uses can't be deleted, which the action says.
export default function ButtonsAiKey({ id, isUsed }) {
	const [isPending, startTransition] = useTransition();

	function check() {
		startTransition(async () => {
			const result = await checkAiKey(id);
			if (result?.error) toast.error(result.error);
			else if (result.problem) toast.error(result.problem);
			else toast.success("The provider took the key");
		});
	}

	function remove() {
		if (!window.confirm("Delete this key? It is gone at once, and can't be shown again.")) return;
		startTransition(async () => {
			const result = await deleteAiKey(id);
			if (result?.error) toast.error(result.error);
			else toast.success("Key deleted");
		});
	}

	return (
		<span className="inline-flex gap-1">
			<Button variant="ghost" size="sm" onClick={check} disabled={isPending}>
				{isPending ? <Loader2 className="animate-spin" /> : "Check"}
			</Button>
			<Button variant="ghost" size="sm" onClick={remove} disabled={isPending} title={isUsed ? "A briefing uses this key" : undefined} className="text-muted-foreground hover:text-destructive">
				Delete
			</Button>
		</span>
	);
}
