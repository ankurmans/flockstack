import Link from "next/link";
import { FileText, FolderOpen, Images, Search } from "lucide-react";
import HeaderPage from "@/components/HeaderPage";
import ListMedia from "@/components/ListMedia";
import StateEmpty from "@/components/StateEmpty";
import ZoneUploadMedia from "@/components/ZoneUploadMedia";
import { Button } from "@/components/ui/button";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata = { title: "Media" };

const KINDS = [
	{ value: "", label: "All" },
	{ value: "image", label: "Images" },
	{ value: "file", label: "Files" },
];

function readParam(value, max) {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// The account's uploaded images and files, in folders, searchable by name. The first page is read here; later pages are links.
export default async function MediaPage({ searchParams }) {
	const params = await searchParams;
	const folder = readParam(params.folder, 60);
	const isUnfiled = params.unfiled === "1";
	const search = readParam(params.q, 100);
	const kind = ["image", "file"].includes(params.kind) ? params.kind : "";
	const cursor = readParam(params.cursor, 200);

	const [{ output, failure }, { output: folderList }] = await Promise.all([
		runDashboardAction("list_media", {
			limit: 48,
			...(isUnfiled ? { folder: "" } : folder ? { folder } : {}),
			...(search && { search }),
			...(kind && { kind }),
			...(cursor && { cursor }),
		}),
		runDashboardAction("list_media_folders"),
	]);
	const media = output?.media ?? [];
	const folders = folderList?.folders ?? [];
	const unfiled = folderList?.unfiled ?? 0;
	const total = folders.reduce((sum, { count }) => sum + count, unfiled);

	function href(changes) {
		const next = new URLSearchParams(Object.entries({ folder: isUnfiled ? "" : folder, unfiled: isUnfiled ? "1" : "", q: search, kind, ...changes }).filter(([, value]) => value));
		return `/media${next.size ? `?${next}` : ""}`;
	}

	return (
		<>
			<HeaderPage title="Media">
				<ZoneUploadMedia folder={isUnfiled ? "" : folder} />
			</HeaderPage>

			<div className="mb-6 flex flex-col gap-4">
				<nav aria-label="Folders" className="flex flex-wrap gap-1.5">
					<ChipFolder href={href({ folder: "", unfiled: "", cursor: "" })} isActive={!folder && !isUnfiled} label="All" count={total} icon={Images} />
					{unfiled > 0 && folders.length > 0 && <ChipFolder href={href({ folder: "", unfiled: "1", cursor: "" })} isActive={isUnfiled} label="No folder" count={unfiled} icon={FileText} />}
					{folders.map(({ name, count }) => (
						<ChipFolder key={name} href={href({ folder: name, unfiled: "", cursor: "" })} isActive={folder === name} label={name} count={count} icon={FolderOpen} />
					))}
				</nav>
				<div className="flex flex-wrap items-center gap-3">
					<form action="/media" className="relative min-w-0 flex-1 sm:max-w-xs">
						<Search aria-hidden="true" className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
						<input
							name="q"
							defaultValue={search}
							placeholder="Search names"
							aria-label="Search names"
							className="h-9 w-full rounded-lg border border-input bg-transparent pr-3 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
						/>
						{folder && <input type="hidden" name="folder" value={folder} />}
						{isUnfiled && <input type="hidden" name="unfiled" value="1" />}
						{kind && <input type="hidden" name="kind" value={kind} />}
					</form>
					<div className="flex gap-1" role="group" aria-label="Kind">
						{KINDS.map(({ value, label }) => (
							<Button key={label} asChild variant={kind === value ? "secondary" : "ghost"} size="sm">
								<Link href={href({ kind: value, cursor: "" })} aria-current={kind === value ? "true" : undefined}>
									{label}
								</Link>
							</Button>
						))}
					</div>
				</div>
			</div>

			{failure ? (
				<StateEmpty icon={Images} title="Couldn't load the media">
					<p className="text-sm text-muted-foreground">{failure.message}</p>
				</StateEmpty>
			) : media.length === 0 ? (
				<StateEmpty icon={search ? Search : Images} title={search ? `Nothing named "${search}"` : total === 0 ? "No media yet" : "Nothing here"}>
					{total === 0 && <p className="max-w-sm text-sm text-pretty text-muted-foreground">Images and files you upload here, or in the editor, show up in one place.</p>}
				</StateEmpty>
			) : (
				<div className="animate-enter">
					<ListMedia media={media} folders={folders.map(({ name }) => name)} />
					<div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
						<span>
							{cursor ? <Link href={href({ cursor: "" })} className="underline underline-offset-4">Back to the newest</Link> : `${formatNumber(media.length)} shown`}
						</span>
						{output.nextCursor && (
							<Button asChild variant="outline" size="sm">
								<Link href={href({ cursor: output.nextCursor })}>Older</Link>
							</Button>
						)}
					</div>
				</div>
			)}
		</>
	);
}

function ChipFolder({ href, isActive, label, count, icon: Icon }) {
	return (
		<Link
			href={href}
			aria-current={isActive ? "true" : undefined}
			className={cn(
				"flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors duration-150",
				isActive ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
			)}
		>
			<Icon className="size-3.5" aria-hidden="true" />
			{label}
			<span className="text-xs tabular-nums opacity-70">{formatNumber(count)}</span>
		</Link>
	);
}
