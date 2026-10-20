// One request for a sign-in link is one email: a flood from a network, or at one address, stops early. Both count whether or
// not the address is subscribed, so a limit never tells the two apart. The sign-in on an issue (comments) and the one on
// the website share them, so asking in two places is no way round.
export const SIGNIN_PER_IP = { name: "reader-link-ip", limit: 5, window: "10 m" };
export const SIGNIN_PER_ADDRESS = { name: "reader-link-address", limit: 3, window: "1 h" };
export const SIGNIN_SENT_MESSAGE = "If this address is subscribed, a sign-in link is on its way. It works once, for 30 minutes.";
