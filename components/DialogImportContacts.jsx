"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileUp, Loader2, Upload } from "lucide-react";
import Papa from "papaparse";
import { importContacts } from "@/app/(app)/contacts/actions";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { MAX_IMPORT_ROWS_PER_REQUEST, mapColumns, mapExtraColumns, normalizeImportRow } from "@/lib/csv-import";
import { CONSENT_TEXT, DROP_REASONS, addDropped } from "@/lib/import-checks";
import { formatNumber } from "@/lib/format";
import { parseTagList } from "@/lib/tag-rules";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

// Into the newsletter the page shows.
export default function DialogImportContacts({ newsletter, definitions = [], label = "Import", variant = "outline" }) {
	const router = useRouter();
	const [isOpen, setIsOpen] = useState(false);
	const [mode, setMode] = useState("file");
	const [file, setFile] = useState(null);
	const [parsed, setParsed] = useState(null);
	const [progress, setProgress] = useState(null);
	const [hasConsent, setHasConsent] = useState(false);
	const [mapping, setMapping] = useState({});
	const [importTag, setImportTag] = useState("");
	const [summary, setSummary] = useState(null);
	const [isImporting, startImporting] = useTransition();

	// Invalid rows still go to the server, which checks every row again and counts them in the import.
	const { rows, invalidRows, duplicates } = useMemo(() => {
		if (!parsed) return { rows: [], invalidRows: [], duplicates: 0 };
		const options = { ...(mode === "dormant" && { status: "dormant" }), extra: getExtra(mapping) };
		const byEmail = new Map();
		const invalid = [];
		for (const row of parsed.rows) {
			const normalized = normalizeImportRow(row, parsed.columns, options);
			if (!normalized)
				invalid.push({ email: String(row[parsed.columns.email] ?? "").slice(0, 254), status: "active" });
			else if (!byEmail.has(normalized.email)) byEmail.set(normalized.email, normalized);
		}
		return {
			rows: [...byEmail.values()],
			invalidRows: invalid,
			duplicates: parsed.rows.length - invalid.length - byEmail.size,
		};
	}, [parsed, mode, mapping]);
	const statusCounts = useMemo(
		() =>
			Object.entries(Object.groupBy(rows, ({ status }) => status)).map(([status, group]) => [
				status,
				group.length,
			]),
		[rows],
	);

	function reset() {
		setFile(null);
		setParsed(null);
		setProgress(null);
		setHasConsent(false);
		setMapping({});
		setImportTag("");
		setSummary(null);
	}

	function onFileChange(event) {
		const selected = event.target.files?.[0];
		if (!selected) return;
		setFile(selected);
		Papa.parse(selected, {
			header: true,
			skipEmptyLines: true,
			complete: ({ data, meta }) => {
				const columns = mapColumns(meta.fields ?? []);
				if (!columns.email) {
					toast.error("No email column found");
					return reset();
				}
				const headers = meta.fields ?? [];
				const extra = mapExtraColumns(headers, definitions);
				const builtIn = new Set(Object.values(columns).filter(Boolean));
				setMapping(
					Object.fromEntries(
						headers
							.filter((header) => !builtIn.has(header))
							.map((header) => {
								const key = Object.entries(extra.fields).find(([, column]) => column === header)?.[0];
								return [header, header === extra.tags ? "tags" : key ? `field:${key}` : "skip"];
							})
					)
				);
				setParsed({ rows: data, columns });
			},
			error: () => toast.error("Could not read this file"),
		});
	}

	function runImport() {
		startImporting(async () => {
			const allRows = [...rows, ...invalidRows];
			const totals = { created: 0, existing: 0, dropped: {} };
			let importId;
			for (let start = 0; start < allRows.length; start += MAX_IMPORT_ROWS_PER_REQUEST) {
				setProgress(start / allRows.length);
				const result = await importContacts({
					newsletterId: newsletter.id,
					consent: hasConsent,
					tags: parseTagList(importTag),
					importId,
					duplicates: importId ? 0 : duplicates,
					rows: allRows.slice(start, start + MAX_IMPORT_ROWS_PER_REQUEST),
				});
				if (result?.error) {
					toast.error(result.error);
					return setProgress(null);
				}
				importId = result.importId;
				totals.created += result.created;
				totals.existing += result.existing;
				totals.dropped = addDropped(totals.dropped, result.dropped);
			}
			setProgress(null);
			setSummary(totals);
			router.refresh();
		});
	}

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				if (isImporting) return;
				setIsOpen(open);
				if (!open) reset();
			}}
		>
			<DialogTrigger asChild>
				<Button variant={variant} disabled={!newsletter}>
					<Upload data-icon="inline-start" />
					{label}
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Import contacts</DialogTitle>
					<DialogDescription>
						Into <span className="font-medium text-foreground">{newsletter?.name}</span>. A CSV with an email column:
						exports from beehiiv, Substack, Mailchimp, Kit and other platforms work as they are. Existing contacts keep
						their status.
					</DialogDescription>
				</DialogHeader>

				{summary ? (
					<SummaryImport summary={summary} />
				) : (
					<div className="flex flex-col gap-3">
						<Select value={mode} onValueChange={setMode} disabled={isImporting}>
							<SelectTrigger className="h-9 w-full" aria-label="Status">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="file">Status from file</SelectItem>
								<SelectItem value="dormant">Import as dormant</SelectItem>
							</SelectContent>
						</Select>

						<label
							className={cn(
								"flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl px-4 py-8 text-center shadow-border transition-[box-shadow,background-color] duration-150 hover:bg-muted/40 hover:shadow-border-hover",
								isImporting && "pointer-events-none opacity-60",
							)}
						>
							<FileUp className="size-5 text-muted-foreground" />
							<span className="max-w-full truncate text-sm font-medium">
								{file ? file.name : "Choose a CSV file"}
							</span>
							{parsed && (
								<span className="text-xs text-muted-foreground tabular-nums">
									{formatNumber(rows.length)} unique valid of {formatNumber(parsed.rows.length)} rows
								</span>
							)}
							<input type="file" accept=".csv,text/csv" className="sr-only" onChange={onFileChange} />
						</label>

						{statusCounts.length > 0 && (
							<div className="flex flex-wrap gap-1.5">
								{statusCounts.map(([status, count]) => (
									<span
										key={status}
										className="inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2 text-xs text-muted-foreground tabular-nums"
									>
										{status} <span className="text-foreground">{formatNumber(count)}</span>
									</span>
								))}
							</div>
						)}

						{Object.keys(mapping).length > 0 && (
							<ColumnMapping mapping={mapping} onChange={setMapping} definitions={definitions} isDisabled={isImporting} />
						)}

						<Input
							value={importTag}
							onChange={(event) => setImportTag(event.target.value)}
							placeholder="Tag everyone in this file (optional)"
							aria-label="Tag everyone in this file"
							maxLength={120}
							disabled={isImporting}
							className="h-9"
						/>

						<label className="flex items-start gap-2.5 text-sm">
							<input
								type="checkbox"
								checked={hasConsent}
								onChange={(event) => setHasConsent(event.target.checked)}
								disabled={isImporting}
								className="mt-0.5 size-4 shrink-0 accent-foreground"
							/>
							<span>
								{CONSENT_TEXT}
								<span className="block text-xs text-muted-foreground">
									Role addresses, throwaway inboxes and addresses that bounced or complained are left out.
								</span>
							</span>
						</label>

						{progress !== null && (
							<div className="h-1.5 overflow-hidden rounded-full bg-muted">
								<div
									className="h-full rounded-full bg-foreground transition-[width] duration-300"
									style={{ width: `${Math.max(progress, 0.02) * 100}%` }}
								/>
							</div>
						)}
					</div>
				)}

				<DialogFooter>
					{summary ? (
						<Button
							onClick={() => {
								setIsOpen(false);
								reset();
							}}
							className="min-w-24"
						>
							Done
						</Button>
					) : (
						<Button
							onClick={runImport}
							disabled={!newsletter || rows.length === 0 || !hasConsent || isImporting}
							className="min-w-24"
						>
							{isImporting ? (
								<Loader2 className="animate-spin" />
							) : (
								`Import ${rows.length ? formatNumber(rows.length) : ""}`.trim()
							)}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// The columns the import doesn't read as email, status or dates: skipped, read as tags, or as a custom field.
function getExtra(mapping) {
	const entries = Object.entries(mapping);
	return {
		tags: entries.filter(([, choice]) => choice === "tags").map(([header]) => header),
		fields: Object.fromEntries(entries.filter(([, choice]) => choice.startsWith("field:")).map(([header, choice]) => [choice.slice(6), header])),
	};
}

function ColumnMapping({ mapping, onChange, definitions, isDisabled }) {
	return (
		<div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto rounded-xl px-3.5 py-3 shadow-border">
			<p className="text-xs text-muted-foreground">Other columns in the file</p>
			{Object.entries(mapping).map(([header, choice]) => (
				<div key={header} className="flex items-center gap-2 text-sm">
					<span className="min-w-0 flex-1 truncate">{header}</span>
					<Select value={choice} onValueChange={(value) => onChange({ ...mapping, [header]: value })} disabled={isDisabled}>
						<SelectTrigger size="sm" className="w-40" aria-label={`What to do with ${header}`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="skip">Skip</SelectItem>
							<SelectItem value="tags">Tags</SelectItem>
							{definitions.map((field) => (
								<SelectItem key={field.key} value={`field:${field.key}`}>
									Field: {field.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			))}
		</div>
	);
}

function SummaryImport({ summary }) {
	const dropped = Object.entries(summary.dropped).filter(([, count]) => count > 0);
	return (
		<div className="flex flex-col gap-3 text-sm">
			<p>
				<span className="font-medium tabular-nums">{formatNumber(summary.created)}</span> added,{" "}
				<span className="font-medium tabular-nums">{formatNumber(summary.existing)}</span> already there.
			</p>
			{dropped.length > 0 ? (
				<div className="rounded-xl px-4 py-3 shadow-border">
					<p className="mb-2 font-medium">
						{formatNumber(dropped.reduce((sum, [, count]) => sum + count, 0))} left out
					</p>
					<ul className="flex flex-col gap-1 text-muted-foreground">
						{dropped.map(([reason, count]) => (
							<li key={reason} className="flex justify-between gap-4">
								<span>{DROP_REASONS[reason]}</span>
								<span className="text-foreground tabular-nums">{formatNumber(count)}</span>
							</li>
						))}
					</ul>
				</div>
			) : (
				<p className="text-muted-foreground">Nothing left out.</p>
			)}
		</div>
	);
}
