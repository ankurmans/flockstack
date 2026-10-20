import NavSub from "@/components/NavSub";

const TABS = [
	{ href: "/reports", label: "Growth", except: ["/reports/issues", "/reports/site"] },
	{ href: "/reports/issues", label: "Issues" },
	{ href: "/reports/site", label: "Website" },
];

export default function ReportsLayout({ children }) {
	return (
		<>
			<NavSub items={TABS} label="Reports" />
			{children}
		</>
	);
}
