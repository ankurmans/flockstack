import NavSub from "@/components/NavSub";

const TABS = [
	{ href: "/forms", label: "Forms", except: ["/forms/popup", "/forms/magic"] },
	{ href: "/forms/popup", label: "Pop-up" },
	{ href: "/forms/magic", label: "Magic Links" },
];

// Where subscribers sign up outside the website's own form: forms for other sites, the website's pop-up, Magic Links.
export default function FormsLayout({ children }) {
	return (
		<>
			<NavSub items={TABS} label="Signup" />
			{children}
		</>
	);
}
