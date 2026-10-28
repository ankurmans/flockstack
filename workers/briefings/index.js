// FlockStack Cloud's optional briefings Worker (docs/BRIEFINGS-DESIGN.md, "Where the engine runs"): every 10 minutes a Cron Trigger
// runs one tick of the engine in lib/briefings, which claims the briefings that are due and the manual runs, and moves each run
// through as many stages as fit. It is built like the readers Worker (scripts/build-briefings-worker.mjs), with no Next.js or React,
// and is bound to its region's database. It writes nothing a dashboard user could write: the draft, the calendar item and the test
// email go through the API Worker's BriefingsDelivery entrypoint (the API binding), so this Worker holds no SES or auth secret.
// Nothing reaches it over HTTP but a health check.
// A Worker module's named exports are entrypoints, so the helpers and the factory live in worker.js.
import { createBriefingsWorker } from "./worker.js";

export default createBriefingsWorker();
