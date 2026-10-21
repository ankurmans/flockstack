// react in the lean API Worker: only cache() is imported by the shared code (lib/auth.js's per-request memo), and a memo
// that is never read here can be the function itself.
export const cache = (fn) => fn;
const react = { cache };
export default react;
