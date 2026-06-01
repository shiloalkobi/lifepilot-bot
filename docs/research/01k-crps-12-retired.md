# CRPS-12 Click/Interest Logging — RETIRED (superseded by CRPS-11 + CRPS-9)

**Status:** RETIRED / WON'T BUILD
**Date:** 2026-06-01 (Asia/Jerusalem)
**Decision by:** Shilo, on the analyst's Phase 1 recommendation
**Phase reached:** Phase 1 (Investigation) only — no design, no code.

---

## Original intent

Learn which research articles Shilo finds interesting, to improve future
surfacing — "click logging → learn preferences."

## Decision

**CRPS-12 is retired.** The goal it set out to solve — "learn which research
Shilo finds interesting" — is **already delivered by features that shipped
earlier in the CRPS Phase 5+ track**, using stronger signals than click-logging
could ever provide for a single user:

- **CRPS-11 Topic Subscriptions** (merged `297da80`): explicit interest signal.
  Shilo states the topics he cares about; the weekly digest boosts matching
  articles (`TOPIC_BOOST` in `bot/research-digest.js`). This is a direct,
  unambiguous "I am interested in X."
- **CRPS-9 Personalization Profile** (`set_research_profile` /
  `research_profile`, `skills/research/index.js:304-333`): explicit
  treatments/preferences signal.

Click-logging is an **implicit, weak** signal by comparison. It captures the
same intent these two already capture explicitly — but worse.

## Why not build it (investigation evidence)

1. **Single user + implicit signal = almost no learnable data.** Click-logging
   is a multi-user recommender-system technique that relies on large click
   volumes. With one user and ~5 digest articles/week (`pickTop5`,
   `bot/research-digest.js`), the data trickle is too small and too noisy
   (curiosity vs. accidental tap vs. "is this junk?") to threshold or train on.

2. **Explicit signals dominate the implicit one.** There is no preference a
   click could reveal that a CRPS-11 topic subscription can't capture more
   cleanly — and Shilo already has the subscription mechanism.

3. **The redirect-endpoint conception carried real downside for ~zero upside:**
   - Article links today go straight from Telegram to the source
     (`bot/research-digest.js:123`, plain `<a href>`). The bot never sees a
     click — there is no interception point without new infrastructure.
   - Logging clicks would require a **new public, unauthenticated,
     state-mutating HTTP route** (clicks come from Telegram's in-app browser
     with no dashboard auth cookie; it cannot be `requireAuth`-gated like the
     rest of `bot/index.js`'s `/api/*`). That is a different and higher risk
     class than the existing read-only static routes.
   - **PHI sensitivity:** "which CRPS articles Shilo opened" is sensitive.
   - **Render-sleep risk:** no keep-alive/self-ping exists in the repo; if the
     host sleeps, a click on a medical link means a cold-start delay or a failed
     redirect — bad UX on exactly the links that matter. (Hosting tier not
     confirmable from source — flagged as a gap, not a fact.)

## Alternatives considered and rejected

- **(a) Telegram inline `👍 מעניין` button** under each digest article.
  *Technically clean* — the `callback_query` pattern already exists end-to-end
  (handler at `bot/telegram.js:1278`, `answerCallbackQuery` +
  `editMessageReplyMarkup`, used by the leads feature), so it needs no new
  endpoint, no PHI egress, and no Render-sleep exposure. **Still rejected**: even
  a clean implementation produces a near-useless trickle of single-user implicit
  data that CRPS-11 already captures explicitly. Cheap, but solves an
  already-solved problem.
- **(b) `/interested <topic>` command.** Rejected as redundant — it is just a
  clumsier `subscribe_research_topic`, which already exists (CRPS-11).
- **Redirect endpoint (the original conception).** Rejected outright — see the
  downside list above.

## What this closes

This was the last of the CRPS Phase 5+ enhancement candidates. With CRPS-10
(weekly digest), CRPS-13 (Tier 3 audit dashboard), and CRPS-11 (topic
subscriptions) shipped, and CRPS-12 retired as superseded, the CRPS Phase 5+
track is complete.

## Reopen criteria (if ever)

Revisit only if the premises change, e.g.:
- The bot gains multiple users (implicit signals start to aggregate), OR
- A confirmed always-on host removes the cold-start risk AND there is a concrete
  surfacing improvement that explicit subscriptions provably cannot capture.

If reopened, build **only** the inline-button form (option a) — never the public
redirect endpoint.

## References

- Phase 1 investigation: this document (analyst findings, 2026-06-01)
- CRPS-11: `docs/research/01j-topic-subscriptions-design.md`, merge `297da80`
- CRPS-13: `docs/research/01i-tier3-audit-design.md`
- CRPS-10: `docs/research/01h-weekly-digest-design.md`
