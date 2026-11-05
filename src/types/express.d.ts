import type { AuthUser } from '../core/auth/auth-user.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by JwtAuthGuard on every non-public route. */
    user?: AuthUser;
  }
}
