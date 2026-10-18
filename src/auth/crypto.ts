import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { type JWTPayload, jwtVerify, SignJWT } from 'jose';

const N = 2 ** 17,
  R = 8,
  P = 1,
  KEYLEN = 32;
/** scrypt needs 128·N·r bytes (128 MiB at these settings); Node's default cap is 32 MiB. */
const MAXMEM = 256 * 1024 * 1024;

/** "scrypt$N$r$p$salt$hash" (base64url parts). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/**
 * Parses a stored hash, or null when it is malformed or needs more memory than MAXMEM. Cost parameters come from the
 * hash, so hashes made with an older, cheaper N keep verifying.
 */
export function parsePasswordHash(stored: string) {
  const [alg, n, r, p, salt, hash] = stored.trim().split('$');
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  const ok =
    alg === 'scrypt' &&
    !!salt &&
    !!hash &&
    Object.values(params).every((v) => Number.isInteger(v) && v > 0) &&
    params.N > 1 &&
    (params.N & (params.N - 1)) === 0 &&
    128 * params.N * params.r * params.p < MAXMEM;
  return ok ? { ...params, salt: Buffer.from(salt, 'base64url'), hash: Buffer.from(hash, 'base64url') } : null;
}

export function verifyPassword(password: string, stored: string): boolean {
  const h = parsePasswordHash(stored);
  if (!h?.hash.length) return false;
  const actual = scryptSync(password.normalize('NFKC'), h.salt, h.hash.length, {
    N: h.N,
    r: h.r,
    p: h.p,
    maxmem: MAXMEM,
  });
  return timingSafeEqual(actual, h.hash);
}

export const pkceS256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
export const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');
export const randomId = (bytes = 16) => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type TokenKind = 'at' | 'rt' | 'code' | 'req' | 'client';

/** HS256 JWTs. The `typ` claim keeps an access token from being replayed as a code, a client id, and so on. */
export class Signer {
  private key: Uint8Array;
  /** `issuer` is an internal claim: tokens are opaque to clients, so it needn't equal the OAuth issuer URL. */
  constructor(
    secret: string,
    private issuer = 'imessage-mcp',
  ) {
    this.key = new TextEncoder().encode(createHmac('sha256', secret).update('jwt').digest('hex'));
  }

  /** Every token expires except client ids (`ttlS: null`), which hold a registration and must outlive restarts. */
  async sign(typ: TokenKind, claims: JWTPayload & Record<string, unknown>, ttlS: number | null): Promise<string> {
    if (ttlS === null ? typ !== 'client' : !(Number.isFinite(ttlS) && ttlS > 0))
      throw new Error(`A ${typ} token needs a positive lifetime in seconds (got ${ttlS}).`);
    const jwt = new SignJWT({ ...claims, typ })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(this.issuer)
      .setIssuedAt();
    if (ttlS !== null) jwt.setExpirationTime(`${Math.ceil(ttlS)}s`);
    return jwt.sign(this.key);
  }

  async verify<T = Record<string, unknown>>(
    typ: TokenKind,
    token: string,
    audience?: string[],
  ): Promise<(JWTPayload & T) | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.issuer,
        algorithms: ['HS256'],
        ...(audience ? { audience } : {}),
      });
      return payload.typ === typ ? (payload as JWTPayload & T) : null;
    } catch {
      return null;
    }
  }
}
