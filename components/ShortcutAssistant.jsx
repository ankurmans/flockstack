"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ShortcutAssistant() {
	const router = useRouter();
	useEffect(() => {
		const open = (event) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j" && !event.altKey && !event.shiftKey) { event.preventDefault(); router.push("/assistant"); }
		};
		document.addEventListener("keydown", open);
		return () => document.removeEventListener("keydown", open);
	}, [router]);
	return null;
}
