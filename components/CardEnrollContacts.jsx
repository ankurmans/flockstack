"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { enrollContacts } from "@/app/(app)/automations/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

// Starts an active automation with a manual or API trigger for the contacts whose addresses are typed in.
export default function CardEnrollContacts({ id }) {
	const router = useRouter();
	const [emails, setEmails] = useState("");
	const [result, setResult] = useState(null);
	const [isPending, startTransition] = useTransition();

	function add() {
		startTransition(async () => {
			const answer = await enrollContacts(id, emails);
			if (answer?.error) return void toast.error(answer.error);
			setResult(answer);
			setEmails("");
			toast.success(answer.enrolled === 1 ? "1 contact added" : `${answer.enrolled} contacts added`);
			router.refresh();
		});
	}

	return (
		<aside className="h-fit rounded-xl bg-card shadow-border">
			<h2 className="flex h-12 items-center px-4 text-sm font-medium">Add contacts</h2>
			<div className="flex flex-col gap-3 border-t border-border/60 p-4">
				<textarea
					value={emails}
					onChange={(event) => setEmails(event.target.value)}
					placeholder="One address on each line, up to 100"
					aria-label="Email addresses"
					rows={4}
					className="block w-full resize-none rounded-lg bg-transparent px-3 py-2 text-sm shadow-border outline-none placeholder:text-muted-foreground"
				/>
				<Button onClick={add} disabled={isPending || !emails.trim()} className="self-end">
					{isPending ? <Loader2 className="animate-spin" /> : "Add"}
				</Button>
				{result && (
					<ul className="flex flex-col gap-1 text-xs text-pretty text-muted-foreground">
						{result.alreadyIn > 0 && <li>{result.alreadyIn} already in it.</li>}
						{result.notFound.length > 0 && <li>Not contacts of this newsletter: {result.notFound.join(", ")}.</li>}
						{result.notActive.length > 0 && <li>Not active, so they can&apos;t get email: {result.notActive.join(", ")}.</li>}
					</ul>
				)}
			</div>
		</aside>
	);
}
