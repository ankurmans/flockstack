"use client";

import { useId, useState } from "react";
import { useFormStatus } from "react-dom";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// free: the Free plan (lib/pricing.js), the first step before the plans: no price, no checkout. Its button leads to
// ctaHref on the pages that don't sell yet, is the current plan on Free, and with an action leaves for Free (the form
// posts plan "free": the billing page opens the portal to cancel).
// plans: display-ready values from lib/pricing.js, in plan order, with a price for each billing period.
// custom: the Custom plan (lib/custom-tier.js), a last step after the largest plan with no price and no checkout: its
// button leads to the request form, whatever action or ctaHref say.
// current: the account's plan, and its interval when Stripe bills it: then only that billing period is marked.
// action: with a plan Stripe bills, the server action that switches to the plan and period picked. Without it, the
// button subscribes through Checkout.
// ctaHref, ctaLabel: for pages that don't sell yet (the landing page leads to sign-up), a link in place of Checkout.
// children: under the button. The Subscribe link isn't a <Link>: a prefetch would open a Checkout session.
export default function SliderPricing({ free, plans: planStops, custom, freeMonths, extraPerThousand, initialIndex = 0, initialPeriod = "month", current, action, ctaHref, ctaLabel = "Subscribe", ctaFreeLabel = "Start for free", children }) {
	const id = useId();
	const [index, setIndex] = useState(initialIndex);
	const [period, setPeriod] = useState(initialPeriod);
	const plans = [...(free ? [{ ...free, isFree: true }] : []), ...planStops, ...(custom ? [{ ...custom, isCustom: true }] : [])];
	const plan = plans[index];
	const isCustom = Boolean(plan.isCustom);
	const isFree = Boolean(plan.isFree);
	const price = plan.prices?.[period];
	const isYearly = period === "year";
	const lastIndex = plans.length - 1;
	const barWidth = (100 - lastIndex * BAR_GAP) / plans.length;
	const step = barWidth + BAR_GAP;
	// With a Custom step the largest plan is no longer the tallest bar.
	const barScale = custom ? 0.78 : 1;
	const currentIndex = plans.findIndex((stop) => stop.id === current?.plan && (!current.interval || current.interval === period));
	const isCurrent = index === currentIndex;

	return (
		<div className="grid overflow-hidden rounded-3xl bg-card shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_2px_4px_rgb(0_0_0/0.03),0_24px_48px_-24px_rgb(0_0_0/0.16)] lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] dark:shadow-border">
			<div className="@container flex flex-col p-6 sm:p-9">
				{/* Side by side, the label and the switch take about 22rem: in a narrower column, on any screen, the switch goes first. */}
				<div className="flex flex-col-reverse items-start gap-8 @sm:flex-row @sm:flex-wrap @sm:items-center @sm:justify-between @sm:gap-4">
					<label htmlFor={`${id}-emails`} className="text-sm font-medium">
						Emails a month
					</label>
					<fieldset className="inline-flex items-center gap-1 rounded-xl bg-muted/70 p-1">
						<legend className="sr-only">Billing</legend>
						{PERIODS.map(({ value, label }) => (
							<label
								key={value}
								className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,box-shadow] duration-150 select-none hover:text-foreground has-checked:bg-background has-checked:text-foreground has-checked:shadow-border has-focus-visible:ring-2 has-focus-visible:ring-ring dark:has-checked:bg-muted"
							>
								<input
									type="radio"
									name={`${id}-period`}
									value={value}
									checked={period === value}
									onChange={() => setPeriod(value)}
									className="sr-only"
								/>
								{label}
								{value === "year" && <span className="text-xs font-normal text-link">{freeMonths} months free</span>}
							</label>
						))}
					</fieldset>
				</div>

				<p
					className={cn(
						"mt-3 font-display leading-none font-[440] tracking-[-0.03em] tabular-nums @sm:mt-8",
						isCustom ? "text-4xl sm:text-5xl" : "text-6xl sm:text-7xl"
					)}
				>
					{plan.emails}
				</p>
				<p className="mt-3 text-sm text-muted-foreground tabular-nums">
					{isCustom ? "For lists with " : "For up to "}
					<span className="font-medium text-foreground">{isCustom ? plan.subscribers.toLowerCase() : plan.subscribers}</span> subscribers
				</p>

				<div className="mt-auto pt-8">
					<div aria-hidden="true" className="relative h-32 sm:h-36">
						{plans.map((stop, stopIndex) => (
							<button
								key={stop.id}
								type="button"
								tabIndex={-1}
								onClick={() => setIndex(stopIndex)}
								style={{ left: `${stopIndex * step}%`, width: `${barWidth}%`, height: `${stop.isCustom ? 100 : Math.max(stop.bar, 0.28) * 100 * barScale}%` }}
								className={cn(
									"absolute bottom-0 flex justify-center rounded-t-xl pt-2 text-xs font-semibold tabular-nums transition-colors duration-200",
									stop.isCustom && "border-2 border-b-0 border-dashed text-[11px]",
									stopIndex === index
										? "border-primary bg-primary text-primary-foreground"
										: "border-foreground/25 bg-foreground/[0.07] text-muted-foreground hover:bg-foreground/[0.12]"
								)}
							>
								{stop.isCustom ? stop.name : stop.prices[period].price}
								{stopIndex === currentIndex && (
									<span className="absolute bottom-full mb-1.5 text-[11px] font-medium text-foreground">Current</span>
								)}
							</button>
						))}
					</div>
					<input
						id={`${id}-emails`}
						type="range"
						min={0}
						max={lastIndex}
						step={1}
						value={index}
						onChange={(event) => setIndex(Number(event.target.value))}
						aria-valuetext={
							isCustom
								? `${plan.emails} emails a month, the Custom plan: let's talk`
								: `${plan.emails} emails a month, the ${plan.name} plan${isCurrent ? ", your current plan" : ""}`
						}
						style={{ "--ratio": index / lastIndex, marginLeft: `calc(${barWidth / 2}% - 0.875rem)`, width: `calc(${100 - barWidth}% + 1.75rem)` }}
						className="slider-plans mt-3"
					/>
					<div className="relative mt-2 h-8">
						{plans.map((stop, stopIndex) => (
							<button
								key={stop.id}
								type="button"
								tabIndex={-1}
								aria-label={stop.isCustom ? `Custom plan, ${stop.emails.toLowerCase()} emails a month` : `${stop.emails} emails a month`}
								onClick={() => setIndex(stopIndex)}
								style={{ left: `${barWidth / 2 + stopIndex * step}%` }}
								className={cn(
									"absolute top-0 flex h-8 -translate-x-1/2 items-center rounded-md px-1.5 text-xs font-medium tabular-nums transition-colors duration-150",
									stopIndex === index ? "text-foreground" : "text-muted-foreground hover:text-foreground"
								)}
							>
								{stop.emailsShort}
							</button>
						))}
					</div>
				</div>
			</div>

			<div className="flex flex-col border-t border-border/70 bg-muted/40 p-6 sm:p-9 lg:border-t-0 lg:border-l">
				<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
					<p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
						{plan.name}
						{isCurrent && <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] whitespace-nowrap text-primary-foreground">Current plan</span>}
					</p>
					{!isCustom && !isFree && (
						<p className="rounded-full bg-foreground/[0.06] px-2.5 py-0.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
							{price.perThousand} per 1,000 emails
						</p>
					)}
				</div>
				{isCustom ? (
					<>
						<p className="mt-3 text-5xl font-semibold tracking-tight">{plan.price}</p>
						<p className="mt-1.5 h-5 text-sm text-muted-foreground">{plan.reply}</p>
					</>
				) : isFree ? (
					<>
						<p className="mt-3 flex items-baseline gap-1.5 tabular-nums">
							<span className="text-5xl font-semibold tracking-tight">{price.price}</span>
							<span className="text-muted-foreground">/month</span>
						</p>
						<p className="mt-1.5 h-5 text-sm text-muted-foreground">No card needed</p>
						<p className="mt-1 text-sm text-pretty text-muted-foreground tabular-nums">
							No extra emails: sending stops at {plan.emails} a month, until the next one or an upgrade
						</p>
					</>
				) : (
					<>
						<p className="mt-3 flex items-baseline gap-1.5 tabular-nums">
							<span className="text-5xl font-semibold tracking-tight">{price.price}</span>
							<span className="text-muted-foreground">/{isYearly ? "year" : "month"}</span>
						</p>
						<p className="mt-1.5 h-5 text-sm text-muted-foreground tabular-nums">{isYearly ? `${price.monthly} a month, billed yearly` : "Billed monthly"}</p>
						{extraPerThousand && (
							<p className="mt-1 text-sm text-pretty text-muted-foreground tabular-nums">
								Past {plan.emails} emails: {extraPerThousand} per 1,000 extra, up to a limit you set
							</p>
						)}
					</>
				)}
				<div className="mt-6 border-t border-border/70 pt-6">
					{isCustom || isFree ? (
						<>
							<p className="text-xs font-medium text-muted-foreground">{isFree ? "The Free plan has" : "A Custom plan has"}</p>
							<ul {...(isFree ? { "data-free-plan": true } : { "data-custom-plan": true })} className="mt-3 flex flex-col gap-2 text-[13px]">
								{plan.bullets.map((label) => (
									<li key={label} className="flex items-start gap-2">
										<Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" strokeWidth={2.5} />
										{label}
									</li>
								))}
							</ul>
						</>
					) : (
						<>
							<p className="text-xs font-medium text-muted-foreground">Every plan includes</p>
							<ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
								{INCLUDED.map((label) => (
									<li key={label} className="flex items-center gap-2">
										<Check className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2.5} />
										{label}
									</li>
								))}
							</ul>
						</>
					)}
				</div>
				<div className="mt-auto pt-8">
					{isCustom ? (
						<Button asChild size="lg" variant="outline" className="h-11 w-full text-[15px]">
							<a href={plan.href}>
								{plan.button}
								<ArrowRight data-icon="inline-end" />
							</a>
						</Button>
					) : isFree && !action && !ctaHref ? (
						isCurrent && (
							<Button size="lg" variant="outline" disabled className="h-11 w-full text-[15px]">
								Current plan
							</Button>
						)
					) : action ? (
						<form action={action}>
							<input type="hidden" name="plan" value={plan.id} />
							<input type="hidden" name="interval" value={period} />
							<ButtonSwitch isCurrent={isCurrent} label={isFree ? "Downgrade to Free" : "Switch"} />
						</form>
					) : isFree ? (
						<Button asChild size="lg" className="h-11 w-full text-[15px]">
							<a href={ctaHref} {...{ "data-goal": "free_started" }}>
								{ctaFreeLabel}
								<ArrowRight data-icon="inline-end" />
							</a>
						</Button>
					) : (
						<Button asChild size="lg" className="h-11 w-full text-[15px]">
							<a
								href={ctaHref ?? price.href}
								rel="nofollow"
								{...(!ctaHref && { "data-goal": "checkout_started", "data-goal-plan": plan.id, "data-goal-interval": period })}
							>
								{ctaLabel}
								<ArrowRight data-icon="inline-end" />
							</a>
						</Button>
					)}
					{children}
				</div>
			</div>
		</div>
	);
}

function ButtonSwitch({ isCurrent, label = "Switch" }) {
	const { pending } = useFormStatus();

	return (
		<Button
			type="submit"
			size="lg"
			variant={isCurrent ? "outline" : "default"}
			disabled={isCurrent || pending}
			className="h-11 w-full text-[15px]"
		>
			{isCurrent ? "Current plan" : label}
			{!isCurrent && (pending ? <Loader2 data-icon="inline-end" className="animate-spin" /> : <ArrowRight data-icon="inline-end" />)}
		</Button>
	);
}

// In % of the width. The range input spans from the first bar's center to the last one's, its thumb (1.75rem)
// overhanging by half at each end, so each stop lands in the middle of a bar.
const BAR_GAP = 4;

const PERIODS = [
	{ value: "month", label: "Monthly" },
	{ value: "year", label: "Yearly" },
];

const INCLUDED = [
	"Campaigns",
	"Scheduling",
	"Website",
	"Your own domain",
	"Signup forms",
	"Welcome emails",
	"Imports",
	"Stats",
	"AI agents and API",
];
