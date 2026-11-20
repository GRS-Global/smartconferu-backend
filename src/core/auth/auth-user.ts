/** The signed-in user behind a request, taken from a verified access token. */
export interface AuthUser {
  id: string;
  /** The session family the access token was issued for (one per sign-in, kept across refreshes). */
  sessionId: string;
  /** The session passed a second factor (authenticator app). */
  mfa: boolean;
  /**
   * A Super Admin's read-only support view ("View as"): the admin's id. Every change is refused
   * (SupportViewGuard) and the token can't be refreshed.
   */
  supportViewBy?: string;
}
