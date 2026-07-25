# Swipe Sculpt

**Swipe Sculpt** is a visual workflow extension for [SillyTavern](https://github.com/SillyTavern/SillyTavern) that lets you view, clip, and merge multiple message swipes into a single composite response.

Instead of manually toggling through swipes or copying text back and forth between external note apps, Swipe Sculpt turns your swipes into an interactive, side-by-side staging studio.

---

## 🎨 Features

* **Visual Grid View:** Gallery layout displaying generated swipes side-by-side in a responsive grid.
* **Direct Highlight Capture:** Select text directly inside any swipe card to instantly append it into your composite staging box.
* **Live Composite Editor:** Dedicated text space at the top of the modal to edit, reorder, and polish merged text snippets in real time.
* **One-Click Commit:** Save your finished composite response directly back into your chat tree as a brand-new swipe.
* **Native Styling:** Fits directly into SillyTavern's default dark aesthetic.

---

## 🚀 Installation

1. Open **SillyTavern**.
2. Click the **Extensions** icon (puzzle piece) in the top panel.
3. Open the **Install Extension** tab.
4. Paste the repository URL:
   https://github.com/samanthadh/swipe-sculpt
5. Click **Install**.

---

## 📖 How to Use

1. Generate a few swipes on a message.
2. Open the **Swipe Sculpt** UI from your extension panel.
3. Browse the grid gallery of available swipes.
4. Highlight any line or paragraph across any swipe card—Swipe Sculpt automatically pulls the selected text into the **Composite** box.
5. Fine-tune your merged text in the Composite editor.
6. Click **Commit as new swipe** to append your custom creation back to the message history.

---

## 📁 File Structure

- `manifest.json` — Extension metadata and loader configuration
- `index.js` — Core extension logic and DOM handlers
- `style.css` — Extension modal and grid styling
- `CLAUDE.md` — Developer architecture brief
- `README.md` — User documentation

---

## 📄 License

[MIT](LICENSE)