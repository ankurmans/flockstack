"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getViewer } from "@/app/archive/comment-actions";
import { readerMarkerName } from "@/lib/reader-cookies";

const CommentsContext = createContext(null);

export function useComments() {
	return useContext(CommentsContext);
}

const ANONYMOUS = { signedIn: false };

function hasSessionMarker(slug) {
	try {
		return document.cookie.split("; ").includes(`${readerMarkerName(slug)}=1`);
	} catch {
		return false;
	}
}

// Who is reading, for the parts of the comments that depend on it. The list itself comes from the server and is the same for
// everyone; this asks once, and only when the browser has a session, so a visitor without one costs no request.
// Nothing in it is stored in the browser beyond the session's own cookie.
export default function ProviderComments({ slug, post, restriction = "", children }) {
	const [viewer, setViewer] = useState(ANONYMOUS);
	const [isLoaded, setIsLoaded] = useState(false);
	const [linkProblem, setLinkProblem] = useState(false);

	const refresh = useCallback(async () => {
		if (!hasSessionMarker(slug)) {
			setViewer(ANONYMOUS);
			return;
		}
		try {
			setViewer(await getViewer(slug, post));
		} catch {
			setViewer(ANONYMOUS);
		}
	}, [slug, post]);

	useEffect(() => {
		// A link from an email that no longer works lands here with a hash that says so.
		const isExpired = window.location.hash === "#comments-expired";
		if (isExpired) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#comments`);
		let isCurrent = true;
		(hasSessionMarker(slug) ? getViewer(slug, post).catch(() => ANONYMOUS) : Promise.resolve(ANONYMOUS)).then((found) => {
			if (!isCurrent) return;
			setViewer(found);
			setLinkProblem(isExpired);
			setIsLoaded(true);
		});
		return () => {
			isCurrent = false;
		};
	}, [slug, post]);

	const value = useMemo(() => ({ slug, post, restriction, viewer, isLoaded, linkProblem, refresh }), [slug, post, restriction, viewer, isLoaded, linkProblem, refresh]);
	return <CommentsContext value={value}>{children}</CommentsContext>;
}
