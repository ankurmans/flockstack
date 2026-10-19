"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ExternalLink, FileUp, Loader2 } from "lucide-react";
import { archiveProduct, publishProduct, saveProduct, unpublishProduct } from "@/app/(app)/products/actions";
import BadgeStatus from "@/components/BadgeStatus";
import ButtonCopy from "@/components/ButtonCopy";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import SelectCurrency from "@/components/SelectCurrency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes, formatCount } from "@/lib/format";
import { formatPrice } from "@/lib/payments/config";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { toast } from "@/lib/toast";
import { useToastError } from "@/lib/use-toast-error";

// The product's page of the dashboard: its details, its file, and putting it on sale. payments: whether a sale can be
// charged now (get_payments_status); a product can't go on sale until it can. maxFileMb: the upload limit.
export default function FormProduct({ product, payments, maxFileMb }) {
	const router = useRouter();
	const toastError = useToastError();
	const [isWorking, startWorking] = useTransition();
	const [state, action, isSaving] = useActionState(async (previous, formData) => {
		const result = await saveProduct(previous, formData);
		if (result?.error) {
			toastError(result);
			return result;
		}
		toast.success("Saved");
		return { ...result, savedAt: Date.now() };
	}, null);
	const isActive = product.status === "active";
	const isArchived = product.status === "archived";

	function run(change, message) {
		startWorking(async () => {
			const result = await change(product.id);
			if (result?.error) return toastError(result);
			toast.success(message);
			router.refresh();
		});
	}

	return (
		<div className="flex flex-col gap-6">
			<CardSettings
				title="Status"
				action={<BadgeStatus status={isActive ? "active" : product.status} label={isActive ? "On sale" : undefined} />}
			>
				<div className="flex flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
					<p className="text-pretty text-muted-foreground">
						{isActive
							? "Readers can buy it on your site. FlockStack takes no cut: they pay your Stripe account, and only Stripe's own fee comes off."
							: isArchived
								? "Off sale and off your shop. People who bought it keep their download links."
								: !product.file
									? "Add the file buyers get, then put it on sale."
									: payments.ready
										? "Not on sale yet."
										: payments.problem}
					</p>
					<div className="flex shrink-0 flex-wrap gap-2">
						{isActive ? (
							<Button variant="outline" disabled={isWorking} onClick={() => run(unpublishProduct, "Taken off sale")}>
								Take off sale
							</Button>
						) : isArchived ? (
							<Button variant="outline" disabled={isWorking} onClick={() => run(unpublishProduct, "Restored as a draft")}>
								Restore
							</Button>
						) : (
							<Button disabled={isWorking || !product.file || !payments.ready} onClick={() => run(publishProduct, "On sale")}>
								Put on sale
							</Button>
						)}
						{!isArchived && (
							<Button
								variant="ghost"
								disabled={isWorking}
								className="text-muted-foreground hover:text-destructive"
								onClick={() => window.confirm("Archive this product? It leaves your shop. Earlier buyers keep their downloads.") && run(archiveProduct, "Archived")}
							>
								<Archive data-icon="inline-start" />
								Archive
							</Button>
						)}
					</div>
				</div>
				{product.url && (
					<div className="flex items-center gap-2 px-4 py-3">
						<a
							href={product.url}
							target="_blank"
							rel="noreferrer"
							className="flex min-w-0 items-center gap-1.5 truncate font-mono text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
						>
							<ExternalLink className="size-3.5 shrink-0" />
							<span className="truncate">{product.url}</span>
						</a>
						<ButtonCopy value={product.url} label="Copy link" />
					</div>
				)}
				<div className="grid grid-cols-2 gap-px bg-border/60">
					<Stat label="Sold" value={formatCount(product.sales, "order")} />
					<Stat label="Earned" value={formatPrice(product.revenueCents, product.currency)} />
				</div>
			</CardSettings>

			<CardSettings title="File" stagger={1}>
				<FileUpload product={product} maxFileMb={maxFileMb} onUploaded={() => router.refresh()} />
			</CardSettings>

			{/* A new key after each save: the fields start again from what was saved, the slug as the server made it. */}
			<form key={state?.savedAt ?? 0} action={action} onSubmit={submitKeepingFields(action)}>
				<CardSettings
					title="Details"
					stagger={2}
					action={
						<Button type="submit" size="sm" disabled={isSaving} className="min-w-16">
							{isSaving ? <Loader2 className="animate-spin" /> : "Save"}
						</Button>
					}
				>
					<input type="hidden" name="id" value={product.id} />
					<RowSettings label="Title" isLabel>
						<Input name="title" defaultValue={product.title} required maxLength={120} />
					</RowSettings>
					<RowSettings label="Description" isLabel hint="Shown on the product's page and in Stripe's checkout.">
						<Textarea name="description" defaultValue={product.description} maxLength={2000} rows={4} />
					</RowSettings>
					<RowSettings label="Price" isLabel hint="A change applies to the next sale. Earlier orders keep what they paid.">
						<span className="flex gap-2">
							<Input name="price" inputMode="decimal" defaultValue={(product.priceCents / 100).toFixed(2)} required className="flex-1" />
							<SelectCurrency name="currency" defaultValue={product.currency} />
						</span>
					</RowSettings>
					<RowSettings label="Page address" isLabel hint="The product's page is /shop/ followed by this.">
						<Input name="slug" defaultValue={product.slug} required maxLength={80} className="font-mono" />
					</RowSettings>
					<RowSettings label="Cover image" isLabel hint="An https:// link, e.g. from an image you uploaded to a campaign. Optional.">
						<Input name="imageUrl" defaultValue={product.imageUrl ?? ""} placeholder="https://" maxLength={500} />
					</RowSettings>
				</CardSettings>
				{state?.error && <p className="mt-2 text-sm text-destructive">{state.error}</p>}
			</form>

			<p className="text-xs text-muted-foreground">
				Orders and refunds: <Link href="/orders" className="underline underline-offset-4">see orders</Link>. Refund a buyer in your Stripe dashboard and their download link stops.
			</p>
		</div>
	);
}

function Stat({ label, value }) {
	return (
		<div className="bg-card px-4 py-3">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className="mt-0.5 text-lg font-semibold tracking-tight tabular-nums">{value}</p>
		</div>
	);
}

// The file goes up as the request's body (app/api/product-files/route.js), the way the image picker's do.
function FileUpload({ product, maxFileMb, onUploaded }) {
	const inputRef = useRef(null);
	const [isUploading, setIsUploading] = useState(false);

	async function upload(file) {
		if (!file) return;
		if (file.size > maxFileMb * 1024 * 1024) return void toast.error(`Files must be under ${maxFileMb} MB`);
		setIsUploading(true);
		try {
			const response = await fetch("/api/product-files", {
				method: "POST",
				headers: { "x-product-id": product.id, "x-file-name": encodeURIComponent(file.name), "content-type": file.type || "application/octet-stream" },
				body: file,
			});
			const result = await response.json().catch(() => ({}));
			if (!response.ok) return void toast.error(result.error ?? "The upload failed, try again");
			toast.success("File uploaded");
			onUploaded();
		} catch {
			toast.error("The upload failed, try again");
		} finally {
			setIsUploading(false);
			if (inputRef.current) inputRef.current.value = "";
		}
	}

	return (
		<div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
			<div className="min-w-0 text-sm">
				{product.file ? (
					<>
						<p className="truncate font-medium">{product.file.name}</p>
						<p className="text-xs text-muted-foreground tabular-nums">{formatBytes(product.file.bytes)} · kept private: buyers get it through an expiring link</p>
					</>
				) : (
					<p className="text-muted-foreground">No file yet. Up to {maxFileMb} MB; it is kept private and only reaches people who bought it.</p>
				)}
			</div>
			<input ref={inputRef} type="file" className="sr-only" tabIndex={-1} aria-label="Product file" onChange={(event) => upload(event.target.files?.[0])} />
			<Button variant="outline" disabled={isUploading} onClick={() => inputRef.current?.click()} className="shrink-0">
				{isUploading ? <Loader2 className="animate-spin" /> : <FileUp data-icon="inline-start" />}
				{product.file ? "Replace file" : "Upload file"}
			</Button>
		</div>
	);
}
