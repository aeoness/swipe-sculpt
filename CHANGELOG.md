# Changelog

All notable changes to Swipe Sculpt are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Work on 0.3.0 is underway, starting with Undo.

## [0.2.2] - 2026-08-28

### Fixed

- Grabbing from the rendered view no longer misfires on chats with Windows line endings. A selection that crossed a line break was wrongly reported as "includes formatting" and bounced to the raw view; it now grabs correctly. Grabbed fragments use LF line endings, matching the raw view and the rest of the composite.
- Grabbing from the rendered view after opening a raw view no longer reports "select some text" when a selection is present. The selection is now captured as you make it, so switching a card to its raw view can no longer discard it before Grab reads it.

## [0.2.1] - 2026-08-20

### Fixed

- Switching messages or searching no longer silently discards an in-progress swipe edit.
- Composite blocks now show their full grabbed text instead of appearing cut off.

### Changed

- The confirm buttons (Clear, Commit, Delete) now auto-reset after a few seconds, so a stale "are you sure?" cannot catch a later, unrelated click.
- Commit's "changes an older message?" warning now resets when you switch to a different message.
- README refreshed to cover Search and Block mode. Internal documentation and code-comment cleanups.

## [0.2.0] - 2026-08-01

### Added

- Search box that filters the swipe grid, with every match highlighted in the text.
- Grab directly from the formatted view, not just the raw source. If a selection crosses markdown, Sculpt flips that card to its raw view so the fragment can be grabbed exactly.
- Block mode: a Blocks or Text toggle for the composite. In Blocks view each grabbed fragment is a draggable card you can reorder, edit, delete, or add to by hand.

## [0.1.0] - 2026-07-25

### Added

- First release.
- Visual grid showing every swipe for any message side by side, not just the most recent one.
- Byte-exact fragment grabbing from a swipe's raw source, preserving markdown, line breaks, and spacing exactly.
- A sticky, editable composite pane for stitching grabbed fragments together.
- Commit the composite back to the message as a brand-new swipe, leaving the original generations untouched.
- Edit or delete any individual swipe in place, with a two-step confirm on deletion.
- Sculpted markers that flag hand-assembled swipes in the grid, distinct from generated ones.

[Unreleased]: https://github.com/aeoness/swipe-sculpt/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/aeoness/swipe-sculpt/releases/tag/v0.2.2
[0.2.1]: https://github.com/aeoness/swipe-sculpt/releases/tag/v0.2.1
[0.2.0]: https://github.com/aeoness/swipe-sculpt/releases/tag/v0.2.0
[0.1.0]: https://github.com/aeoness/swipe-sculpt/releases/tag/v0.1.0
