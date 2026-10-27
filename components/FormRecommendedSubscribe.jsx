"use client";
import useReaderText from "@/components/useReaderText";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { subscribeToRecommendations } from "@/app/archive/actions";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import TrackRecommendations from "@/components/TrackRecommendations";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// "You might also like", after a signup or a confirmation. Nothing is ticked: a reader's email goes to a newsletter only when
// they tick it and press Subscribe, and that newsletter then sends its own confirmation email.
export default function FormRecommendedSubscribe({ step, className, language }) {
	const t = useReaderText(language);
	const [state, action, isPending] = useActionState(subscribeToRecommendations.bind(null, step.token), null);

	if (state?.ok) {
		const waiting = state.joined.filter(({ isPending }) => isPending).map(({ name }) => name);
		const already = state.joined.filter(({ isPending }) => !isPending).map(({ name }) => name);
		return (
			<div role="status" className={cn("rounded-xl bg-muted/50 p-4 text-left text-sm animate-enter", className)}>
				{waiting.length > 0 && (
					<>
						<p className="font-medium">{t("Check your inbox")}</p>
						<p className="mt-1 text-pretty text-muted-foreground">
							{t("{name} will email you to confirm. You're not subscribed until you click the link.", { name: waiting.join(", ") })}
						</p>
					</>
				)}
				{already.length > 0 && (
					<p className={cn("text-pretty text-muted-foreground", waiting.length > 0 && "mt-2")}>
						{waiting.length === 0 && <span className="font-medium text-foreground">{t("Nothing more to do.")} </span>}
						{t("You're already on the list of {name}.", { name: already.join(", ") })}
					</p>
				)}
			</div>
		);
	}

	return (
		<form action={action} className={cn("text-left", className)}>
			<h2 className="text-base font-semibold tracking-tight">{t("You might also like")}</h2>
			<p className="mt-1 text-sm text-pretty text-muted-foreground">
				{t("Recommended by {name}. Choose what you want; each newsletter asks you to confirm.", { name: step.newsletterName })}
			</p>
			<ul className="mt-3 flex flex-col gap-2">
				{step.recommendations.map((item) => (
					<li key={item.slug}>
						<label className="flex cursor-pointer items-start gap-3 rounded-xl bg-card p-3 shadow-border transition-shadow duration-150 has-[:checked]:shadow-border-hover has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/25">
							<input type="checkbox" name="newsletter" value={item.slug} className="mt-1 size-4 shrink-0 accent-foreground" />
							<AvatarNewsletter newsletter={item} size={32} />
							<span className="min-w-0">
								<span className="block text-sm font-medium">{item.name}</span>
								<span className="mt-0.5 block text-sm text-pretty text-muted-foreground">{item.pitch}</span>
							</span>
						</label>
					</li>
				))}
			</ul>
			<Button type="submit" disabled={isPending} className="mt-3 w-full">
				{isPending ? <Loader2 className="animate-spin" /> : t("Subscribe")}
			</Button>
			{state?.error && (
				<p role="alert" className="mt-2 text-sm text-destructive">
					{t.error(state.error)}
				</p>
			)}
			<TrackRecommendations newsletterSlug={step.newsletter} shown={step.recommendations.map(({ slug }) => slug)} surface="thanks" />
		</form>
	);
}
