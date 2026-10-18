"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setIssueComments } from "@/app/(app)/comments/actions";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/toast";

// One sent issue's own word on comments: on, off, or the newsletter's setting. Closing a thread is "off".
export default function SelectIssueComments({ newsletterId, campaignId, subject, value, followsOn }) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();

	function choose(mode) {
		startTransition(async () => {
			const result = await setIssueComments({ newsletterId, campaignId, mode });
			if (result?.error) return void toast.error(result.error);
			router.refresh();
		});
	}

	return (
		<Select value={value ?? "default"} onValueChange={choose} disabled={isPending}>
			<SelectTrigger className="h-9 w-full sm:w-52" aria-label={`Comments on ${subject}`}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="default">Follow the newsletter ({followsOn ? "on" : "off"})</SelectItem>
				<SelectItem value="on">On</SelectItem>
				<SelectItem value="off">Off</SelectItem>
			</SelectContent>
		</Select>
	);
}
