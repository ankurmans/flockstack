import { Children, isValidElement } from "react";
import * as React from "react";

// A client component's first render as React elements, without a DOM: its hooks answer from a stand-in dispatcher, so
// a form's props (onSubmit) can be called as a browser would. useActionState hands back a dispatch that records what it
// gets, and keeps the action, so a test can run it. Function components named in `expand` render in place too.
const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

export function renderShallow(element, { expand = [] } = {}) {
	const dispatched = [];
	const actions = [];
	const dispatcher = {
		readContext: (context) => context._currentValue,
		use: (usable) => (usable && "_currentValue" in usable ? usable._currentValue : usable),
		useContext: (context) => context._currentValue,
		useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
		useReducer: (_reducer, initial, init) => [init ? init(initial) : initial, () => {}],
		useActionState: (action, initial) => {
			actions.push(action);
			return [initial, (payload) => dispatched.push(payload), false];
		},
		useOptimistic: (value) => [value, () => {}],
		useEffect() {},
		useLayoutEffect() {},
		useInsertionEffect() {},
		useImperativeHandle() {},
		useDebugValue() {},
		useRef: (current) => ({ current }),
		useMemo: (create) => create(),
		useCallback: (callback) => callback,
		useId: () => ":r0:",
		useTransition: () => [false, (callback) => callback()],
		useDeferredValue: (value) => value,
		useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
	};

	function render(node) {
		if (Array.isArray(node)) return node.map(render);
		if (!isValidElement(node)) return node;
		if (typeof node.type === "function" && expand.includes(node.type.name)) return render(node.type(node.props));
		if (node.props?.children === undefined) return node;
		return { ...node, props: { ...node.props, children: Children.toArray(node.props.children).map(render) } };
	}

	const previous = internals.H;
	internals.H = dispatcher;
	try {
		return { tree: render(element.type(element.props)), dispatched, actions };
	} finally {
		internals.H = previous;
	}
}

// Every element of a rendered tree of this type ("form", "input"), depth first.
export function findAll(tree, type) {
	const found = [];
	const visit = (node) => {
		if (Array.isArray(node)) return node.forEach(visit);
		if (!isValidElement(node) && !(node && typeof node === "object" && node.props)) return;
		if (node.type === type) found.push(node);
		Children.forEach(node.props?.children, visit);
	};
	visit(tree);
	return found;
}

// Submits a rendered form as a browser does: its onSubmit gets the event, with the fields the person typed. Node's
// FormData can't read a form element, so it reads these fields for the time of the call. Returns whether the event's
// default (the browser's submit, and React's reset of the form after its action) was prevented.
export function submit(form, fields, { submitter = null } = {}) {
	const RealFormData = globalThis.FormData;
	let isPrevented = false;
	const target = { fields };
	globalThis.FormData = class extends RealFormData {
		constructor(element, by) {
			super();
			if (element !== target) throw new Error("FormData read another form");
			for (const [name, value] of Object.entries(element.fields)) this.append(name, value);
			if (by?.name) this.append(by.name, by.value ?? "");
		}
	};
	try {
		form.props.onSubmit?.({ preventDefault: () => (isPrevented = true), currentTarget: target, target, nativeEvent: { submitter } });
	} finally {
		globalThis.FormData = RealFormData;
	}
	return isPrevented;
}
