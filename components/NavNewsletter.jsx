import FormAddNewsletter from "@/components/FormAddNewsletter";
import MenuNewsletter from "@/components/MenuNewsletter";
import { getSharedDomain } from "@/lib/config";
import { getNewsletterLimit, getNewsletterLimitMessage, toNewsletterOption } from "@/lib/newsletters";
import { findAccountDomains } from "@/lib/sender";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

// The newsletter menu, under the logo in the sidebar and in the phone's top bar.
export default async function NavNewsletter({ isCompact }) {
	const { account, newsletters, selected, savedId } = await getSelectedNewsletter();
	const sharedDomain = getSharedDomain();
	const limit = getNewsletterLimit(account);
	const limitMessage = getNewsletterLimitMessage(account);
	const isAtLimit = limit !== null && newsletters.length >= limit;
	const domains = isAtLimit || sharedDomain ? [] : await findAccountDomains(account._id);

	return (
		<MenuNewsletter
			newsletters={newsletters.map(toNewsletterOption)}
			selectedId={selected ? String(selected._id) : null}
			savedId={savedId}
			isCompact={isCompact}
			canAdd={!isAtLimit}
			limitMessage={limitMessage}
			addForm={
				<FormAddNewsletter
					sharedDomain={sharedDomain}
					domains={domains.map(({ domain }) => domain)}
					startsFrom={selected && (selected.fromName || selected.postalAddress) ? selected.name : null}
					isAtLimit={isAtLimit}
					limitMessage={limitMessage}
				/>
			}
		/>
	);
}
