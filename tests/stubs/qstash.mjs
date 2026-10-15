// Jobs are kept here instead of going to QStash; tests run them by calling the job's code.
export const published = [];

export class Client {
	async batchJSON(requests) {
		published.push(...requests);
		return requests.map((_, index) => ({ messageId: `msg-${published.length + index}` }));
	}

	async publishJSON(request) {
		published.push(request);
		return { messageId: `msg-${published.length}` };
	}
}
