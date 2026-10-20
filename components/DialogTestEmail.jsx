"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const MAX_ADDRESSES = 10;

function readAddresses(text) {
	return [...new Set(text.split(/[\s,;]+/).map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

// Who a test email goes to: the owner's address to start with, up to 10 in all, one email each.
export default function DialogTestEmail({ isOpen, onOpenChange, defaultEmail, isPending, onSend }) {
	const [text, setText] = useState(defaultEmail ?? "");
	const addresses = readAddresses(text);
	const isTooMany = addresses.length > MAX_ADDRESSES;

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Send a test email</DialogTitle>
					<DialogDescription>Up to {MAX_ADDRESSES} addresses, one per line. Each one counts toward your plan&apos;s emails.</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-2">
					<Label htmlFor="test-addresses">Send to</Label>
					<Textarea id="test-addresses" value={text} onChange={(event) => setText(event.target.value)} rows={4} spellCheck={false} />
					{isTooMany && <span className="text-xs text-destructive">{MAX_ADDRESSES} addresses at most</span>}
				</div>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="outline">Cancel</Button>
					</DialogClose>
					<Button onClick={() => onSend(addresses)} disabled={isPending || addresses.length === 0 || isTooMany} className="min-w-20">
						{isPending ? <Loader2 className="animate-spin" /> : "Send"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
