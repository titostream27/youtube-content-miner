import { NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Shared HTTP helpers.
 *
 * Every route returns the same envelope so the client never has to guess
 * whether it received data or an error, and validation failures come back as
 * field-level detail rather than a stack trace.
 */

export interface ApiErrorBody {
  error: string;
  details?: unknown;
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, init);
}

export function badRequest(error: string, details?: unknown): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error, details }, { status: 400 });
}

export function notFound(error = 'Not found'): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error }, { status: 404 });
}

export function serverError(error: unknown): NextResponse<ApiErrorBody> {
  const message = error instanceof Error ? error.message : 'Unexpected server error';
  // Server-side log: the client gets the message, the operator gets the stack.
  console.error('[api]', error);
  return NextResponse.json({ error: message }, { status: 500 });
}

/** Parse and validate a JSON body. */
export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<{ data: z.infer<S>; error: null } | { data: null; error: NextResponse<ApiErrorBody> }> {
  let raw: unknown;

  try {
    raw = await request.json();
  } catch {
    return { data: null, error: badRequest('Request body must be valid JSON') };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      data: null,
      error: badRequest('Invalid request body', z.treeifyError(result.error)),
    };
  }

  return { data: result.data, error: null };
}

/** Parse and validate search params. */
export function parseSearchParams<S extends z.ZodType>(
  url: string,
  schema: S,
): { data: z.infer<S>; error: null } | { data: null; error: NextResponse<ApiErrorBody> } {
  const params = new URL(url).searchParams;
  const raw: Record<string, string | string[]> = {};

  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    raw[key] = values.length > 1 ? values : values[0]!;
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      data: null,
      error: badRequest('Invalid query parameters', z.treeifyError(result.error)),
    };
  }

  return { data: result.data, error: null };
}

/**
 * Accept both repeated params (`?tier=a&tier=b`) and comma-separated lists
 * (`?tier=a,b`), which is what a URL built by the filter UI produces.
 */
export function csvList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = Array.isArray(value) ? value : value.split(',');
  const cleaned = parts.map((part) => part.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}
