"use client";

import { useTransition } from "react";
import { Download, Loader2 } from "lucide-react";
import { exportReport } from "@/app/(app)/reports/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

// A report's table as a CSV download: the same filters the page was opened with.
export default function ButtonExportReport({ input, children = "Export CSV" }) {
	const [isPending, startTransition] = useTransition();

	function download() {
		startTransition(async () => {
			const result = await exportReport(input);
			if (result?.error) return void toast.error(result.error);
			const link = document.createElement("a");
			link.href = URL.createObjectURL(new Blob([result.csv], { type: "text/csv" }));
			link.download = result.filename;
			link.click();
			URL.revokeObjectURL(link.href);
		});
	}

	return (
		<Button type="button" variant="outline" size="sm" onClick={download} disabled={isPending}>
			{isPending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Download data-icon="inline-start" />}
			{children}
		</Button>
	);
}
