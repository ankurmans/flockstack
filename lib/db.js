import { getDriver } from "@/lib/docdb/driver";

// D1 on Cloudflare, SQLite (FLOCKSTACK_SQLITE) locally: see lib/docdb/driver.js.
export async function connectDb() {
	return getDriver();
}
