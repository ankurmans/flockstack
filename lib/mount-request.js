import "server-only";
import { headers } from "next/headers";
import { MOUNT_PATH_HEADER } from "@/lib/mount-rules";

// The mount path of the request being answered, which proxy.js sets only once the owner's proxy sent the right token
// (lib/mount-rules.js), or null when the request reached FlockStack directly.
export async function getRequestMountPath() {
	return (await headers()).get(MOUNT_PATH_HEADER) || null;
}

// A reader's cookies belong to the site the reader sees: under a mount, host-only on the owner's site and only below the mount
// path, so the rest of that site never gets them.
export async function getReaderCookiePath() {
	return (await getRequestMountPath()) ?? "/";
}
