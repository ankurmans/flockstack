"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { saveCampaignAsTemplate } from "@/app/(app)/campaigns/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";

// Opened from a menu, so the caller owns the open state. The issue is saved as it is now: the caller saves its draft first.
export default function DialogSaveTemplate({ id, subject, isOpen, onOpenChange, onBeforeSave }) {
	const router = useRouter();
	const [name, setName] = useState("");
	const [isPending, startTransition] = useTransition();

	function save(event) {
		event.preventDefault();
		startTransition(async () => {
			if (onBeforeSave && !(await onBeforeSave())) return;
			const result = await saveCampaignAsTemplate(id, name || subject);
			if (result?.error) return void toast.error(result.error);
			onOpenChange(false);
			setName("");
			toast.success("Saved as a template", { action: { label: "See templates", onClick: () => router.push("/templates") } });
		});
	}

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<form onSubmit={save} className="flex flex-col gap-4">
					<DialogHeader>
						<DialogTitle>Save as a template</DialogTitle>
						<DialogDescription>New issues can start from it with this subject, preview text and content.</DialogDescription>
					</DialogHeader>
					<label className="flex flex-col gap-1.5 text-sm">
						Name
						<Input value={name} onChange={(event) => setName(event.target.value)} placeholder={subject || "Weekly letter"} maxLength={100} autoFocus />
					</label>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline">
								Cancel
							</Button>
						</DialogClose>
						<Button type="submit" disabled={isPending || !(name || subject)} className="min-w-20">
							{isPending ? <Loader2 className="animate-spin" /> : "Save"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
