import "server-only";
import { PRESETS, getActionClass, isGateable, isPresetAllowed } from "@/lib/action-scopes";
import { getPathParams } from "@/lib/actions/define-action";
import { ERRORS } from "@/lib/actions/errors";
import { ACTIONS, ACTION_GROUPS } from "@/lib/actions/registry";
import { API_BASE_PATH } from "@/lib/api/rest";
import { GROUP_DESCRIPTIONS, toJsonSchema } from "@/lib/docs/reference";

const ERROR_RESPONSE = { $ref: "#/components/responses/Error" };

function toOperation(action) {
	const input = toJsonSchema(action.input, "input");
	const pathParams = getPathParams(action.http.path);
	const required = new Set(input.required ?? []);
	const fields = Object.entries(input.properties ?? {}).filter(([name]) => !pathParams.includes(name));
	const isQuery = ["GET", "DELETE"].includes(action.http.method);
	const output = { "application/json": { schema: toJsonSchema(action.output, "output") } };
	const statuses = typeof action.http.status === "function" ? [200, 201] : [action.http.status];

	return {
		operationId: action.name,
		summary: action.title,
		description: action.description,
		tags: [action.group],
		"x-mcp-tool": action.name,
		"x-key-levels": PRESETS.filter((preset) => isPresetAllowed(preset, action, {})),
		"x-scope-class": getActionClass(action.name, {}),
		"x-mcp-annotations": {
			readOnlyHint: action.readOnly,
			destructiveHint: action.destructive,
			idempotentHint: action.idempotent,
			openWorldHint: action.openWorld,
		},
		parameters: [
			...pathParams.map((name) => ({
				name,
				in: "path",
				required: true,
				description: input.properties[name]?.description,
				schema: input.properties[name],
			})),
			...(isQuery
				? fields.map(([name, schema]) => ({ name, in: "query", required: required.has(name), description: schema.description, schema }))
				: []),
		],
		...(!isQuery &&
			fields.length > 0 && {
				requestBody: {
					required: fields.some(([name]) => required.has(name)),
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: Object.fromEntries(fields),
								required: fields.map(([name]) => name).filter((name) => required.has(name)),
							},
							...(Object.keys(action.example).length > 0 && { example: action.example }),
						},
					},
				},
			}),
		responses: {
			...Object.fromEntries(statuses.map((status) => [status, { description: status === 201 ? "Created" : "OK", content: output }])),
			...(isGateable(action.name) && { 202: { $ref: "#/components/responses/ApprovalRequired" } }),
			default: ERROR_RESPONSE,
		},
	};
}

// OpenAPI 3.1 from the actions' zod schemas: JSON Schema 2020-12, which 3.1 uses as is.
export function getOpenApiDocument(appUrl) {
	const paths = {};
	for (const action of ACTIONS) {
		paths[action.http.path] ??= {};
		paths[action.http.path][action.http.method.toLowerCase()] = toOperation(action);
	}
	return {
		openapi: "3.1.0",
		info: {
			title: "FlockStack API",
			version: "1.0.0",
			description:
				"Everything a FlockStack customer does in the dashboard, over HTTP. Each operation is also a tool of the MCP server at /mcp, named after its operationId. Errors answer { error: { code, message } }.",
		},
		servers: [{ url: `${appUrl}${API_BASE_PATH}` }],
		security: [{ apiKey: [] }],
		tags: ACTION_GROUPS.map((name) => ({ name, description: GROUP_DESCRIPTIONS[name] })),
		paths,
		components: {
			securitySchemes: {
				apiKey: {
					type: "http",
					scheme: "bearer",
					description: "An API key from the dashboard's API keys page: Authorization: Bearer mc_… (mc_eu_… for an account in the European Union, whose API is at its own address). Keys only work in their own region.",
				},
			},
			schemas: {
				ApprovalRequired: {
					type: "object",
					description: "The action did not run: it waits for the account owner to approve it. Poll statusUrl (get_approval_status) every retryAfter seconds, or wait for the approval.decided webhook.",
					properties: {
						status: { type: "string", enum: ["approval_required"] },
						approvalId: { type: "string" },
						action: { type: "string" },
						summary: { type: "string" },
						statusUrl: { type: "string" },
						retryAfter: { type: "integer" },
						expiresAt: { type: "string" },
						message: { type: "string" },
					},
					required: ["status", "approvalId", "action", "summary", "statusUrl", "retryAfter", "expiresAt", "message"],
				},
				Error: {
					type: "object",
					properties: {
						error: {
							type: "object",
							properties: {
								code: { type: "string", enum: Object.keys(ERRORS) },
								message: { type: "string" },
							},
							required: ["code", "message"],
						},
					},
					required: ["error"],
				},
			},
			responses: {
				ApprovalRequired: {
					description: "202 Accepted: the action waits for the account owner's approval and has not run.",
					headers: { "Retry-After": { description: "Seconds to wait before asking again", schema: { type: "integer" } } },
					content: { "application/json": { schema: { $ref: "#/components/schemas/ApprovalRequired" } } },
				},
				Error: {
					description: Object.entries(ERRORS)
						.map(([code, { status, description }]) => `${status} ${code}: ${description}`)
						.join("\n"),
					content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
				},
			},
		},
	};
}
