"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL = "__all__";

// The contacts list for one tag, in ?tag=.
export default function FilterTag({ tags }) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const [isPending, startTransition] = useTransition();
	const current = searchParams.get("tag") ?? ALL;

	function choose(value) {
		const params = new URLSearchParams(searchParams);
		if (value === ALL) params.delete("tag");
		else params.set("tag", value);
		params.delete("page");
		startTransition(() => router.replace(`${pathname}${params.size ? `?${params}` : ""}`, { scroll: false }));
	}

	return (
		<Select value={tags.includes(current) ? current : ALL} onValueChange={choose} disabled={isPending}>
			<SelectTrigger className="h-9 w-full sm:w-44" aria-label="Tag">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value={ALL}>All tags</SelectItem>
				{tags.map((tag) => (
					<SelectItem key={tag} value={tag}>
						{tag}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
