"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { deleteSegment } from "@/app/(app)/segments/actions";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/lib/toast";

export default function MenuSegment({ id, name }) {
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [isDeleting, startDeleting] = useTransition();

	function remove() {
		startDeleting(async () => {
			const result = await deleteSegment(id);
			if (result?.error) return void toast.error(result.error);
			setIsDeleteOpen(false);
			toast.success("Segment deleted");
		});
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`Actions for ${name}`}
						className="text-muted-foreground hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
					>
						<MoreHorizontal />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-40">
					<DropdownMenuItem asChild>
						<Link href={`/segments/${id}`}>
							<Pencil />
							Edit
						</Link>
					</DropdownMenuItem>
					<DropdownMenuItem variant="destructive" onSelect={() => setIsDeleteOpen(true)}>
						<Trash2 />
						Delete
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>Delete this segment?</DialogTitle>
						<DialogDescription>
							<span className="font-medium wrap-anywhere text-foreground">{name}</span> goes away. Its contacts stay. Campaigns already
							sent keep the audience they went to.
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
		</>
	);
}
