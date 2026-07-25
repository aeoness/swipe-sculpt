# Swipe Sculpt

**Swipe Sculpt** is a visual workflow extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern) that lets you view, clip, and merge multiple message swipes into a single composite response.

Instead of manually toggling through swipes or copying text back and forth between external note apps, Swipe Sculpt turns your swipes into an interactive, side-by-side staging studio.

---

## 🎨 Features

* **Visual Grid View:** Gallery layout displaying every swipe side-by-side in a responsive grid — for any message, not just the most recent one.
* **Byte-Exact Highlight Capture:** Flip any card to its raw source, select a clause or half-sentence, and append it to the composite with markdown (`*italics*`, `**bold**`), line breaks, and spacing preserved exactly.
* **Live Composite Editor:** A sticky, directly editable staging box at the top of the modal for smoothing the seams between stitched fragments.
* **Commit as New Swipe:** Save your finished composite back into the message as a brand-new swipe — your original generations are never overwritten.
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
3. Browse the grid of swipes. Use the message dropdown at the top to sculpt any message in the chat, not just the last one.
4. On a card, click the **`</>`** icon to show its raw source, select the text you want, and press **Grab** — it lands in the **Composite** box at the top.
5. Grab from as many swipes as you like, then fine-tune the seams directly in the Composite editor.
6. Click **Commit as new swipe** to append your assembled version back to the message as a new swipe.

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

---

> *Inspired by the multi-instance "wall" UI from the Minecraft speedrunning community (Julti, SeedQueue, and related tools).*
