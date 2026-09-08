/**
 * GitHub opaque code shape — shared by the OAuth authorization-code exchange
 * and the App manifest conversion flow. Both codes are URL-safe opaque
 * tokens; one constant so the callback ENTRY gates and the in-function
 * gates can never drift apart.
 */
export const GITHUB_CODE_SHAPE = /^[A-Za-z0-9._~-]{1,256}$/;
