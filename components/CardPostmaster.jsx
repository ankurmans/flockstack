import { CircleCheck, TriangleAlert } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import { Button } from "@/components/ui/button";
import { formatDate, formatRelative } from "@/lib/format";
import { getPostmasterStatus } from "@/lib/postmaster";
import { formatRate } from "@/lib/rate-levels";
import { cn } from "@/lib/utils";

// A plain link: the route redirects to Google's consent screen, which the CSP's form-action would stop from a form.
const CONNECT_PATH = "/api/admin/postmaster/connect";
const MAX_FLAGS_SHOWN = 10;

// Gmail's spam rates, read once a day from Google Postmaster Tools with the Google account connected here.
// notice: what the connection's return to /admin says (?postmaster=).
export default async function CardPostmaster({ notice }) {
	const { domain, missing, redirectUri, connection } = await getPostmasterStatus();
	const message = NOTICES[notice];

	if (missing.length > 0) {
		return (
			<Shell>
				<p className="text-sm text-muted-foreground">
					Set {missing.join(", ")} to read Gmail&apos;s spam rates from Google Postmaster Tools.
				</p>
			</Shell>
		);
	}

	if (!connection) {
		return (
			<Shell message={message}>
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<p className="text-sm text-pretty text-muted-foreground">
						Connect the Google account that has {domain} in Postmaster Tools. Google&apos;s OAuth client needs{" "}
						<code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">{redirectUri}</code> as a redirect URI, and the
						project the Postmaster Tools API.
					</p>
					<ButtonConnect label="Connect" />
				</div>
			</Shell>
		);
	}

	const { lastRun, problem } = connection;
	const flagged = lastRun?.flagged ?? [];
	const items = [
		{ label: "Google account", value: connection.email ?? "Connected" },
		{ label: "Gmail spam rate", value: lastRun ? `${formatSpamRate(lastRun.spamRate)} on ${formatDay(lastRun.day)}` : "No data yet" },
		{ label: "Flagged by Gmail", value: lastRun ? formatFlagged(flagged.length) : "No data yet" },
		{ label: "Last checked", value: connection.checkedAt ? formatRelative(connection.checkedAt) : "Not yet, daily" },
	];

	return (
		<Shell message={message}>
			<dl className="-mx-4 -mt-4 grid grid-cols-2 gap-px border-b border-border/60 bg-border/60 lg:grid-cols-4">
				{items.map(({ label, value }) => (
					<div key={label} className="flex min-h-[66px] flex-col items-start justify-center gap-1.5 bg-card px-4 py-3">
						<dt className="text-xs text-muted-foreground">{label}</dt>
						<dd title={value} className="w-full truncate text-sm font-medium tabular-nums">
							{value}
						</dd>
					</div>
				))}
			</dl>
			{problem?.message && (
				<p className="flex items-start gap-2 text-sm text-pretty text-muted-foreground">
					<TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
					<span>
						Postmaster Tools refused: {problem.message}. Check that {connection.email ?? "this Google account"} has {domain} in Postmaster Tools
						and that the Postmaster Tools API is on, then connect again.
					</span>
				</p>
			)}
			{flagged.length > 0 && (
				<ul className="flex flex-col gap-1.5 text-sm">
					{flagged.slice(0, MAX_FLAGS_SHOWN).map(({ id, rate, action }) => (
						<li key={id} className="flex items-center justify-between gap-3">
							<span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{id}</span>
							<span className="flex shrink-0 items-center gap-2 tabular-nums">
								{formatRate(rate)}
								<BadgeStatus status={ACTION_STATUSES[action]} label={ACTION_LABELS[action] ?? action} />
							</span>
						</li>
					))}
				</ul>
			)}
			<div className="flex justify-end">
				<ButtonConnect label="Connect again" variant="outline" />
			</div>
		</Shell>
	);
}

function Shell({ message, children }) {
	return (
		<div className="flex flex-col gap-4 overflow-hidden rounded-xl bg-card p-4 shadow-border animate-fade-in">
			{message && (
				<p className={cn("flex items-center gap-2 text-sm", message.isGood ? "text-foreground" : "text-muted-foreground")}>
					{message.isGood ? <CircleCheck className="size-4 shrink-0 text-emerald-500" /> : <TriangleAlert className="size-4 shrink-0 text-amber-500" />}
					{message.text}
				</p>
			)}
			{children}
		</div>
	);
}

function ButtonConnect({ label, variant = "default" }) {
	return (
		<Button asChild size="sm" variant={variant} className="self-start sm:self-auto">
			<a href={CONNECT_PATH}>{label}</a>
		</Button>
	);
}

function formatDay(day) {
	return formatDate(`${day}T12:00:00Z`);
}

function formatSpamRate(rate) {
	return typeof rate === "number" ? formatRate(rate) : "None reported";
}

function formatFlagged(count) {
	return count > 0 ? `${count} feedback ID${count === 1 ? "" : "s"}` : "None";
}

const NOTICES = {
	connected: { isGood: true, text: "Connected. Gmail's spam rates are read once a day." },
	denied: { text: "Google's consent screen was canceled: nothing changed." },
	scope: { text: "Tick Postmaster Tools on Google's consent screen, then connect again." },
	expired: { text: "That connection expired or started in another browser: connect again." },
	failed: { text: "Google didn't finish the connection: connect again." },
	missing: { text: "Postmaster Tools isn't set up on this server yet." },
};

const ACTION_LABELS = {
	blocked: "Blocked",
	paused: "Paused",
	warned: "Owner warned",
	skipped: "Skipped",
	skip: "Skipped",
	none: "Under the pause level",
	wide: "Every account",
	unknown: "No account",
};

// BadgeStatus's statuses, for their dot's color.
const ACTION_STATUSES = { blocked: "blocked", paused: "paused", warned: "pending" };
