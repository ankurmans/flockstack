// Node route tests exercise the API entrypoint; native object/socket tests use the actual Workers runtime.
export class WorkerEntrypoint {
	constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
