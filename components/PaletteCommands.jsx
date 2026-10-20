"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, File, Loader2, Mail, Plus, Search, User } from "lucide-react";
import { createCampaign } from "@/app/(app)/campaigns/actions";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ADMIN_PAGE, AUDIO_PAGE, BILLING_PAGE, MIN_SEARCH_LENGTH, PAGES, buildSections, isPaletteShortcut, moveIndex } from "@/lib/palette";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const ICONS = { "new-issue": Plus, page: File, issue: Mail, contact: User };
const SEARCH_DELAY_MS = 200;

// Cmd+K (Ctrl+K) opens a search over the dashboard: jump to a page, start a new issue, find an issue by its subject or a
// contact by the start of their address. Arrow keys move, Enter opens, Escape closes. It adds nothing the pages don't have.
export default function PaletteCommands({ newsletterId, hasBilling, hasAudio = false, isAdmin }) {
	const router = useRouter();
	const listId = useId();
	const [isOpen, setIsOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const [found, setFound] = useState({ campaigns: [], contacts: [] });
	const [isSearching, setIsSearching] = useState(false);
	const [isCreating, startCreating] = useTransition();
	const requestRef = useRef(0);

	useEffect(() => {
		function onKeyDown(event) {
			if (!isPaletteShortcut(event)) return;
			event.preventDefault();
			setIsOpen((current) => !current);
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	// The search runs once typing pauses; an answer for words already changed is dropped.
	useEffect(() => {
		const text = query.trim();
		const mine = ++requestRef.current;
		if (!isOpen || text.length < MIN_SEARCH_LENGTH) return;
		const timer = setTimeout(async () => {
			setIsSearching(true);
			try {
				const response = await fetch(`/api/palette?q=${encodeURIComponent(text)}`);
				const result = response.ok ? await response.json() : null;
				if (mine === requestRef.current) setFound(result ?? { campaigns: [], contacts: [] });
			} catch {
				if (mine === requestRef.current) setFound({ campaigns: [], contacts: [] });
			} finally {
				if (mine === requestRef.current) setIsSearching(false);
			}
		}, SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [query, isOpen]);

	const pages = [...PAGES, ...(hasAudio ? [AUDIO_PAGE] : []), ...(hasBilling ? [BILLING_PAGE] : []), ...(isAdmin ? [ADMIN_PAGE] : [])];
	const shownFound = query.trim().length >= MIN_SEARCH_LENGTH ? found : { campaigns: [], contacts: [] };
	const sections = buildSections(query, { pages, canCreate: Boolean(newsletterId), found: shownFound });
	const items = sections.flatMap((section) => section.items);
	const current = Math.min(active, Math.max(0, items.length - 1));

	function changeOpen(open) {
		setIsOpen(open);
		if (!open) {
			setQuery("");
			setActive(0);
			setFound({ campaigns: [], contacts: [] });
		}
	}

	function choose(item) {
		if (!item) return;
		if (item.kind === "new-issue") {
			startCreating(async () => {
				const result = await createCampaign(newsletterId);
				if (result?.error) toast.error(result.error);
			});
			return;
		}
		changeOpen(false);
		router.push(item.href);
	}

	function onKeyDown(event) {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setActive(moveIndex(current, items.length, event.key === "ArrowDown" ? 1 : -1));
		} else if (event.key === "Enter") {
			event.preventDefault();
			choose(items[current]);
		}
	}

	let position = -1;
	return (
		<Dialog open={isOpen} onOpenChange={changeOpen}>
			<DialogContent showCloseButton={false} className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg">
				<DialogTitle className="sr-only">Search and commands</DialogTitle>
				<DialogDescription className="sr-only">Type to find a page, an issue or a contact. Arrow keys move, Enter opens.</DialogDescription>
				<div className="flex items-center gap-2 border-b border-border/60 px-3">
					{isSearching || isCreating ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
					<input
						autoFocus
						role="combobox"
						aria-expanded="true"
						aria-controls={listId}
						aria-activedescendant={items.length > 0 ? `${listId}-${current}` : undefined}
						aria-label="Search pages, issues and contacts"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setActive(0);
						}}
						onKeyDown={onKeyDown}
						placeholder="Search pages, issues and contacts"
						className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
					/>
				</div>
				<div id={listId} role="listbox" className="max-h-80 overflow-y-auto p-1.5">
					{items.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">{isSearching ? "Searching…" : "Nothing found"}</p>}
					{sections.map((section) => (
						<div key={section.title} role="group" aria-label={section.title} className="mb-1">
							<p className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground">{section.title}</p>
							{section.items.map((item) => {
								position++;
								const index = position;
								const Icon = ICONS[item.kind];
								return (
									<div
										key={`${item.kind}:${item.id}`}
										id={`${listId}-${index}`}
										role="option"
										aria-selected={index === current}
										onMouseMove={() => setActive(index)}
										onClick={() => choose(item)}
										className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm", index === current && "bg-muted")}
									>
										<Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
										<span className="min-w-0 flex-1 truncate">{item.label}</span>
										{item.detail && <span className="shrink-0 text-xs text-muted-foreground">{item.detail}</span>}
										{index === current && <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
									</div>
								);
							})}
						</div>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
