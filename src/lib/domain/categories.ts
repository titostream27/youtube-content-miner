/**
 * PRD Step 9 - Clip categories.
 *
 * The list is fixed and ordered. Every clip is assigned exactly one primary
 * category so the clip library can be filtered by content vertical.
 */
export const CLIP_CATEGORIES = [
  'Business',
  'Finance',
  'Marketing',
  'Startup',
  'Motivation',
  'Funny',
  'Story',
  'Psychology',
  'Mindset',
  'Leadership',
  'Health',
  'Productivity',
  'Controversial',
  'Educational',
  'News',
  'Inspirational',
] as const;

export type ClipCategory = (typeof CLIP_CATEGORIES)[number];

export const DEFAULT_CATEGORY: ClipCategory = 'Educational';

export function isClipCategory(value: string): value is ClipCategory {
  return (CLIP_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Coerce arbitrary model output into a valid category. LLMs frequently return
 * near-misses ("business", "Business & Finance", "funny//humor"), so we
 * normalise before falling back.
 */
export function coerceCategory(value: string | null | undefined): ClipCategory {
  if (!value) return DEFAULT_CATEGORY;

  const cleaned = value.trim().toLowerCase();
  const exact = CLIP_CATEGORIES.find((category) => category.toLowerCase() === cleaned);
  if (exact) return exact;

  const partial = CLIP_CATEGORIES.find(
    (category) =>
      cleaned.includes(category.toLowerCase()) || category.toLowerCase().includes(cleaned),
  );
  if (partial) return partial;

  const synonyms: Record<string, ClipCategory> = {
    humor: 'Funny',
    comedy: 'Funny',
    joke: 'Funny',
    money: 'Finance',
    investing: 'Finance',
    invest: 'Finance',
    economics: 'Finance',
    entrepreneurship: 'Startup',
    founder: 'Startup',
    saas: 'Startup',
    growth: 'Marketing',
    sales: 'Marketing',
    branding: 'Marketing',
    advertising: 'Marketing',
    mentalhealth: 'Health',
    fitness: 'Health',
    nutrition: 'Health',
    wellness: 'Health',
    mindfulness: 'Mindset',
    discipline: 'Mindset',
    habits: 'Productivity',
    workflow: 'Productivity',
    efficiency: 'Productivity',
    management: 'Leadership',
    hiring: 'Leadership',
    team: 'Leadership',
    anecdote: 'Story',
    narrative: 'Story',
    lesson: 'Educational',
    teaching: 'Educational',
    tutorial: 'Educational',
    howto: 'Educational',
    debate: 'Controversial',
    hottake: 'Controversial',
    opinion: 'Controversial',
    behaviour: 'Psychology',
    behavior: 'Psychology',
    brain: 'Psychology',
    neuroscience: 'Psychology',
    current: 'News',
    politics: 'News',
    inspire: 'Inspirational',
    inspiring: 'Inspirational',
    motivational: 'Motivation',
  };

  const key = cleaned.replace(/[^a-z]/g, '');
  return synonyms[key] ?? DEFAULT_CATEGORY;
}
