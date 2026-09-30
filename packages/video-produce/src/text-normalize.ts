/*
 * Multilingual lexical normalization for retrieval: NFKC, lowercase, strip
 * combining marks, segment with Intl.Segmenter, drop stopwords, and map known
 * synonyms/translations onto one canonical English concept. The table is
 * versioned because changing it changes rankings and proposal ids.
 */

export const TEXT_NORMALIZER_VERSION = "text-normalize/1";

const STOPWORDS: ReadonlySet<string> = new Set(
  [
    // en
    "a an and are as at be by for from has have in is it its of on or that the this to was were",
    "with we our you your they their there into over then than so",
    // es
    "el la los las un una unos unas y o de del al en con por para que se su sus es son lo como mas",
    // fr
    "le les une des et ou du au aux dans sur avec pour est sont ce cette qui",
    // de
    "der die das ein eine einen und oder im ist sind mit von zu den dem des auf fur uber",
    // pt
    "o os as um uma e do da dos das no na nos nas em com sao",
  ].flatMap((line) => line.split(" ")),
);

/** Canonical English concept -> normalized surface forms (no diacritics). */
const CONCEPTS: Readonly<Record<string, string>> = {
  river: "rio rios fluss flusse riviere fleuve rivers stream",
  mountain: "montana montanas berg berge montagne montanha mountains",
  city: "ciudad stadt ville cidade cities",
  forest: "bosque wald foret floresta forests",
  ocean: "oceano mar meer ozean mer sea",
  water: "agua wasser eau",
  boat: "barco boot bateau boats",
  kayak: "kayaks kajak",
  bridge: "puente brucke pont ponte bridges",
  canyon: "canon canones schlucht canyons",
  snow: "nieve schnee neige neve",
  people: "gente personas menschen leute crowd multitud menge",
  sunset: "atardecer sonnenuntergang sunsets",
  bird: "pajaro pajaros vogel oiseau birds",
  microphone: "microfono mikrofon mic",
  studio: "estudio",
  dam: "presa damm staudamm dams",
  desert: "desierto wuste",
};

const SYNONYMS: ReadonlyMap<string, string> = new Map(
  Object.entries(CONCEPTS).flatMap(([concept, forms]) =>
    forms.split(" ").map((form): [string, string] => [form, concept]),
  ),
);

export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .normalize("NFC");
}

/** Word tokens, stopword-free, mapped to canonical concepts, sorted and unique. */
export function normalizeTokens(text: string, language = "und"): string[] {
  const segmenter = new Intl.Segmenter(language === "und" ? undefined : language, {
    granularity: "word",
  });
  const tokens = new Set<string>();
  // Treat file-name separators as spaces so "river_canyon-01.mp4" yields words.
  const prepared = normalizeText(text).replace(/[_\-.]+/gu, " ");
  for (const segment of segmenter.segment(prepared)) {
    if (segment.isWordLike !== true) continue;
    const token = segment.segment;
    if (token.length < 2 || STOPWORDS.has(token) || /^\d+$/u.test(token)) continue;
    tokens.add(SYNONYMS.get(token) ?? token);
  }
  return [...tokens].sort();
}

/** Canonical concept for a single constraint term such as a must-show term. */
export function normalizeTerm(term: string): string[] {
  return normalizeTokens(term);
}
