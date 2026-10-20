import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import FormSeries from "@/components/FormSeries";
import HeaderPage from "@/components/HeaderPage";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { TIME_ZONE_COOKIE, resolveTimeZone } from "@/lib/time-zone";

export const metadata = { title: "New series" };

export default async function NewSeriesPage() {
	const [{ selected }, cookieStore] = await Promise.all([getSelectedNewsletter(), cookies()]);
	if (!selected) redirect("/series");

	return (
		<>
			<HeaderPage title="New series" backHref="/series" />
			<div className="max-w-3xl">
				<FormSeries newsletterId={String(selected._id)} series={null} defaultTimeZone={resolveTimeZone(cookieStore.get(TIME_ZONE_COOKIE)?.value)} />
			</div>
		</>
	);
}
