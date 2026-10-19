import { startTransition } from "react";

// React resets a form once its action returns, even when the action answers with an error, so a refused price or title
// would empty what was typed. As the form's onSubmit, this runs useActionState's action itself, in a transition: its
// pending state works the same, and React leaves the fields alone.
export function submitKeepingFields(action) {
	return (event) => {
		event.preventDefault();
		const formData = new FormData(event.currentTarget, event.nativeEvent?.submitter);
		startTransition(() => action(formData));
	};
}
