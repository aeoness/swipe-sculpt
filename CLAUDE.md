# Swipe Sculpt — project brief

## Purpose
Swipes cost money; every swipe is already stored locally in chat.jsonl.
ST's carousel makes the user pick one and silently discards the rest.
Sculpt is a salvage tool: assemble the desired message out of parts
already paid for, with zero additional generation.

Concrete case — long-form RP prose. Swipe 2 has the right opening line,
swipe 4 has the physical blocking, swipe 5 ends on the right note. None
is good end to end. Without this tool the choice is settle or re-roll.
With it: take the opening from 2, the middle from 4, the close from 5,
stitch by hand.

## Scope: build now
1. Free text selection across swipe panels — not paragraph-block
   chunking. Must be able to grab a half-sentence or single clause.
   RP prose does not break cleanly on line breaks.
2. A composite/scratch pane that accepts selected fragments AND is
   directly editable. The stitch is a starting point; seams get smoothed
   by hand afterward.
3. Commit the composite by PUSHING A NEW SWIPE at the end of the array.
   Never overwrite the current swipe. Raw material stays visible beside
   the assembled version.
4. Hand-built swipes visually marked in the grid, distinct from
   generations.
5. Any message by ID, not just the last one.

## Scope: RETIRED — design history, do not build
> RETIRED 2026-08-20, superseded. Module-level `compositeState` already
> outlives the modal, Blocks made the stitch session resumable, and 0.3.0's
> planned reload-persistence closes the last gap. The problem this was
> invented for (a work session fighting a modal that dies on close) is now
> solved by other means. The architecture discipline it demanded — composite
> state kept OUT of the modal lifecycle — was its real gift, and that's
> already banked. Kept below only as a record of the original thinking.

A floating, persistent editor window: own toggle icon, draggable,
resizable, stays open while browsing swipes, retains contents when
closed and reopened, position/size persisted.

This is the eventual shape, and the reason is that stitching is a work
session rather than a single action — a modal that owns the screen and
dies on close fights that. Recording it here only so the architecture
doesn't preclude it.

The one thing that matters today: keep composite-pane state OUT of the
modal's lifecycle. If pane state is owned by the modal, extracting it
into a standalone window later is a rewrite instead of a refactor.

## Invariants
- swipes[swipe_id] and mes must always be written together, in a single
  function. Do not expose any code path that writes one without the
  other. The prompt is built from mes, so a desync silently feeds the
  model different text than the user sees — no error, no visual symptom,
  just drift.
- Editing an old message means downstream messages were written in
  response to text that no longer exists. Not yours to solve, but
  destructive overwrite of old messages must not be the frictionless
  default path.

## Verified facts (don't re-derive)
- Swipes persist on EVERY message in chat.jsonl, not just the last.
  Confirmed: branching from an old message carried its swipes into the
  new chat. ST simply doesn't render swipe arrows past the most recent
  message. There is an archive of unused swipes going back weeks.

## Known edge cases (documented, not bugs)
- Trim Spaces (ST power-user setting, `powerUserSettings.trim_spaces`):
  when on, both `saveSwipeEdit` and `commitComposite` run the text
  through `.trim()` before saving — deliberately, to match ST's own
  editor. So a composite with intentional leading/trailing whitespace
  loses it on commit. Each grabbed fragment is still stored byte-exact;
  only the final trim of the whole composite is affected. This is the one
  place the byte-for-byte guarantee yields to a user setting, and it does
  so on purpose (a Sculpt edit should behave like any other ST edit).
- Line endings: Sculpt canonicalizes CRLF to LF on grab (as of 0.2.2).
  The rendered view only ever yields LF, and the raw-view textarea
  silently drops `\r` from its `.value`, so a grab is LF either way;
  `resolveRenderedGrab` normalizes both sides before matching so a
  selection crossing a CRLF line break still resolves. Before 0.2.2 it
  did NOT normalize, and any rendered-view selection that crossed a line
  break on a CRLF chat failed to match and got misreported as "crosses
  formatting," bouncing to the raw view — the CRLF grab bug. A committed
  swipe is therefore LF; ST's own editor normalizes to LF too, so this
  matches native behavior. This was previously filed here as "not a bug";
  it was one.

## Acceptance criteria
Markdown fidelity is the make-or-break. The user's prose uses *italics*
and **bold** heavily and meaningfully.

Test: select a fragment containing *italics*, **bold**, a line break,
and a trailing space; splice it into the composite; commit; then read
the committed swipe back from chat.jsonl. It must match the source
substring byte-for-byte. No whitespace normalization, no entity
escaping, no asterisk mangling, no smart-quote substitution.

The guarantee covers authored characters — asterisks, spacing, markdown,
quotes. It does NOT cover line-ending encoding: CRLF is canonicalized to
LF (see the line-endings note above), because the rendered and raw grab
paths both yield LF and no consumer reads the `\r` back. So on a CRLF
chat the committed fragment matches the source with `\r\n` read as `\n`,
not literally byte-for-byte. That is the one intended exception.

Selection and clipboard APIs normalize whitespace and strip formatting
by default. Assume this will break until proven otherwise.

## Working style
Build in the order listed under "build now." After each numbered item,
stop and let the user look at it in the browser before continuing.
