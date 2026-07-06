/**
 * Curated "style preset" chips: a user pick appends a director-voiced note to
 * the director prompt and steers the music (Suno) brief, without touching the
 * underlying footage analysis. Ids are stable and get recorded on experiments
 * (analytics, replays) — never rename an existing id, only add new ones.
 */

export interface StylePreset {
  /** Stable kebab-case id, recorded on experiments. */
  id: string;
  /** Short chip label. */
  label: string;
  /** One-liner for tooltips. */
  tagline: string;
  /** Human-voiced paragraph appended to the director prompt. */
  directorNote: string;
  /** Style words for the music (Suno) brief. */
  musicHint: string;
}

export const STYLE_PRESETS: readonly StylePreset[] = [
  {
    id: "atmospheric",
    label: "Atmospheric",
    tagline: "Mood first — the feeling is the story",
    directorNote:
      "This should feel like a mood you sink into, not a story being told. Let every shot breathe longer than feels safe, keep the quiet moments quiet, and let light and weather do the talking. Nothing needs to happen; it needs to feel.",
    musicHint: "ambient, slow, warm textures, minimal percussion",
  },
  {
    id: "energetic-vlog",
    label: "Energetic vlog",
    tagline: "Fast, personal, momentum — travel-vlog energy",
    directorNote:
      "Cut it like I'm telling my best friend about the best day ever and can't talk fast enough. Quick cuts, jump straight into moments mid-action, keep the energy climbing, and never linger once the point is made. Personality over polish.",
    musicHint: "upbeat, driving beat, feel-good, energetic indie electronic",
  },
  {
    // Names the creator on purpose: the director LLM knows famous editors'
    // styles from training data, and naming one unlocks far more than any
    // paragraph of adjectives could.
    id: "neistat-vlog",
    label: "Neistat style",
    tagline: "Casey Neistat school — relentless momentum, jump cuts, abrupt ends",
    directorNote:
      "Cut this like a Casey Neistat vlog. Cold-open on the most kinetic moment we have, then keep relentless forward momentum: jump cuts that skip the boring middle of everything, time-lapse energy to eat the transitions, and quick asides on small human details that make it personal. Story beats polish — and the second the story is told, end. Abruptly.",
    musicHint: "cool driving NYC-vlog energy, indie rock or electronic, momentum, confident",
  },
  {
    id: "cinematic",
    label: "Cinematic",
    tagline: "Sweeping and composed, like a travel film",
    directorNote:
      "Make it feel like a real travel film: grand establishing moments, deliberate pacing, and a sense of place above all. Favor the widest, most composed views and give arrivals and reveals room to land. It should feel bigger than a holiday video.",
    musicHint: "cinematic orchestral-hybrid, uplifting, swelling builds",
  },
  {
    id: "memory-film",
    label: "Memory film",
    tagline: "Nostalgic, intimate, home-movie warmth",
    directorNote:
      "This is a keepsake, not a production. Favor the imperfect, human moments — laughter, glances, hands, small details — over the impressive ones, and let it feel like flipping through a memory. Soft pacing, warm and a little bittersweet.",
    musicHint: "nostalgic, gentle piano and acoustic guitar, warm, intimate, wistful",
  },
  {
    id: "beat-montage",
    label: "Beat montage",
    tagline: "Cut to the rhythm — the music leads",
    directorNote:
      "The music drives everything: cut on the beat, let the energy of the track decide the pacing, and treat the visuals like verses and choruses — patterns, repetitions, payoffs. No moment should outstay its bar.",
    musicHint: "strong rhythmic pulse, clear beat, builds and drops, punchy",
  },
  {
    id: "observational",
    label: "Observational",
    tagline: "Patient documentary — let scenes play",
    directorNote:
      "Watch, don't perform. Hold on real moments until they finish themselves, keep the order honest, and resist the urge to punch anything up. The interest comes from paying attention, like a quiet documentary.",
    musicHint: "sparse, unobtrusive, textural, documentary underscore",
  },
  {
    id: "hype-reel",
    label: "Hype reel",
    tagline: "Only the peaks, maximum punch",
    directorNote:
      "Best moments only — every shot earns its place or gets cut. Open on the single most exciting thing we have, keep the hits coming rapid-fire, and get out before it can possibly drag. Short, loud, and over too soon.",
    musicHint: "high-energy, bold, big drums, instant impact",
  },
  {
    id: "day-arc",
    label: "Day in the life",
    tagline: "Morning-to-night chronological arc",
    directorNote:
      "Tell it as one day, start to finish: waking light to night, in honest order. Let the natural rhythm of the day set the pace — slower edges, busier middle — and let time passing be the plot.",
    musicHint: "evolving, journey-like, daytime warmth into evening calm",
  },
  {
    id: "visual-poem",
    label: "Visual poem",
    tagline: "Contemplative, thematic, image-led",
    directorNote:
      "Build it around images that rhyme — echoes of color, shape, and gesture — more than around events. Slow, deliberate, and a little abstract; it should invite a second watch. One idea holds it together like a refrain.",
    musicHint: "minimalist, contemplative, strings or piano, spacious",
  },
  {
    id: "social-teaser",
    label: "Social teaser",
    tagline: "Hook-first, made for reels",
    directorNote:
      "Grab attention in the first breath — the most arresting image right up front, no warm-up. Keep it tight and moving, everything trimmed to essentials, and end on a note that makes people want to watch it again. Made to be seen on a phone with the sound on.",
    musicHint: "catchy, punchy hook, modern pop electronic, loopable",
  },
];

const PRESETS_BY_ID = new Map(STYLE_PRESETS.map((preset) => [preset.id, preset]));

export function stylePresetById(id: string | null | undefined): StylePreset | null {
  if (!id) return null;
  return PRESETS_BY_ID.get(id) ?? null;
}
