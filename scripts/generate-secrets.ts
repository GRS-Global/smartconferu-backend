/**
 * Prints fresh values for the API's secrets, ready to paste into .env or a secret manager:
 *   npm run secrets:generate
 * Use different values for every environment, and never commit them.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

console.log(`JWT_PRIVATE_KEY=${Buffer.from(pem).toString('base64')}`);
console.log(`JWT_KEY_ID=key-${new Date().toISOString().slice(0, 10)}`);
console.log(`TOKEN_HASH_SECRET=${randomBytes(32).toString('base64url')}`);
console.log(`MFA_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
