"use client";

import { useSupporterBadges } from "@/components/ProviderSupporterBadges";
import useReaderText from "@/components/useReaderText";

export default function BadgeSupporter({ commentId }) {
	const badges = useSupporterBadges();
	const t = useReaderText();
	return badges?.has(commentId) ? <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground" title={t("Founding member")}>{t("Supporter")}</span> : null;
}
