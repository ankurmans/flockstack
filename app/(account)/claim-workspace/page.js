import FormClaimWorkspace from "@/components/FormClaimWorkspace";
import HeaderPage from "@/components/HeaderPage";
export const metadata = { title: "Claim a workspace" };
export const dynamic = "force-dynamic";
export default async function ClaimPage({ searchParams }) {
	const { id = "" } = await searchParams;
	return <><HeaderPage title="Claim a workspace" /><FormClaimWorkspace id={String(id).slice(0, 100)} /></>;
}
