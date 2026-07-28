import { z } from 'zod';
import {
  clearTranscriptVendor,
  describeTranscriptVendor,
  saveTranscriptVendor,
} from '@/lib/settings/transcript-vendor';
import { TRANSCRIPT_VENDORS } from '@/lib/transcript/vendors';
import { badRequest, ok, parseJsonBody, serverError } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

const saveSchema = z.object({
  vendorId: z.enum(['supadata', 'custom']),
  /** Omit to keep the stored key; empty string clears it. */
  apiKey: z.string().max(400).optional(),
  urlTemplate: z.string().max(500).optional(),
  authHeader: z.string().max(120).optional(),
  authScheme: z.string().max(60).optional(),
  timeUnit: z.enum(['ms', 's']).optional(),
  pollUrlTemplate: z.string().max(500).optional(),
});

/**
 * GET /api/settings/transcript
 *
 * Vendor catalogue plus current status. Never returns the API key - not even a
 * masked suffix, since that is still credential material and tells the operator
 * nothing they do not already know.
 */
export function GET() {
  try {
    return ok({
      status: describeTranscriptVendor(),
      vendors: TRANSCRIPT_VENDORS.map((vendor) => ({
        id: vendor.id,
        label: vendor.label,
        docsUrl: vendor.docsUrl,
        verified: vendor.verified,
        freeTierNote: vendor.freeTierNote,
        notes: vendor.notes,
        urlTemplate: vendor.request.urlTemplate,
        authHeader: vendor.request.authHeader,
        authScheme: vendor.request.authScheme,
        timeUnit: vendor.response.timeUnit,
        asynchronous: Boolean(vendor.response.asyncJob),
      })),
    });
  } catch (error) {
    return serverError(error);
  }
}

/** PUT /api/settings/transcript - select a vendor and store its credential. */
export async function PUT(request: Request) {
  const { data, error } = await parseJsonBody(request, saveSchema);
  if (error) return error;

  try {
    const current = describeTranscriptVendor();
    if (current.managedByEnvironment) {
      return badRequest(
        'Transcript credentials are pinned by TRANSCRIPT_API_URL in the environment. ' +
          'Unset it to manage the vendor from the UI.',
      );
    }

    // A custom vendor is useless without an endpoint, so fail loudly rather than
    // storing a half-configured provider that silently never runs.
    if (data.vendorId === 'custom' && !data.urlTemplate?.trim()) {
      return badRequest('A custom vendor needs a request URL template.');
    }

    saveTranscriptVendor(data);
    return ok({ status: describeTranscriptVendor() });
  } catch (error) {
    return serverError(error);
  }
}

/** DELETE /api/settings/transcript - forget the stored vendor and key. */
export function DELETE() {
  try {
    if (describeTranscriptVendor().managedByEnvironment) {
      return badRequest('Credentials are pinned by the environment and cannot be cleared here.');
    }

    clearTranscriptVendor();
    return ok({ status: describeTranscriptVendor() });
  } catch (error) {
    return serverError(error);
  }
}
