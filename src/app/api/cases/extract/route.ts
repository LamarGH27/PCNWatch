import { NextResponse } from 'next/server';
import { extractNotice } from '@/server/cases/extraction';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { logError } from '@/lib/errors';
import { rateLimit } from '@/server/rate-limit';

/**
 * Document extraction endpoint.
 *
 * Validation happens here, not only in the browser: content type and size are
 * checked server-side because a client check is a convenience, not a control.
 */

const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_BYTES = 12 * 1024 * 1024;

export async function POST(request: Request) {
  // Extraction is the most expensive thing an anonymous caller can trigger.
  const limited = await rateLimit(request, { key: 'extract', limit: 10, windowSeconds: 300 });
  if (!limited.allowed) {
    return NextResponse.json(
      {
        kind: 'FAILED',
        what: 'You have uploaded several notices in a short time.',
        whatYouCanDo: `Nothing was lost. Wait ${limited.retryAfterSeconds} seconds and try again.`,
        dataSaved: false,
      },
      { status: 429, headers: { 'retry-after': String(limited.retryAfterSeconds) } },
    );
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const candidate = form.get('file');
    if (candidate instanceof File) file = candidate;
  } catch (error) {
    logError('api.cases.extract.form', error);
  }

  if (!file) {
    return NextResponse.json(
      {
        kind: 'FAILED',
        what: 'No file reached us.',
        whatYouCanDo: 'Nothing was saved. Try the upload again.',
        dataSaved: false,
      },
      { status: 400 },
    );
  }

  if (!ACCEPTED.has(file.type)) {
    return NextResponse.json(
      {
        kind: 'FAILED',
        what: `We cannot read files of type "${file.type || 'unknown'}".`,
        whatYouCanDo: 'Nothing was saved. Upload a JPG, PNG or PDF.',
        dataSaved: false,
      },
      { status: 415 },
    );
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        kind: 'FAILED',
        what: 'That file is larger than we accept.',
        whatYouCanDo: 'Nothing was saved. Take the photo again at a lower resolution.',
        dataSaved: false,
      },
      { status: 413 },
    );
  }

  try {
    // The signed-in user, when there is one. Extraction works anonymously too;
    // saving a case is what requires an account.
    const supabase = await createSupabaseServerClient();
    const userId = supabase ? (await supabase.auth.getUser()).data.user?.id : undefined;

    const buffer = Buffer.from(await file.arrayBuffer());
    const outcome = await extractNotice({
      data: buffer.toString('base64'),
      mediaType: file.type as 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf',
      userId,
    });

    return NextResponse.json(outcome);
  } catch (error) {
    const correlationId = logError('api.cases.extract', error);
    return NextResponse.json(
      {
        kind: 'FAILED',
        what: 'Something went wrong while reading your notice.',
        whatYouCanDo:
          'Nothing was saved. You can try again, or enter the details from your notice by hand.',
        dataSaved: false,
        correlationId,
      },
      { status: 500 },
    );
  }
}
