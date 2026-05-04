'use strict';

/**
 * Deterministic pre-filter for CRPS research articles.
 * Runs BEFORE the LLM classifier to short-circuit obvious Tier-3 content
 * without spending tokens. Approved blocklist per docs/research/01b §6.2 (Q15).
 *
 * Each rule has a stable `reason_code` for the transparency log
 * (research_blocked_log.reason_code). Some rows share a reason_code
 * (e.g., suicide + suicidal ideation both use 'suicide_keyword') —
 * 12 distinct codes across 15 approved keyword rows.
 *
 * `applyPreFilter(article)` returns `{ blocked, reason_code? }`.
 * Order matters: first match wins. More-specific rules listed before broader ones.
 */

const RULES = [
  // Row 1 — suicide
  { id: 'suicide',                reason_code: 'suicide_keyword',
    patterns: [/\bsuicide\b/i, /התאבדות/] },
  // Row 2 — suicidal ideation
  { id: 'suicidal_ideation',      reason_code: 'suicide_keyword',
    patterns: [/\bsuicidal\s+ideation\b/i, /מחשבות\s+אובדניות/] },
  // Row 3 — self-harm
  { id: 'self_harm',              reason_code: 'selfharm_keyword',
    patterns: [/\bself[\s-]?harm\b/i, /פגיעה\s+עצמית/] },
  // Row 4 — disability rate
  { id: 'disability_rate',        reason_code: 'disability_stat',
    patterns: [/\bdisability\s+rate/i, /אחוז(?:י)?\s+נכות/] },
  // Row 5 — mortality rate
  { id: 'mortality_rate',         reason_code: 'mortality_stat',
    patterns: [/\bmortality\s+rate/i, /תמותה/] },
  // Row 6 — "most painful condition"
  { id: 'most_painful_condition', reason_code: 'extreme_framing',
    patterns: [/most\s+painful\s+condition/i, /הכאב\s+הנורא\s+ביותר/] },
  // Row 7 — "worst pain known to"
  { id: 'worst_pain_known',       reason_code: 'extreme_framing',
    patterns: [/worst\s+pain\s+known/i, /הכאב\s+החמור\s+ביותר/] },
  // Row 8 — amputation rates  (phrase, not bare "amputation" — avoids "avoiding amputation" false-positive)
  { id: 'amputation_rates',       reason_code: 'amputation_stat',
    patterns: [/\bamputation\s+rate/i, /אחוזי\s+כריתה/] },
  // Row 9 — progressive disability
  { id: 'progressive_disability', reason_code: 'progression_pessimism',
    patterns: [/\bprogressive\s+disability\b/i, /התקדמות\s+נכות/] },
  // Row 10 — terminal
  { id: 'terminal',               reason_code: 'terminal_framing',
    patterns: [/\bterminal\b/i, /\bסופני(?:ת)?\b/] },
  // Row 11 — hopeless
  { id: 'hopeless',               reason_code: 'hopeless_framing',
    patterns: [/\bhopeless(?:ness)?\b/i, /חסר(?:ת)?\s+תקווה/] },
  // Row 12 — irreversible damage
  { id: 'irreversible_damage',    reason_code: 'irreversible_framing',
    patterns: [/\birreversible\s+damage\b/i, /נזק\s+בלתי\s+הפיך/] },
  // Row 13 — nothing works
  { id: 'nothing_works',          reason_code: 'nihilism_framing',
    patterns: [/\bnothing\s+works\b/i, /שום\s+דבר\s+לא\s+עוזר/] },
  // Row 14 — reddit / r/CRPS
  { id: 'reddit',                 reason_code: 'forum_anecdote',
    patterns: [/\breddit\b/i, /r\/CRPS/i] },
  // Row 15 — facebook group
  { id: 'facebook_group',         reason_code: 'forum_anecdote',
    patterns: [/facebook\s+group/i, /קבוצת\s+פייסבוק/] },
];

function applyPreFilter(article) {
  const haystack = [article && article.title, article && article.abstract]
    .filter(Boolean)
    .join('\n');
  if (!haystack) return { blocked: false };

  for (const rule of RULES) {
    for (const re of rule.patterns) {
      if (re.test(haystack)) {
        return { blocked: true, reason_code: rule.reason_code, rule_id: rule.id };
      }
    }
  }
  return { blocked: false };
}

module.exports = { applyPreFilter, RULES };
