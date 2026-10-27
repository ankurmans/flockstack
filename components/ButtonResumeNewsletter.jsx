"use client";

import { useTransition } from "react";
import { resumeNewsletter } from "@/app/(app)/fleet/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

export default function ButtonResumeNewsletter({ id }) {
	const [pending, start] = useTransition();
	return <Button variant="outline" size="sm" disabled={pending} onClick={() => start(async () => {
		const result = await resumeNewsletter(id);
		if (result.error) toast.error(result.error);
		else toast.success("Sending brake cleared. Resume paused campaigns from their pages.");
	})}>{pending ? "Checking…" : "Check and resume"}</Button>;
}
