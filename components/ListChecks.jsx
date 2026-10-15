import { Check, CircleAlert, CircleCheck, CircleX } from "lucide-react";
import CardSettings from "@/components/CardSettings";
import { cn } from "@/lib/utils";

// The review step's checks (lib/presend-checks.js): the ones that need a look first, each with its fix, then the ones
// that pass. icon: a row that only informs, like the warm-up's, in place of its status.
export default function ListChecks({ checks, renderFix }) {
	const problems = checks.filter(({ isOk }) => !isOk);
	const passed = checks.filter(({ isOk }) => isOk);
	const blockingCount = problems.filter(({ isWarning }) => !isWarning).length;
	const warningCount = problems.length - blockingCount;

	return (
		<CardSettings
			title="Checklist"
			action={
				<span className="flex items-center gap-1.5">
					{blockingCount > 0 && <BadgeCount className="bg-foreground text-background">{blockingCount} to fix</BadgeCount>}
					{warningCount > 0 && <BadgeCount className="bg-foreground/10">{warningCount} to check</BadgeCount>}
					{problems.length === 0 && (
						<BadgeCount className="text-muted-foreground">
							<Check className="size-3.5" aria-hidden="true" />
							All set
						</BadgeCount>
					)}
				</span>
			}
		>
			{problems.length > 0 && (
				<ul className="divide-y divide-border/60">
					{problems.map((check) => {
						const Icon = check.isWarning ? CircleAlert : CircleX;
						const description = check.message ?? check.fix?.hint;
						return (
							<li key={check.id} className="flex items-center gap-3 px-4 py-3">
								<Icon
									aria-label={check.isWarning ? "To check" : "To fix"}
									className={cn("size-4 shrink-0", check.isWarning ? "text-amber-500" : "text-red-500")}
								/>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-medium">
										{check.label}
										{check.detail && (
											<span className="ml-1.5 font-normal text-muted-foreground tabular-nums">{check.detail}</span>
										)}
									</p>
									{description && <p className="text-sm text-pretty text-muted-foreground">{description}</p>}
								</div>
								{renderFix(check)}
							</li>
						);
					})}
				</ul>
			)}
			{passed.length > 0 && (
				<ul aria-label="Passed" className="grid gap-x-6 gap-y-2.5 px-4 py-3.5 sm:grid-cols-2">
					{passed.map(({ id, label, detail, icon: Icon = CircleCheck }) => (
						<li key={id} className="flex min-w-0 items-center gap-2 text-sm">
							<Icon
								aria-hidden="true"
								className={cn("size-4 shrink-0", Icon === CircleCheck ? "text-emerald-500" : "text-muted-foreground")}
							/>
							<span className="truncate text-muted-foreground">{label}</span>
							{detail && <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{detail}</span>}
						</li>
					))}
				</ul>
			)}
		</CardSettings>
	);
}

function BadgeCount({ className, children }) {
	return (
		<span
			className={cn(
				"inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap tabular-nums",
				className
			)}
		>
			{children}
		</span>
	);
}
