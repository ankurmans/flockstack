"use client";

import { useActionState, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { createProduct } from "@/app/(app)/products/actions";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import SelectCurrency from "@/components/SelectCurrency";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { useToastError } from "@/lib/use-toast-error";

export default function DialogCreateProduct({ newsletterId }) {
	const [isOpen, setIsOpen] = useState(false);
	const [formKey, setFormKey] = useState(0);

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				setIsOpen(open);
				if (!open) setFormKey((key) => key + 1);
			}}
		>
			<DialogTrigger asChild>
				<Button>
					<Plus data-icon="inline-start" />
					New product
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<FormCreateProduct key={formKey} newsletterId={newsletterId} />
			</DialogContent>
		</Dialog>
	);
}

function FormCreateProduct({ newsletterId }) {
	const toastError = useToastError();
	const [state, action, isPending] = useActionState(async (previous, formData) => {
		const result = await createProduct(previous, formData);
		if (result?.error) toastError(result);
		return result;
	}, null);

	return (
		<form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col gap-4">
			<input type="hidden" name="newsletter" value={newsletterId} />
			<DialogHeader>
				<DialogTitle>New product</DialogTitle>
				<DialogDescription>A file your readers buy once and download. You add the file on the next page.</DialogDescription>
			</DialogHeader>
			<Input name="title" placeholder="Title, e.g. Launch checklist" required autoFocus maxLength={120} />
			<div className="flex gap-2">
				<Input name="price" inputMode="decimal" placeholder="Price, e.g. 19" required className="flex-1" />
				<SelectCurrency name="currency" defaultValue="usd" />
			</div>
			<Textarea name="description" placeholder="What the buyer gets (optional)" maxLength={2000} rows={3} />
			{state?.error && <p className="text-sm text-destructive">{state.error}</p>}
			<DialogFooter>
				<Button type="submit" disabled={isPending} className="min-w-20">
					{isPending ? <Loader2 className="animate-spin" /> : "Create"}
				</Button>
			</DialogFooter>
		</form>
	);
}
