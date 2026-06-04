// ─── Unsplash hero image helper ───────────────────────────────────────────
// Fetches a single landscape stock photo URL for a search query.
// Used by generate_landing_page to give the hero a real background image.
//
// MANDATORY graceful degradation:
//   - No UNSPLASH_ACCESS_KEY env var  → returns null
//   - Non-OK HTTP response            → returns null
//   - Timeout / network / parse error → returns null (logged, never throws)
//   - No results                      → returns null
// The caller treats null as "use the existing gradient fallback".
// This function must NEVER throw and must NEVER hang generation.

const UNSPLASH_TIMEOUT_MS = 5000;

async function fetchHeroImage(query) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UNSPLASH_TIMEOUT_MS);

  try {
    const url = 'https://api.unsplash.com/search/photos?query='
      + encodeURIComponent(query)
      + '&per_page=1&orientation=landscape';

    const res = await fetch(url, {
      headers: { Authorization: 'Client-ID ' + key },
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const json = await res.json();
    return json.results?.[0]?.urls?.regular || null;
  } catch (e) {
    console.error('[unsplash]', e.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchHeroImage };
