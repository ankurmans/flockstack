"use client";

import { useState, useTransition } from "react";
import { Loader2, MoreHorizontal, Tags, Trash2, UserCheck, UserX } from "lucide-react";
import { approveHeldSignups, deleteContact, setContactStatus } from "@/app/(app)/contacts/actions";
import DialogContactDetails from "@/components/DialogContactDetails";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/lib/toast";

const SUBSCRIBED_STATUSES = ["active", "dormant"];
// Deleted, they leave their status behind (lib/contacts.js).
const AFTER_DELETE = {
	held: "Nothing is sent to them, and they can ask to join again.",
	unsubscribed: "They unsubscribed, so adding them again won't email them.",
	bounced: "Their address bounced, so adding it again won't email it.",
	complained: "They marked an email as spam, so adding them again won't email them.",
};

export default function MenuContact({ id, newsletterId, email, status, tags = [], fields = {}, definitions = [], tagColors = {}, listIds = [], mailingLists = [] }) {
	const [isDetailsOpen, setIsDetailsOpen] = useState(false);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [isPending, startTransition] = useTransition();
	const isSubscribed = SUBSCRIBED_STATUSES.includes(status);

	function update(nextStatus) {
		startTransition(async () => {
			const result = await setContactStatus(id, nextStatus);
			if (result?.error) toast.error(result.error);
		});
	}

	function approve() {
		startTransition(async () => {
			const result = await approveHeldSignups({ newsletterId, contactIds: [id] });
			if (result?.error) toast.error(result.error);
			else toast.success(`${email} approved`);
		});
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`Actions for ${email}`}
						disabled={isPending}
						className="text-muted-foreground hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
					>
						{isPending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-44">
					<DropdownMenuItem onSelect={() => setIsDetailsOpen(true)}>
						<Tags />
						Tags and fields
					</DropdownMenuItem>
					{status === "held" && (
						<DropdownMenuItem onSelect={approve}>
							<UserCheck />
							Approve
						</DropdownMenuItem>
					)}
					{status === "dormant" && (
						<DropdownMenuItem onSelect={() => update("active")}>
							<UserCheck />
							Reactivate
						</DropdownMenuItem>
					)}
					{isSubscribed && (
						<>
							<DropdownMenuItem variant="destructive" onSelect={() => update("unsubscribed")}>
								<UserX />
								Unsubscribe
							</DropdownMenuItem>
							<DropdownMenuSeparator />
						</>
					)}
					<DropdownMenuItem variant="destructive" onSelect={() => setIsDeleteOpen(true)}>
						<Trash2 />
						{status === "held" ? "Turn down" : "Delete contact"}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{isDetailsOpen && (
				<DialogContactDetails contact={{ id, email, tags, fields, listIds }} mailingLists={mailingLists} definitions={definitions} tagColors={tagColors} isOpen onOpenChange={setIsDetailsOpen} />
			)}
			<DialogDeleteContact id={id} email={email} status={status} isOpen={isDeleteOpen} onOpenChange={setIsDeleteOpen} />
		</>
	);
}

function DialogDeleteContact({ id, email, status, isOpen, onOpenChange }) {
	const [isDeleting, startDeleting] = useTransition();

	function remove() {
		startDeleting(async () => {
			const result = await deleteContact(id);
			if (result?.error) return void toast.error(result.error);
			onOpenChange(false);
			toast.success("Contact deleted");
		});
	}

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Delete this contact?</DialogTitle>
					<DialogDescription>
						<span className="font-medium wrap-anywhere text-foreground">{email}</span> leaves your contacts.{" "}
						{AFTER_DELETE[status] ?? "They can be added again later."}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="outline">Cancel</Button>
					</DialogClose>
					<Button variant="destructive" onClick={remove} disabled={isDeleting} className="min-w-20">
						{isDeleting ? <Loader2 className="animate-spin" /> : "Delete"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
