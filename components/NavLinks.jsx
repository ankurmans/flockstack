"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClipboardList, CreditCard, Filter, Gift, Globe, KeyRound, LayoutGrid, Megaphone, MessageSquare, Receipt, Repeat, Send, Settings, Shield, ShoppingBag, Users, Webhook, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";

// The open newsletter's pages, then the account's, which every newsletter shares.
export default function NavLinks({ isAdmin, onNavigate }) {
	const pathname = usePathname();
	const groups = [NEWSLETTER_ITEMS, [...ACCOUNT_ITEMS, ...(isAdmin ? [ADMIN_ITEM] : [])]];

	return (
		<nav className="flex flex-col gap-3">
			{groups.map((items, index) => (
				<ul key={index} className="flex flex-col gap-0.5 not-first:border-t not-first:border-border/60 not-first:pt-3">
					{items.map(({ href, label, icon: Icon }) => {
						const isActive = href === "/" ? pathname === href : pathname.startsWith(href);
						return (
							<li key={href}>
								<Link
									href={href}
									onClick={onNavigate}
									aria-current={isActive ? "page" : undefined}
									className={cn(
										"flex h-9 items-center gap-2.5 rounded-lg pr-3 pl-2.5 text-sm font-medium transition-colors duration-150",
										isActive
											? "bg-muted text-foreground"
											: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
									)}
								>
									<Icon className={cn("size-4", isActive && "text-link")} />
									{label}
								</Link>
							</li>
						);
					})}
				</ul>
			))}
		</nav>
	);
}

const NEWSLETTER_ITEMS = [
	{ href: "/", label: "Overview", icon: LayoutGrid },
	{ href: "/campaigns", label: "Campaigns", icon: Send },
	{ href: "/contacts", label: "Contacts", icon: Users },
	{ href: "/segments", label: "Segments", icon: Filter },
	{ href: "/automations", label: "Automations", icon: Workflow },
	{ href: "/series", label: "Series", icon: Repeat },
	{ href: "/surveys", label: "Surveys", icon: ClipboardList },
	{ href: "/referrals", label: "Referrals", icon: Gift },
	{ href: "/recommending", label: "Recommendations", icon: Megaphone },
	{ href: "/comments", label: "Comments", icon: MessageSquare },
	{ href: "/products", label: "Products", icon: ShoppingBag },
	{ href: "/newsletters", label: "Settings", icon: Settings },
];

const ACCOUNT_ITEMS = [
	{ href: "/orders", label: "Orders", icon: Receipt },
	{ href: "/payments", label: "Payments", icon: CreditCard },
	{ href: "/domains", label: "Domains", icon: Globe },
	{ href: "/api-keys", label: "API keys", icon: KeyRound },
	{ href: "/webhooks", label: "Webhooks", icon: Webhook },
];

const ADMIN_ITEM = { href: "/admin", label: "Admin", icon: Shield };
