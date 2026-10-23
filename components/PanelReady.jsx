"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Check, CircleAlert, CircleCheck, CircleX, FlaskConical, Info, Loader2, Monitor, Moon, Smartphone, Sun } from "lucide-react";
import CardSettings from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The review step's ready-to-send check (lib/ready-check.js): what needs fixing first, then what is worth a look, what to
// know and what is fine, each with one sentence and where to fix it. ready: lib/use-ready-check.js.
// isApproval: the card under an agent's request, where there is no draft to edit and no test to send.
export default function PanelReady({ ready, extra = [], isApproval = false, onFix, onTest, isTesting, isTestDisabled }) {
	const { result, error } = ready;
	const items = result?.items ?? [];
	const blockers = items.filter(({ status }) => status === "blocker");
	const warnings = items.filter(({ status }) => status === "warning");
	const infos = [...items.filter(({ status }) => status === "info"), ...extra];
	const passed = items.filter(({ status }) => status === "pass");

	return (
		<CardSettings
			title="Ready to send?"
			action={
				<span className="flex items-center gap-1.5">
					{blockers.length > 0 && <BadgeCount className="bg-foreground text-background">{blockers.length} to fix</BadgeCount>}
					{warnings.length > 0 && <BadgeCount className="bg-foreground/10">{warnings.length} to check</BadgeCount>}
					{result && blockers.length + warnings.length === 0 && (
						<BadgeCount className="text-muted-foreground">
							<Check className="size-3.5" aria-hidden="true" />
							All set
						</BadgeCount>
					)}
					{!isApproval && (
						<Button variant="outline" size="sm" onClick={onTest} disabled={isTestDisabled || isTesting} className="ml-1 min-w-32">
							{isTesting ? <Loader2 className="animate-spin" /> : <FlaskConical data-icon="inline-start" />}
							{isTesting ? null : "Send a test to me"}
						</Button>
					)}
				</span>
			}
		>
			{!result && (
				<p role="status" className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
					{error ? (
						error
					) : (
						<>
							<Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
							Checking your draft…
						</>
					)}
				</p>
			)}
			{[...blockers, ...warnings, ...infos].length > 0 && (
				<ul className="divide-y divide-border/60">
					{[...blockers, ...warnings, ...infos].map((entry) => (
						<RowItem key={entry.id} entry={entry} isApproval={isApproval} isChecking={result?.isChecking && entry.id === "links"} onFix={onFix} onTest={onTest} />
					))}
				</ul>
			)}
			{passed.length > 0 && (
				<ul aria-label="Passed" className="grid gap-x-6 gap-y-2.5 px-4 py-3.5 sm:grid-cols-2">
					{passed.map(({ id, title, message }) => (
						<li key={id} title={message} className="flex min-w-0 items-center gap-2 text-sm">
							<CircleCheck aria-hidden="true" className="size-4 shrink-0 text-emerald-500" />
							<span className="truncate text-muted-foreground">{title}</span>
						</li>
					))}
				</ul>
			)}
		</CardSettings>
	);
}

const ICONS = {
	blocker: { Icon: CircleX, label: "To fix", className: "text-red-500" },
	warning: { Icon: CircleAlert, label: "To check", className: "text-amber-500" },
	info: { Icon: Info, label: "Good to know", className: "text-muted-foreground" },
};

function RowItem({ entry, isApproval, isChecking, onFix, onTest }) {
	const { Icon, label, className } = ICONS[entry.status];
	return (
		<li data-check={entry.id} data-status={entry.status} className="flex items-center gap-3 px-4 py-3">
			{isChecking ? (
				<Loader2 aria-label="Checking" className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
			) : (
				<Icon aria-label={label} className={cn("size-4 shrink-0", className)} />
			)}
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium">{entry.title}</p>
				<p className="text-sm text-pretty text-muted-foreground">{entry.message}</p>
			</div>
			{entry.fix && !isApproval && <ButtonFix fix={entry.fix} onFix={onFix} onTest={onTest} />}
		</li>
	);
}

function ButtonFix({ fix, onFix, onTest }) {
	if (fix.path) {
		return (
			<Button asChild variant="outline" size="sm">
				<Link href={fix.path}>{fix.label}</Link>
			</Button>
		);
	}
	return (
		<Button variant="outline" size="sm" onClick={() => (fix.target === "test" ? onTest() : onFix(fix.target))}>
			{fix.label}
		</Button>
	);
}

function BadgeCount({ className, children }) {
	return (
		<span className={cn("inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap tabular-nums", className)}>
			{children}
		</span>
	);
}

const DEVICES = [
	{ id: "phone", label: "Phone", icon: Smartphone, width: 375 },
	{ id: "desktop", label: "Desktop", icon: Monitor, width: 640 },
];
const SCHEMES = [
	{ id: "light", label: "Light", icon: Sun },
	{ id: "dark", label: "Dark", icon: Moon },
];

// Clients that darken an email on their own turn the white page dark and the dark text light, and leave pictures alone. This
// does the same to the page, as an approximation of what readers of those clients see.
const DARK_STYLE = "<style>html{background:#000}body{min-height:100vh;filter:invert(1) hue-rotate(180deg)}img,video{filter:invert(1) hue-rotate(180deg)}</style>";

// The email at the two widths readers see it at, light and dark, in a frame that runs nothing: sandbox="" gives it no scripts,
// no forms and no origin of its own.
export function PreviewReady({ html }) {
	const [device, setDevice] = useState("phone");
	const [scheme, setScheme] = useState("light");
	const width = DEVICES.find(({ id }) => id === device).width;
	const document = useMemo(() => (scheme === "dark" ? html.replace(/<\/head>/i, `${DARK_STYLE}</head>`) : html), [html, scheme]);

	return (
		<CardSettings
			title="Preview"
			stagger={1}
			action={
				<span className="flex items-center gap-2">
					<Toggle label="Device" options={DEVICES} value={device} onChange={setDevice} />
					<Toggle label="Colors" options={SCHEMES} value={scheme} onChange={setScheme} />
				</span>
			}
		>
			<div className={cn("flex justify-center overflow-x-auto p-3 sm:p-5", scheme === "dark" ? "bg-zinc-900" : "bg-muted/50")}>
				<iframe
					title={`Email preview, ${device} width, ${scheme} colors`}
					sandbox=""
					srcDoc={document}
					style={{ width }}
					className="h-[560px] max-w-full shrink-0 rounded-lg bg-white shadow-border transition-[width] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none"
				/>
			</div>
		</CardSettings>
	);
}

function Toggle({ label, options, value, onChange }) {
	return (
		<div role="radiogroup" aria-label={label} className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
			{options.map(({ id, label: name, icon: Icon, width }) => (
				<button
					key={id}
					type="button"
					role="radio"
					aria-checked={value === id}
					aria-label={width ? `${name}, ${width} pixels wide` : name}
					onClick={() => onChange(id)}
					className={cn(
						"relative grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-[color,background-color,box-shadow] duration-150 after:absolute after:-inset-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
						value === id && "bg-background text-foreground shadow-border"
					)}
				>
					<Icon className="size-3.5" aria-hidden="true" />
				</button>
			))}
		</div>
	);
}
