// The two things the shared code asks of the server it runs in, which differ between the Next.js app and the lean API Worker
// (workers/api): dropping a cached page, and running work after the response has been sent. Here, in the app, they are
// Next.js's own. The API Worker has no Next.js, so its build replaces this one module with workers/api/runtime-hooks.js, which
// answers the same two calls (scripts/build-api-worker.mjs). Shared code imports them from here, never from next/cache or
// next/server, wherever the API Worker can reach it.
export { revalidatePath } from "next/cache";
export { after } from "next/server";
