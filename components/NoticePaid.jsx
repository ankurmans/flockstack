"use client";
import useReaderText from "@/components/useReaderText";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Check } from "lucide-react";

// Where Stripe sends a buyer back to after paying (?paid=1). The page itself stays cached; this reads the address in the
// browser.
function NoticeFromAddress({ param, children }) {
	const t = useReaderText();
	const isShown = useSearchParams().get(param) === "1";
	if (!isShown) return null;
	return (
		<p role="status" className="mb-8 flex items-start gap-3 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-950 ring-1 ring-emerald-500/30 animate-enter dark:bg-emerald-500/10 dark:text-emerald-50">
			<span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-emerald-500 text-white">
				<Check className="size-3" />
			</span>
			<span>{typeof children === "string" ? t(children) : children}</span>
		</p>
	);
}

// param: the address's flag, ?paid=1 for a purchase, ?pledged=1 for a pledge, ?gift=1 for a gift.
export default function NoticePaid({ param = "paid", children }) {
	return (
		<Suspense fallback={null}>
			<NoticeFromAddress param={param}>{children}</NoticeFromAddress>
		</Suspense>
	);
}
