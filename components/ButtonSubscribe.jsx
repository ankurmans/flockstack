"use client";
import useReaderText from "@/components/useReaderText";

import { useSubscribe } from "@/components/ProviderSubscribe";
import { Button } from "@/components/ui/button";

export default function ButtonSubscribe() {
	const t = useReaderText();
	const { open } = useSubscribe();

	return (
		<Button size="sm" onClick={() => open()} className="h-8 px-3">
			{t("Subscribe")}
		</Button>
	);
}
