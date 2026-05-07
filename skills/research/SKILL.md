# Skill: research

CRPS research aggregator with a two-stage **Hope Filter** (deterministic pre-filter + Gemini classifier). Surfaces emotionally-safe research articles in Hebrew with English source links. On-demand only — no proactive notifications.

Designed for a chronic-pain patient (Shilo, CRPS since 2018) per the BMAD trail in `docs/research/01a..01d`.

## Agent tools (4 EXTENDED-tier)

All four route through the agent's EXTENDED tier automatically (`bot/agent.js:386` — `CORE_TOOL_NAMES` allowlist; these are not in it). They activate when the user message matches `EXTENDED_KEYWORDS` (e.g., `מחקר`, `crps`, `כאב`, `research`).

| Tool | Parameters | Description |
|------|-----------|-------------|
| `search_research` | `query?` (string), `topic?` (string), `refresh?` (bool) | Returns up to 5 emotionally-filtered articles (3 Tier-1 + 2 Tier-2 mix), with Hebrew framing for Tier-2, plus a daily disclaimer on first call of the IL day. |
| `subscribe_research_topic` | `topic` (string), `keywords?` (string[]), `active?` (bool) | Upserts a topic subscription `(chat_id, topic)` for ranking weight in `search_research`. |
| `get_research_history` | `limit?` (int, 1–50, default 10) | Returns previously-surfaced articles for this `chat_id`, ordered most-recent first. |
| `set_research_profile` | `profile_he?` (string), `treatments?` (string[]), `preferences?` (object), `confirmed?` (bool) | Updates the user's research profile. **Treatment changes require a confirmation round-trip** (Q20 / US10): the first call returns `confirmation_needed: true` + a Hebrew confirmation message; the agent must re-call with `confirmed: true` to persist. |

## Sources (3 in MVP)

| Source | Coverage | Free / Paid |
|--------|----------|-------------|
| **PubMed** (E-utilities) | CRPS MeSH + Title/Abstract terms (≈ 200 papers/year) | Free; optional `NCBI_API_KEY` raises rate limit 3 → 10 req/sec |
| **ClinicalTrials.gov v2** | Global + Israel-scoped queries; recruiting trials get +30 ranking score | Free, no key |
| **medRxiv** | Date-range bulk + client-side CRPS regex (preprints; ≈ single-digit/year) | Free, no key |

Phase 5 candidates (deferred): RSS sources (RSDSA, IASP, Burning Nights), Cochrane, Israeli MoH (scraping). See `docs/research/01b §1` for the full source landscape.

## Hope Filter

Two-stage pipeline per `docs/research/01b §6`:

1. **Pre-filter** (`filter/keywords.js`) — 15 approved keywords (per Q15) covering suicide / disability stats / extreme framing / forum anecdotes. Match → block, log to `research_blocked_log.blocked_by='pre_filter'`. No LLM cost.
2. **Classifier** (`filter/classifier.js`) — Gemini 2.5 Flash with the prompt verbatim from `01b §6.3`. Returns `{ tier: 1 | 2 | 3, framing_he, block_reason, rationale }` with strict JSON schema validation; any violation coerces to Tier 3 with `block_reason='schema_violation'` (fail-safe).

Tier semantics:
- **Tier 1** — surface immediately (positive results, recruiting trials, mechanism breakthroughs).
- **Tier 2** — surface with neutral Hebrew framing (mixed results, early-phase data, treatments with caveats).
- **Tier 3** — block; logged in `research_blocked_log` for transparency review.

## Storage tables (4 — created in Phase 4a)

All have `ENABLE` + `FORCE` ROW LEVEL SECURITY + zero policies (deny-by-default per `docs/security/01f` Rule 1).

| Table | Purpose |
|-------|---------|
| `research_articles` | Surfaced articles (Tier 1/2 only). Keyed on `(source, source_id)` UNIQUE. Per-user surfacing tracked via `surfaced_to_chat_id`. |
| `research_topics` | User topic subscriptions, `(chat_id, topic)` UNIQUE. |
| `research_blocked_log` | Append-only transparency log of every Tier-3 block. |
| `research_user_profile` | Sensitive PHI (treatments, free-text Hebrew profile, preferences). `chat_id` is PK. Auto-updates `updated_at` via trigger. |

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Yes | Inherited from `bot/supabase.js` (post-`docs/security/01f` lockdown). |
| `GEMINI_API_KEY` | Yes | Already set on Render; used by the classifier. |
| `NCBI_API_KEY` | Optional | Raises PubMed rate limit. Skill works without it. |

## Token & cost budget

Gemini 2.5 Flash with reasoning tokens averages ~1,500 tokens/article (~2× the original `01b §6.5` estimate of 730). At 100 articles/month → ~$0.012/month — about 8× under the M3 target of $0.10/month. See `docs/research/01d §"Sub-phase 4c"`.

## Output format (Hebrew + English bilingual per Q3)

```jsonc
{
  "ok": true,
  "articles": [
    {
      "tier": 1,
      "title_he": "🇮🇱 מגייס בישראל • Recruiting CRPS trial at Sheba",
      "title_en": "Recruiting CRPS trial at Sheba",
      "summary_he": null,                      // present iff tier=2
      "url": "https://clinicaltrials.gov/study/NCT...",
      "source": "clinicaltrials",
      "published_at": "2026-04-15",
      "israeli_recruiting": true
    }
  ],
  "blocked_count": 2,                          // transparency: filtered this round
  "disclaimer_he": "⚕️ הבהרה: ... אינו ייעוץ רפואי..."
}
```

## Testing

- **Unit tests** (no live network): `node --test tests/research_*.test.js` — 185 cases as of Phase 4d.
- **Live emotional-safety verification** (real Gemini, requires `GEMINI_API_KEY`): `node tests/research_filter_emotional_safety.live.js` — 10 fixtures, ≥9/10 threshold per `01b §9.3`. Last run: 10/10 PASS.
- **Live integration** (real PubMed + Gemini + Supabase, requires `SUPABASE_SERVICE_ROLE_KEY`): `node tests/research_integration.live.js` — designed for Phase 4f Render smoke; will fail with anon role due to RLS lockdown (which is correct security behavior).
- **Telegram smoke** (real end-to-end): from any chat, send `תראה לי מחקר חדש על CRPS` or any message containing `מחקר` / `crps` / `כאב`. Check Render logs for `[research]`.

## Reference

Full BMAD trail: `docs/research/01a-analyst-findings-crps.md` → `01b-architect-design-crps.md` → `01c-pm-prd-crps.md` → `01d-dev-implementation.md`. Security model: `docs/security/01f-final-summary.md`.
