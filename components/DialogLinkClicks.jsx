"use client";

import { useState, useTransition } from "react";
import { Loader2, Users } from "lucide-react";
import { listLinkClicks } from "@/app/(app)/campaigns/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { formatCount } from "@/lib/format";
import { useToastError } from "@/lib/use-toast-error";

// Who clicked one link, a page at a time, read when the dialog opens.
export default function DialogLinkClicks({ campaignId, link }) {
	const toastError = useToastError();
	const [isOpen, setIsOpen] = useState(false);
	const [contacts, setContacts] = useState(null);
	const [cursor, setCursor] = useState(null);
	const [isLoading, startLoading] = useTransition();

	function load(after) {
		startLoading(async () => {
			const result = await listLinkClicks(campaignId, link.index, after);
			if (result?.error) return toastError(result);
			setContacts((current) => [...(after ? (current ?? []) : []), ...result.contacts]);
			setCursor(result.nextCursor);
		});
	}

	function changeOpen(nextIsOpen) {
		setIsOpen(nextIsOpen);
		if (nextIsOpen && contacts === null) load(null);
	}

	return (
		<Dialog open={isOpen} onOpenChange={changeOpen}>
			<DialogTrigger asChild>
				<Button variant="ghost" size="sm" disabled={!link.uniqueClicks} aria-label={`Who clicked ${link.url}`}>
					<Users data-icon="inline-start" />
					Who
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="tabular-nums">{formatCount(link.uniqueClicks, "reader")} clicked</DialogTitle>
					<DialogDescription className="truncate">{link.url}</DialogDescription>
				</DialogHeader>
				<ul className="flex max-h-80 flex-col overflow-y-auto text-sm">
					{(contacts ?? []).map((contact) => (
						<li key={contact.id} className="flex items-center justify-between gap-3 border-b border-border/60 py-2 last:border-0">
							<span className="truncate">{contact.email}</span>
							{contact.status !== "active" && <span className="shrink-0 text-xs text-muted-foreground">{contact.status}</span>}
						</li>
					))}
					{contacts?.length === 0 && !isLoading && <li className="py-2 text-muted-foreground">They have all been deleted since.</li>}
				</ul>
				{(isLoading || cursor) && (
					<Button variant="outline" onClick={() => load(cursor)} disabled={isLoading}>
						{isLoading ? <Loader2 className="animate-spin" /> : "Show more"}
					</Button>
				)}
			</DialogContent>
		</Dialog>
	);
}
