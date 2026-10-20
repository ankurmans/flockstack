"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

const SelectionContext = createContext(null);

// Which campaigns of the list are ticked, with each one's status (the bar says which actions apply). The list is a server
// component; its checkboxes and the bar share this.
export default function ProviderCampaignSelection({ children }) {
	const [selected, setSelected] = useState(() => new Map());

	const toggle = useCallback((id, status) => {
		setSelected((current) => {
			const next = new Map(current);
			if (next.has(id)) next.delete(id);
			else next.set(id, status);
			return next;
		});
	}, []);
	const setMany = useCallback((entries, isOn) => setSelected(isOn ? new Map(entries) : new Map()), []);
	const clear = useCallback(() => setSelected(new Map()), []);
	const value = useMemo(() => ({ selected, toggle, setMany, clear }), [selected, toggle, setMany, clear]);

	return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useCampaignSelection() {
	return useContext(SelectionContext);
}
