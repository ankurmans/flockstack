"use client";

import { useEffect } from "react";
import { useSubscribe } from "@/components/ProviderSubscribe";
import { armPopup } from "@/lib/popup-trigger";

// Opens the signup pop-up the way the newsletter chose (lib/popup-trigger.js).
export default function TriggerSubscribe({ newsletterSlug, trigger, seconds, scrollPercent, frequencyDays }) {
	const { open } = useSubscribe();

	useEffect(
		() => armPopup({ slug: newsletterSlug, trigger, seconds, scrollPercent, frequencyDays, open }),
		[newsletterSlug, trigger, seconds, scrollPercent, frequencyDays, open]
	);

	return null;
}
