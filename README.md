# Swipe Sculpt

**Swipe Sculpt** is a visual workflow extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern) that lets you view, clip, and merge multiple message swipes into a single composite response.

Instead of manually toggling through swipes or copying text back and forth between external note apps, Swipe Sculpt turns your swipes into an interactive, side-by-side staging studio.

---

## 🎨 Features

* **Visual Grid View:** Gallery layout displaying every swipe side-by-side in a responsive grid, for any message, not just the most recent one.
* **Search & Highlight:** Filter the grid to just the swipes that contain a word or phrase, with every match highlighted in the text so you can spot it at a glance.
* **Byte-Exact Grabbing:** Select a clause or half-sentence from any swipe and drop it into the composite with its markdown (`*italics*`, `**bold**`), line breaks, and spacing preserved exactly. Grab straight from the formatted view, or flip a card to its raw `</>` source when your selection crosses formatting and needs to be picked out precisely.
* **Blocks or Text:** Work on the composite two ways. In **Blocks** view each grabbed fragment is a draggable card you can reorder, click to edit, delete, or add to by hand. In **Text** view the whole thing becomes one freely editable box for smoothing the seams.
* **Commit as New Swipe:** Save your finished composite back into the message as a brand-new swipe, so your original generations are never overwritten.
* **Per-Swipe Editing & Deletion:** Edit or delete any individual swipe in place, with a two-step confirm on destructive actions.
* **Sculpted Markers:** Hand-assembled swipes are visually flagged in the grid, distinct from generated ones.
* **Native Styling:** Fits directly into SillyTavern's default dark aesthetic.

---

## 🚀 Installation

1. Open **SillyTavern**.
2. Click the **Extensions** icon (puzzle piece) in the top panel.
3. Open the **Install Extension** tab.
4. Paste the repository URL:
   https://github.com/aeoness/swipe-sculpt
5. Click **Install**.

---

## 📖 How to Use

1. Generate a few swipes on a message.
2. Open the **wand menu** (🪄, bottom-left of the chat bar) and click **Swipe Sculpt**.
3. Browse the grid of swipes. Use the message dropdown at the top to sculpt any message in the chat, not just the last one. Type in the **Search** box to narrow the grid to swipes that mention a word or phrase.
4. Select the text you want in a swipe and press **Grab**. It drops into the **Composite** box at your cursor. You can grab straight from the formatted view; if your selection crosses markdown, Sculpt flips that card to its raw `</>` source so you can grab it exactly.
5. Grab from as many swipes as you like. Reorder the pieces in **Blocks** view, or switch to **Text** view to smooth the seams by hand.
6. Click **Commit as New Swipe** to add your assembled version back to the message as a new swipe.

---

## 📁 File Structure

- `manifest.json` — Extension metadata and loader configuration
- `index.js` — Core extension logic and DOM handlers
- `style.css` — Extension modal and grid styling
- `CLAUDE.md` — Developer architecture brief
- `README.md` — User documentation
- `LICENSE` — MIT license
- `.gitignore` — Files git should not track

---

## 📄 License

[MIT](LICENSE)