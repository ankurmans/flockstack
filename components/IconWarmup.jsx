import { Flame } from "lucide-react";
import { cn } from "@/lib/utils";

// Next to every mention of the account's warm-up (lib/send-spread.js), in the dashboard and on the site.
export default function IconWarmup({ className, ...props }) {
	return <Flame aria-hidden="true" className={cn("size-4 shrink-0", className)} {...props} />;
}
