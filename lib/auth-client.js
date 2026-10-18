"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

// Better Auth's browser client, for what only a browser can do: passkeys. Everything else signs in on the server.
export const authClient = createAuthClient({ plugins: [passkeyClient()] });
