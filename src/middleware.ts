import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optional HTTP Basic authentication.
 *
 * The application is built for a single operator, and the intended deployment
 * puts it behind a reverse proxy that already handles access control. This is
 * defence in depth rather than the primary gate: several routes are genuinely
 * dangerous to expose - `POST /api/runs` spends AI credits and YouTube quota, and
 * `PUT /api/settings/transcript` writes a vendor API key - so a single
 * misconfigured proxy rule should not be the only thing standing in front of
 * them.
 *
 * Basic auth specifically, rather than a login page and session cookies, because
 * it needs no UI, works unchanged for `curl` and cron, and adds no state to
 * protect. For one operator that is the right amount of machinery.
 *
 * Entirely inert unless both APP_BASIC_AUTH_USER and APP_BASIC_AUTH_PASSWORD are
 * set, so local development is unaffected.
 */

/**
 * Length-independent comparison.
 *
 * `node:crypto.timingSafeEqual` is not available in the middleware runtime, so
 * this compares every character and folds the length difference into the result
 * instead of returning early on the first mismatch.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;

  for (let i = 0; i < length; i += 1) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }

  return difference === 0;
}

function unauthorized(): NextResponse {
  return new NextResponse('Authentication required', {
    status: 401,
    headers: {
      'www-authenticate': 'Basic realm="Podcast Producer", charset="UTF-8"',
      'cache-control': 'no-store',
    },
  });
}

export function middleware(request: NextRequest): NextResponse {
  const user = process.env.APP_BASIC_AUTH_USER;
  const password = process.env.APP_BASIC_AUTH_PASSWORD;

  // Not configured: behave exactly as if this file did not exist.
  if (!user || !password) return NextResponse.next();

  /*
   * The container healthcheck calls this endpoint from inside the network
   * namespace and cannot carry credentials. It exposes only provider names and
   * library counts - no secrets and no write access - so exempting it is a
   * reasonable trade for a working healthcheck.
   */
  if (request.nextUrl.pathname === '/api/health') return NextResponse.next();

  const header = request.headers.get('authorization');
  if (!header?.startsWith('Basic ')) return unauthorized();

  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return unauthorized();
  }

  // Only the first colon separates the two fields; passwords may contain more.
  const separator = decoded.indexOf(':');
  if (separator === -1) return unauthorized();

  const providedUser = decoded.slice(0, separator);
  const providedPassword = decoded.slice(separator + 1);

  // Both comparisons always run, so a valid username does not resolve faster
  // than an invalid one.
  const userMatches = constantTimeEquals(providedUser, user);
  const passwordMatches = constantTimeEquals(providedPassword, password);

  return userMatches && passwordMatches ? NextResponse.next() : unauthorized();
}

export const config = {
  // Static assets are excluded so the browser can still render the 401 page and
  // so asset requests do not each trigger a credential check.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
