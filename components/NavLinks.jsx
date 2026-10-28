"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { BarChart3, ChevronDown, ClipboardList, CreditCard, Filter, FormInput, Gift, Headphones, LayoutGrid, LayoutTemplate, Link2, Megaphone, MessageSquare, Newspaper, PanelsTopLeft, Receipt, Repeat, Send, Settings, ShoppingBag, Users, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";

// The sidebar's groups, by the job being done. Each group can be folded and the group of the current page is always open; what is folded is remembered in this browser only.
export default function NavLinks({ hasAudio = false, onNavigate }) {
	const pathname = usePathname();
	const closedValue = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	const closed = closedValue.split(",").filter(Boolean);
	const groups = getGroups({ hasAudio });

	return (
		<nav className="flex flex-col gap-3" aria-label="Dashboard">
			{groups.map(({ id, label, items }) => {
				const hasActive = items.some(({ href }) => isActivePath(pathname, href));
				const isOpen = !label || hasActive || !closed.includes(id);
				return (
					<div key={id} className="flex flex-col gap-0.5">
						{label && (
							<button
								type="button"
								onClick={() => toggleGroup(id, closedValue)}
								aria-expanded={isOpen}
								aria-controls={`nav-group-${id}`}
								className="flex h-7 items-center justify-between rounded-md pr-3 pl-2.5 text-[11px] font-medium tracking-wider text-muted-foreground/80 uppercase transition-colors duration-150 hover:text-foreground"
							>
								{label}
								<ChevronDown className={cn("size-3.5 transition-transform duration-150", !isOpen && "-rotate-90")} aria-hidden="true" />
							</button>
						)}
						<ul id={`nav-group-${id}`} hidden={!isOpen} className="flex flex-col gap-0.5">
							{items.map(({ href, label: itemLabel, icon: Icon }) => {
								const isActive = isActivePath(pathname, href);
								return (
									<li key={href}>
										<Link
											href={href}
											onClick={onNavigate}
											aria-current={isActive ? "page" : undefined}
											className={cn(
												"flex h-9 items-center gap-2.5 rounded-lg pr-3 pl-2.5 text-sm font-medium transition-colors duration-150",
												isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
											)}
										>
											<Icon className={cn("size-4", isActive && "text-link")} />
											{itemLabel}
										</Link>
									</li>
								);
							})}
						</ul>
					</div>
				);
			})}
		</nav>
	);
}

function isActivePath(pathname, href) {
	return href === "/" ? pathname === href : pathname.startsWith(href);
}

// The open newsletter's pages by the job being done. The account's own pages (Media, Domains, API keys, Webhooks, Admin) are in the user menu at the bottom.
export function getGroups({ hasAudio = false } = {}) {
	return [
		{
			id: "home",
			label: null,
			items: [
				{ href: "/", label: "Overview", icon: LayoutGrid },
				{ href: "/assistant", label: "Account assistant", icon: MessageSquare },
				{ href: "/reports", label: "Reports", icon: BarChart3 },
			],
		},
		{
			id: "write",
			label: "Write",
			items: [
				{ href: "/campaigns", label: "Campaigns", icon: Send },
				{ href: "/series", label: "Series", icon: Repeat },
				{ href: "/briefings", label: "Briefings", icon: Newspaper },
				{ href: "/automations", label: "Automations", icon: Workflow },
				{ href: "/templates", label: "Templates", icon: LayoutTemplate },
				...(hasAudio ? [{ href: "/audio", label: "Audio", icon: Headphones }] : []),
			],
		},
		{
			id: "audience",
			label: "Audience",
			items: [
				{ href: "/contacts", label: "Contacts", icon: Users },
				{ href: "/segments", label: "Segments", icon: Filter },
				{ href: "/forms", label: "Forms", icon: FormInput },
				{ href: "/surveys", label: "Surveys", icon: ClipboardList },
				{ href: "/referrals", label: "Referrals", icon: Gift },
				{ href: "/recommending", label: "Recommendations", icon: Megaphone },
			],
		},
		{
			id: "site",
			label: "Your site",
			items: [
				{ href: "/website", label: "Website", icon: PanelsTopLeft },
				{ href: "/comments", label: "Comments", icon: MessageSquare },
				{ href: "/mailing-lists", label: "Mailing lists", icon: Users },
				{ href: "/authors", label: "Authors", icon: Users },
				{ href: "/link-page", label: "Link page", icon: Link2 },
			],
		},
		{
			id: "sell",
			label: "Sell",
			items: [
				{ href: "/products", label: "Products", icon: ShoppingBag },
				{ href: "/perks", label: "Subscriber perks", icon: Gift },
				{ href: "/gift-links", label: "Gift links", icon: Link2 },
				{ href: "/orders", label: "Orders", icon: Receipt },
				{ href: "/payments", label: "Payments", icon: CreditCard },
			],
		},
		{
			id: "settings",
			label: null,
			items: [{ href: "/newsletters", label: "Settings", icon: Settings }],
		},
	];
}

// Which groups are folded lives in localStorage, read without a state update in an effect: the server and the first paint show the defaults.
const STORAGE_KEY = "fs_nav_closed";
// A browser that has never folded anything starts with the groups used less often folded.
const DEFAULT_CLOSED = "site,sell";
const listeners = new Set();

function subscribe(listener) {
	listeners.add(listener);
	window.addEventListener("storage", listener);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", listener);
	};
}

function getSnapshot() {
	try {
		return window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_CLOSED;
	} catch {
		return "";
	}
}

function getServerSnapshot() {
	return DEFAULT_CLOSED;
}

function toggleGroup(id, closedValue) {
	const closed = closedValue.split(",").filter(Boolean);
	const next = closed.includes(id) ? closed.filter((item) => item !== id) : [...closed, id];
	try {
		window.localStorage.setItem(STORAGE_KEY, next.join(","));
	} catch {
		// A browser that refuses storage keeps the defaults.
	}
	for (const listener of listeners) listener();
}
