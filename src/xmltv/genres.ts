/**
 * The DVB genre vocabulary, for turning a source's own category text into
 * something a consumer recognises.
 *
 * Two things travel together here: the canonical `<category>` text, and the
 * `content_nibble` that means it. The text is what works out of the box —
 * tvheadend matches `<category>` against this vocabulary and silently drops
 * anything one character off — and the code is what an `eit` attribute carries
 * for a consumer configured to read one.
 *
 * ## Which spelling is canonical, and which is an alias
 *
 * The normative source is ETSI EN 300 468 table 29, but the **canonical**
 * strings below are tvheadend's, because it is the consumer that matches on
 * them. Where the two differ, ETSI's wording is carried as an alias, so a guide
 * written to the standard still lands:
 *
 * - ETSI suffixes every `0xN0` entry with ` (general)`; tvheadend drops it.
 * - ETSI spells the children's rows **British** — `programmes` — and tvheadend
 *   **American** — `programs`. Five cells, and the one most easily got wrong.
 * - `0x7a` is `Arts magazines / Culture magazines` to tvheadend and the single
 *   phrase `arts/culture magazines` to ETSI. Not cosmetic: they do not fold
 *   together.
 *
 * Every other cell differs only in case or separator spacing, which the fold
 * below already collapses, so those need no alias.
 *
 * Case and spacing do not matter to tvheadend either — its matcher lowercases
 * with `| 0x20` and skips every space on both sides — so `'Movie/Drama'` and
 * `'Movie / Drama'` both land. Two consequences that do matter: the strings
 * stay **ASCII**, since `| 0x20` cannot fold an accented character, and nothing
 * here carries leading or trailing whitespace, because a trailing space walks
 * that matcher past its own terminator.
 *
 * ## Why 75 entries and not 256
 *
 * A `content_nibble` is two nibbles, so there are sixteen rows of sixteen — but
 * most of those slots are not genres. ETSI marks them `reserved for future use`
 * or `user defined`, and tvheadend fills each one with a **repeat of its row's
 * name**: `0x10` is `Movie / Drama`, and so are `0x19` through `0x1f`.
 *
 * Those repeats are unreachable, and listing them would be actively wrong. A
 * lookup by name returns the first match, and the match is case-insensitive, so
 * `0x10` always answers for `Movie / Drama` and `0x19` never does. Worse, a
 * second entry would collide on the same folded key here and overwrite the
 * first, so every film would go out as `eit="0x19"` — a code that means
 * *reserved*, not *Movie / Drama*.
 *
 * Ten such runs exist (`0x19`-`0x1f`, `0x25`-`0x2f`, `0x34`-`0x3f`,
 * `0x4c`-`0x4f`, `0x56`-`0x5f`, `0x67`-`0x6f`, `0x7c`-`0x7f`, `0x84`-`0x8f`,
 * `0x98`-`0x9f`, `0xa8`-`0xaf`). What is left is every code a genre can
 * actually be named by.
 *
 * ETSI's major `0xb` (`original language`, `black and white`, `live broadcast`
 * …) is absent for a different reason: those are not genres. tvheadend's table
 * stops at `0xa` deliberately, and its lookup would not reach `0xb` even if it
 * did not; XMLTV says these things with `<live/>`, `<colour>` and `<language>`.
 */

/**
 * One genre: the text a guide should carry, the code that means it, and the
 * other spellings that mean the same thing.
 */
export interface Genre {
  /** Canonical `<category>` text, as the matching consumer spells it. */
  name: string;
  /**
   * The DVB `content_nibble`, in the `0xNN` form an `eit` attribute takes.
   *
   * Never `0x00`: that is "undefined content", and a consumer reading codes
   * rejects it outright rather than treating it as a genre.
   */
  eit: string;
  /**
   * Other spellings that mean this genre, matched by the same fold as
   * {@link name} — case, spacing, underscores and hyphens all ignored.
   *
   * Two kinds. **ETSI's own wording**, where it differs from the canonical form
   * by more than that — the standard's spelling should not be the one that
   * fails to match. And what real guides actually emit: `Movie`, `Film`,
   * `Kids`, `Documentary`, `Science fiction` and the rest turn up constantly in
   * the wild, where the full canonical strings almost never do.
   */
  aliases?: readonly string[];
}

/**
 * The vocabulary, in code order.
 *
 * A category that means nothing here has **no** entry — `Series`,
 * `Special Interest`, `Other` and the sports-league acronyms are among the
 * commonest real values of all, and none of them is a DVB genre.
 * {@link genreOf} says so by returning nothing, rather than falling back to a
 * code that means "undefined".
 */
export const DVB_GENRES: readonly Genre[] = [
  // Movie / Drama
  {
    name: 'Movie / Drama',
    eit: '0x10',
    aliases: [
      'Movie / drama (general)', // ETSI
      'Movie',
      'Movies',
      'Movies & TV',
      'Film',
      'Films',
      'Feature film',
      'Drama',
      'Feature',
      'Miniseries',
      'Made-for-TV movie',
      'Anthology',
      'Classic TV',
      'Action & Drama',
    ],
  },
  {
    name: 'Detective / Thriller',
    eit: '0x11',
    aliases: [
      'Detective',
      'Thriller',
      'Suspense',
      'Crime',
      'True crime',
      'Crime drama',
      'Police',
      'Mystery',
    ],
  },
  {
    name: 'Adventure / Western / War',
    eit: '0x12',
    aliases: ['Action', 'Adventure', 'Action & Adventure', 'Western', 'War'],
  },
  {
    name: 'Science fiction / Fantasy / Horror',
    eit: '0x13',
    // `Science fiction` alone is one of the commonest categories a real feed
    // emits, and it does not fold onto the full canonical name.
    aliases: ['Science fiction', 'Sci-Fi', 'Fantasy', 'Horror', 'Paranormal', 'Supernatural'],
  },
  {
    name: 'Comedy',
    eit: '0x14',
    aliases: ['Sitcom', 'Stand-up', 'Stand-up comedy', 'Dark comedy', 'Humour', 'Humor'],
  },
  {
    name: 'Soap / Melodrama / Folkloric',
    eit: '0x15',
    aliases: ['Soap', 'Soap opera', 'Telenovela', 'Melodrama'],
  },
  { name: 'Romance', eit: '0x16', aliases: ['Romantic', 'Romantic comedy', 'Romance-comedy'] },
  {
    name: 'Serious / Classical / Religious / Historical movie / Drama',
    eit: '0x17',
    aliases: ['Historical drama', 'Period drama'],
  },
  { name: 'Adult movie / Drama', eit: '0x18', aliases: ['Adult'] },

  // News / Current affairs
  {
    name: 'News / Current affairs',
    eit: '0x20',
    aliases: [
      'News / current affairs (general)', // ETSI
      'News',
      'Local news',
      'National news',
      'Current affairs',
      'World affairs',
      'News & Information',
    ],
  },
  { name: 'News / Weather report', eit: '0x21', aliases: ['Weather', 'Weather report'] },
  { name: 'News magazine', eit: '0x22' },
  {
    name: 'Documentary',
    eit: '0x23',
    aliases: [
      'Documentaries',
      'Docu',
      'Docudrama',
      'Factual',
      'News & Documentary',
      'News & Documentaries',
    ],
  },
  {
    name: 'Discussion / Interview / Debate',
    eit: '0x24',
    aliases: ['Discussion', 'Interview', 'Debate'],
  },

  // Show / Game show
  {
    name: 'Show / Game show',
    eit: '0x30',
    aliases: [
      'Show / game show (general)', // ETSI
      'Show',
      'Entertainment',
      'Light entertainment',
      'Reality',
      'Reality TV',
      'Awards',
    ],
  },
  { name: 'Game show / Quiz / Contest', eit: '0x31', aliases: ['Game show', 'Quiz', 'Contest'] },
  { name: 'Variety show', eit: '0x32', aliases: ['Variety'] },
  { name: 'Talk show', eit: '0x33', aliases: ['Talk', 'Chat show'] },

  // Sports
  {
    name: 'Sports',
    eit: '0x40',
    aliases: [
      'Sports (general)', // ETSI
      'Sport',
      'Sports event',
      'Sports non-event',
      'Live sports',
    ],
  },
  {
    name: 'Special events (Olympic Games, World Cup, etc.)',
    eit: '0x41',
    aliases: ['PPV', 'Pay Per View'],
  },
  { name: 'Sports magazines', eit: '0x42', aliases: ['Sports magazine'] },
  { name: 'Football / Soccer', eit: '0x43', aliases: ['Football', 'Soccer'] },
  { name: 'Tennis / Squash', eit: '0x44', aliases: ['Tennis', 'Squash'] },
  {
    name: 'Team sports (excluding football)',
    eit: '0x45',
    // DVB has no per-league granularity, and league acronyms are the bulk of
    // what a US sports feed emits. tvheadend's own source makes the same
    // reduction, with a `Cricket` example.
    aliases: ['Basketball', 'Baseball', 'Cricket', 'Rugby', 'Hockey', 'American football'],
  },
  { name: 'Athletics', eit: '0x46', aliases: ['Track and field'] },
  {
    name: 'Motor sport',
    eit: '0x47',
    aliases: ['Motor sports', 'Racing', 'Auto racing', 'Formula 1'],
  },
  { name: 'Water sport', eit: '0x48', aliases: ['Swimming'] },
  { name: 'Winter sports', eit: '0x49', aliases: ['Skiing'] },
  { name: 'Equestrian', eit: '0x4a', aliases: ['Horse racing'] },
  {
    name: 'Martial sports',
    eit: '0x4b',
    aliases: ['Martial arts', 'Mixed martial arts', 'MMA', 'UFC', 'WWE', 'Boxing', 'Wrestling'],
  },

  // Children's / Youth programs. Canonically American, which is tvheadend's
  // spelling; ETSI's `programmes` is aliased on all five.
  {
    name: "Children's / Youth programs",
    eit: '0x50',
    aliases: [
      "Children's / youth programmes (general)", // ETSI
      "Children's / Youth programmes",
      "Children's",
      'Children',
      'Kids',
      'Kids & Family',
      'Youth',
      'Family',
    ],
  },
  {
    name: "Pre-school children's programs",
    eit: '0x51',
    aliases: [
      "Pre-school children's programmes", // ETSI
      'Pre-school',
      'Under 5',
    ],
  },
  {
    name: 'Entertainment programs for 6 to 14',
    eit: '0x52',
    aliases: ['Entertainment programmes for 6 to 14'], // ETSI
  },
  {
    name: 'Entertainment programs for 10 to 16',
    eit: '0x53',
    aliases: ['Entertainment programmes for 10 to 16'], // ETSI
  },
  {
    name: 'Informational / Educational / School programs',
    eit: '0x54',
    aliases: [
      'Informational / educational / school programmes', // ETSI
      'Educational',
    ],
  },
  {
    name: 'Cartoons / Puppets',
    eit: '0x55',
    aliases: [
      'Cartoon',
      'Cartoons',
      'Animation',
      'Animated',
      'Anime',
      'Animation & Cartoon',
      "Children's animation",
    ],
  },

  // Music / Ballet / Dance
  {
    name: 'Music / Ballet / Dance',
    eit: '0x60',
    aliases: [
      'Music / ballet / dance (general)', // ETSI
      'Music',
      'Dance',
      'Music & Radio',
    ],
  },
  { name: 'Rock / Pop', eit: '0x61', aliases: ['Rock', 'Pop', 'Rock&Pop'] },
  {
    name: 'Serious music / Classical music',
    eit: '0x62',
    aliases: ['Classical', 'Classical music'],
  },
  { name: 'Folk / Traditional music', eit: '0x63', aliases: ['Folk', 'Country'] },
  { name: 'Jazz', eit: '0x64' },
  { name: 'Musical / Opera', eit: '0x65', aliases: ['Musical', 'Opera'] },
  { name: 'Ballet', eit: '0x66' },

  // Arts / Culture (without music)
  {
    name: 'Arts / Culture (without music)',
    eit: '0x70',
    aliases: [
      'Arts / culture (without music, general)', // ETSI — `general` inside the parens
      'Arts',
      'Culture',
      'Arts & Culture',
    ],
  },
  { name: 'Performing arts', eit: '0x71', aliases: ['Theatre', 'Theater'] },
  { name: 'Fine arts', eit: '0x72' },
  {
    name: 'Religion',
    eit: '0x73',
    aliases: ['Religious', 'Religious programming', 'Faith & Spirituality', 'Christian & Gospel'],
  },
  { name: 'Popular culture / Traditional arts', eit: '0x74' },
  { name: 'Literature', eit: '0x75', aliases: ['Books'] },
  { name: 'Film / Cinema', eit: '0x76', aliases: ['Cinema'] },
  { name: 'Experimental film / Video', eit: '0x77' },
  { name: 'Broadcasting / Press', eit: '0x78' },
  { name: 'New media', eit: '0x79' },
  {
    // Two full noun phrases to tvheadend, one shared head noun to ETSI.
    name: 'Arts magazines / Culture magazines',
    eit: '0x7a',
    aliases: ['Arts / culture magazines'], // ETSI
  },
  { name: 'Fashion', eit: '0x7b' },

  // Social / Political issues / Economics
  {
    name: 'Social / Political issues / Economics',
    eit: '0x80',
    aliases: [
      'Social / political issues / economics (general)', // ETSI
      'Politics',
      'Political',
      'Society',
    ],
  },
  { name: 'Magazines / Reports / Documentary', eit: '0x81' },
  {
    name: 'Economics / Social advisory',
    eit: '0x82',
    aliases: ['Business', 'Business & Finance', 'Finance', 'Financial', 'Consumer', 'Economics'],
  },
  { name: 'Remarkable people', eit: '0x83', aliases: ['Biography'] },

  // Education / Science / Factual topics
  {
    name: 'Education / Science / Factual topics',
    eit: '0x90',
    aliases: [
      'Education / science / factual topics (general)', // ETSI
      'Education',
      'Science',
      'Learning',
    ],
  },
  {
    name: 'Nature / Animals / Environment',
    eit: '0x91',
    aliases: ['Nature', 'Animals', 'Wildlife', 'Environment', 'Agriculture'],
  },
  {
    name: 'Technology / Natural sciences',
    eit: '0x92',
    aliases: ['Technology', 'Tech', 'Computers', 'Aviation'],
  },
  {
    name: 'Medicine / Physiology / Psychology',
    eit: '0x93',
    aliases: ['Medicine', 'Medical', 'Psychology'],
  },
  { name: 'Foreign countries / Expeditions', eit: '0x94' },
  { name: 'Social / Spiritual sciences', eit: '0x95' },
  { name: 'Further education', eit: '0x96' },
  { name: 'Languages', eit: '0x97' },

  // Leisure hobbies
  {
    name: 'Leisure hobbies',
    eit: '0xa0',
    aliases: [
      'Leisure hobbies (general)', // ETSI
      'Hobbies',
      'Lifestyle',
      'Lifestyles',
      'Home & Lifestyle',
      'Home & DIY',
      'Home & Garden',
      'Home improvement',
      'How-to',
      'Collectibles',
      'Arts/crafts',
    ],
  },
  { name: 'Tourism / Travel', eit: '0xa1', aliases: ['Travel', 'Tourism'] },
  { name: 'Handicraft', eit: '0xa2', aliases: ['Crafts'] },
  { name: 'Motoring', eit: '0xa3', aliases: ['Motors', 'Cars'] },
  { name: 'Fitness and health', eit: '0xa4', aliases: ['Fitness', 'Health'] },
  {
    name: 'Cooking',
    eit: '0xa5',
    aliases: ['Food', 'Food & Cooking', 'Cookery', 'Baking', 'Culinary'],
  },
  {
    name: 'Advertisement / Shopping',
    eit: '0xa6',
    aliases: ['Shopping', 'Advertisement', 'Teleshopping'],
  },
  {
    name: 'Gardening',
    eit: '0xa7',
    // `Gradening` is not a typo here: it is how one large public guide spells
    // it, across a couple of hundred real programmes.
    aliases: ['Garden', 'Gradening'],
  },
];

/**
 * The key a category name is matched by: lowercased, with whitespace,
 * underscores and hyphens removed.
 *
 * Whitespace goes because that is what the matching consumer does, so anything
 * this recognises produces a name that consumer will also recognise. Underscores
 * and hyphens go because feeds substitute them for spaces — `Sci-Fi`,
 * `Stand-up`, `Pre-school` — and folding them costs nothing.
 *
 * `/` and `&` stay: they separate words rather than standing in for a space, and
 * dropping `/` would fold `Arts / culture magazines` onto
 * `Arts magazines / Culture magazines`, which are different genres.
 *
 * Exported because a caller's own category map should be keyed the same way, so
 * `'sci-fi'` in a hand-written table matches a source writing `Sci Fi`.
 */
export function genreKey(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/gu, '');
}

/** Built once, at module load, since a guide asks this per category. */
const BY_NAME = new Map<string, Genre>();

for (const genre of DVB_GENRES) {
  BY_NAME.set(genreKey(genre.name), genre);

  for (const alias of genre.aliases ?? []) {
    BY_NAME.set(genreKey(alias), genre);
  }
}

/**
 * The genre a category names, by its canonical name or any known alias.
 *
 * `undefined` when nothing matches, which is the common case and not an error:
 * one of the most frequent categories in real guides is `Series`, and DVB has
 * no concept for it. An empty category is a miss like any other.
 */
export function genreOf(value: string): Genre | undefined {
  return BY_NAME.get(genreKey(value));
}
