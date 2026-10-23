"use client";

import Image from "next/image";
import { useState } from "react";
import { faviconUrl } from "@/lib/favicon";
import { cn } from "@/lib/utils";

export default function ImageFavicon({ domain, size = 16, className }) {
	const [failedDomain, setFailedDomain] = useState(null);
	if (!domain) return null;
	const useFallback = failedDomain === domain;
	return (
		<Image
			src={useFallback ? faviconUrl(domain, size > 16 ? 64 : 32) : `https://${domain}/favicon.ico`}
			alt=""
			width={size}
			height={size}
			unoptimized
			loading="lazy"
			referrerPolicy="no-referrer"
			onError={useFallback ? undefined : () => setFailedDomain(domain)}
			className={cn("shrink-0 rounded-[4px]", className)}
		/>
	);
}
