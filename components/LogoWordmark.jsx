import Link from "next/link";
import LogoFlockstack from "@/components/LogoFlockstack";
import { cn } from "@/lib/utils";

export default function LogoWordmark({ href, className, children }) {
	const Wordmark = href ? Link : "span";

	return (
		<Wordmark href={href} className={cn("flex items-center gap-2", className)}>
			<LogoFlockstack />
			<span className="text-[17px] font-semibold tracking-tight">FlockStack</span>
			{children}
		</Wordmark>
	);
}
