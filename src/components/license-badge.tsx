import type { VideoLicense } from '@/lib/domain/types';
import { Pill } from '@/components/ui/primitives';

/**
 * Reuse rights, shown wherever a publish decision gets made.
 *
 * When mining channels you do not own, this is the field that decides whether a
 * high-scoring clip is something you can act on or something that needs the
 * owner's permission first. A copyright strike is the biggest operational risk a
 * clipper carries, so the signal is surfaced next to the score rather than
 * buried in a detail panel.
 *
 * The tool reports the licence; it does not give legal advice, and standard
 * licence does not mean "never usable" - it means "ask, or rely on a
 * permission you already have".
 */
export function LicenseBadge({ license }: { license: VideoLicense }) {
  if (license === 'creativeCommon') {
    return (
      <Pill
        title="Licensed CC BY by the channel owner: clips may be reused with attribution."
        className="bg-emerald-500/10 text-emerald-300 ring-emerald-500/20"
      >
        CC BY · reusable
      </Pill>
    );
  }

  if (license === 'youtube') {
    return (
      <Pill
        title="Standard YouTube licence. Publishing a clip needs the owner's permission, an official clipping programme, or another basis you have established."
        className="bg-amber-500/10 text-amber-300/90 ring-amber-500/20"
      >
        Standard licence
      </Pill>
    );
  }

  return (
    <Pill title="Licence unknown - the video was not hydrated through the Data API status part.">
      Licence unknown
    </Pill>
  );
}
