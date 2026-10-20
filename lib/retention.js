// How long FlockStack keeps what it promises to keep. In a module of its own, with no imports, so the legal pages and the
// sign-in page read these numbers without loading the database, sign-in and email code that the modules using them need.

// How long a deleted account can be restored by signing in. Then lib/account-purge.js deletes its data for good.
export const DELETION_GRACE_DAYS = 30;

// How long an account export's download links work (lib/account-export-files.js). The files are deleted with them.
export const EXPORT_LINK_DAYS = 7;
