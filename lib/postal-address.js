// The postal address a newsletter's emails print: its own, else defaultAddress, the server's (lib/site-extensions.js:
// MailCheap Cloud's business address, none on a self-hosted server), unless its owner saved it empty. Newsletters
// saved before there was a default store "" without anyone clearing it, so only postalAddressCleared says they did.
export function getPostalAddress(newsletter, defaultAddress) {
	const address = String(newsletter?.postalAddress ?? "").trim();
	if (address || newsletter?.postalAddressCleared) return address;
	return defaultAddress ?? "";
}

// What saving an address stores. The default's own text keeps the newsletter on the default, which then follows it,
// and an empty one clears it: sending waits for an address.
export function toPostalAddressFields(address, defaultAddress) {
	const text = String(address ?? "").trim();
	return { postalAddress: defaultAddress && text === defaultAddress ? "" : text, postalAddressCleared: !text };
}
