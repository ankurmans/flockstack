import { CAMPAIGN_STEPS } from "@/lib/campaign-steps";
import { cn } from "@/lib/utils";

// Compact tabs on phones and tablets, a numbered stepper from lg. Any step is one click away, in either direction.
export default function NavSteps({ step, onStep, className }) {
	return (
		<nav aria-label="Steps" className={className}>
			<ol className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1 lg:flex lg:items-center lg:gap-1.5 lg:bg-transparent lg:p-0">
				{CAMPAIGN_STEPS.map(({ id, label }, index) => {
					const isCurrent = id === step;
					return (
						<li key={id} className="flex items-center lg:gap-1.5">
							{index > 0 && <span aria-hidden="true" className="hidden h-px w-6 bg-border lg:block" />}
							<button
								type="button"
								aria-current={isCurrent ? "step" : undefined}
								onClick={() => onStep(id)}
								className={cn(
									"flex h-8 w-full items-center justify-center gap-2 rounded-md text-sm font-medium outline-none transition-[color,background-color,box-shadow,scale] duration-150 ease-out focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97] lg:h-9 lg:w-auto lg:rounded-full lg:pr-3.5 lg:pl-1.5",
									isCurrent
										? "bg-background text-foreground shadow-sm lg:bg-transparent lg:shadow-none"
										: "text-muted-foreground hover:text-foreground lg:hover:bg-muted"
								)}
							>
								<span
									className={cn(
										"grid size-5 shrink-0 place-items-center rounded-full text-[11px] tabular-nums transition-colors duration-150 lg:size-6 lg:text-xs",
										isCurrent ? "bg-foreground text-background" : "shadow-border"
									)}
								>
									{index + 1}
								</span>
								{label}
							</button>
						</li>
					);
				})}
			</ol>
		</nav>
	);
}
