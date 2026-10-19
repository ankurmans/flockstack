import { CAMPAIGN_STEPS } from "@/lib/campaign-steps";
import { cn } from "@/lib/utils";

// Compact tabs on phones and tablets, a numbered stepper from xl. Any step is one click away, in either direction.
export default function NavSteps({ step, onStep, className }) {
	return (
		<nav aria-label="Steps" className={className}>
			<ol className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1 xl:flex xl:items-center xl:gap-1.5 xl:bg-transparent xl:p-0">
				{CAMPAIGN_STEPS.map(({ id, label }, index) => {
					const isCurrent = id === step;
					return (
						<li key={id} className="flex items-center xl:gap-1.5">
							{index > 0 && <span aria-hidden="true" className="hidden h-px w-6 bg-border xl:block" />}
							<button
								type="button"
								aria-current={isCurrent ? "step" : undefined}
								onClick={() => onStep(id)}
								className={cn(
									"flex h-8 w-full items-center justify-center gap-2 rounded-md text-sm font-medium outline-none transition-[color,background-color,box-shadow,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] xl:h-9 xl:w-auto xl:rounded-full xl:pr-3.5 xl:pl-1.5",
									isCurrent
										? "bg-background text-foreground shadow-sm xl:bg-transparent xl:shadow-none"
										: "text-muted-foreground hover:text-foreground xl:hover:bg-muted"
								)}
							>
								<span
									className={cn(
										"grid size-5 shrink-0 place-items-center rounded-full text-[11px] tabular-nums transition-colors duration-150 xl:size-6 xl:text-xs",
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
