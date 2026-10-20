"use client";

import { Check, FlaskConical, Loader2, RefreshCw } from "lucide-react";
import NoteAiUsage from "@/components/NoteAiUsage";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// A few options from the AI for a field, to pick from: subject lines or preview text. "Use" puts one in the field;
// "Test it" (subject lines) adds it to the subject line test. Nothing is used until the writer clicks.
export default function DialogAiSuggest({ isOpen, onOpenChange, title, description, run, items, current, onUse, onTest, onRetry }) {
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				{run.status === "loading" && (
					<div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
						<Loader2 className="size-4 animate-spin" />
						Thinking…
					</div>
				)}
				{run.status === "error" && (
					<p role="alert" className="rounded-lg bg-muted p-3 text-sm text-pretty">
						{run.error}
					</p>
				)}
				{run.status === "done" && (
					<>
						<ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border">
							{items.map((item) => (
								<li key={item} className="flex flex-wrap items-center gap-2 px-3 py-2">
									<span className="min-w-0 flex-1 text-sm text-pretty">{item}</span>
									<span className="flex shrink-0 gap-1">
										{onTest && (
											<Button variant="ghost" size="sm" onClick={() => onTest(item)}>
												<FlaskConical data-icon="inline-start" />
												Test it
											</Button>
										)}
										<Button variant="outline" size="sm" onClick={() => onUse(item)}>
											{item === current ? <Check data-icon="inline-start" /> : null}
											{item === current ? "Used" : "Use"}
										</Button>
									</span>
								</li>
							))}
						</ul>
						<NoteAiUsage usage={run.data.usage} />
					</>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={onRetry} disabled={run.status === "loading"}>
						<RefreshCw data-icon="inline-start" />
						More options
					</Button>
					<Button onClick={() => onOpenChange(false)}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
