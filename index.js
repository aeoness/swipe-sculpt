import { isChatSaving, updateSwipeCounter } from '../../../../script.js';

const MODULE_NAME = 'swipe-sculpt';

/**
 * The composite (scratch) buffer that grabbed fragments accumulate into.
 *
 * Deliberately module-level rather than owned by the modal. The brief calls for
 * this to become a persistent floating window that survives the modal closing,
 * so state kept inside the modal would have to be rewritten rather than moved.
 * The modal subscribes while it's open and unsubscribes when it closes; the
 * buffer itself outlives both.
 */
const compositeState = {
    /**
     * Grabbed fragments in order. The source of truth in blocks mode; each is
     * one draggable block.
     * @type {string[]}
     */
    segments: [],
    /**
     * The free-form text. The source of truth in text mode.
     * @type {string}
     */
    text: '',
    /** @type {'blocks'|'text'} */
    mode: 'text',
    /**
     * Where the next grabbed fragment lands in text mode. Mirrors the editor's
     * caret; null means "append at the end".
     * @type {number|null}
     */
    caret: null,
    /** @type {Set<() => void>} */
    listeners: new Set(),

    /**
     * The effective composite string, whichever mode is active. This is what
     * gets committed, and what the character count reflects.
     * @returns {string}
     */
    /**
     * The blocks joined with a single space, but only where the seam doesn't
     * already have whitespace — so fragments read naturally without double
     * spaces. Each grabbed fragment stays byte-exact; only the join adds
     * spacing. Mode-independent, so value() and setMode() agree on the bytes.
     * @returns {string}
     */
    joinedSegments() {
        if (this.segments.length === 0) {
            return '';
        }
        return this.segments.reduce((acc, seg) => {
            const needsSpace = acc.length > 0 && seg.length > 0
                && !/\s$/.test(acc) && !/^\s/.test(seg);
            return acc + (needsSpace ? ' ' : '') + seg;
        });
    },

    value() {
        return this.mode === 'blocks' ? this.joinedSegments() : this.text;
    },

    /**
     * A grab. In blocks mode it becomes a new block; in text mode it's inserted
     * at the tracked caret. No separator is ever added between fragments —
     * seams are the user's to smooth, and silently adding whitespace would
     * break the byte-for-byte guarantee that makes grabbing trustworthy.
     * @param {string} fragment
     */
    insert(fragment) {
        if (this.mode === 'blocks') {
            this.segments.push(fragment);
        } else {
            // Clamp: a stale caret (e.g. after Clear) must never index past end.
            const at = this.caret == null ? this.text.length : Math.min(this.caret, this.text.length);
            this.text = this.text.slice(0, at) + fragment + this.text.slice(at);
            this.caret = at + fragment.length;
        }
        this.emit();
    },

    /**
     * Records the text editor's caret so the next grab lands there. Doesn't
     * emit — it changes nothing the listeners render.
     * @param {number|null} position
     */
    setCaret(position) {
        this.caret = position;
    },

    /**
     * Free-form text edit (text mode only).
     * @param {string} value
     */
    setText(value) {
        this.text = value;
        this.emit();
    },

    /**
     * Reorders a block (blocks mode). Drag-and-drop calls this.
     * @param {number} from
     * @param {number} to
     */
    moveSegment(from, to) {
        if (from === to) {
            return;
        }
        const [moved] = this.segments.splice(from, 1);
        this.segments.splice(to, 0, moved);
        this.emit();
    },

    /**
     * Removes a block (blocks mode).
     * @param {number} index
     */
    removeSegment(index) {
        this.segments.splice(index, 1);
        this.emit();
    },

    /**
     * Appends a new (empty by default) block and returns its index, so the
     * caller can open it for editing straight away.
     * @param {string} [text]
     * @returns {number}
     */
    addSegment(text = '') {
        this.segments.push(text);
        this.emit();
        return this.segments.length - 1;
    },

    /**
     * Replaces a block's text (in-place editing).
     * @param {number} index
     * @param {string} text
     */
    updateSegment(index, text) {
        this.segments[index] = text;
        this.emit();
    },

    /**
     * Switches views. Blocks → Text flattens the blocks into one editable
     * string but keeps the blocks in reserve. Text → Blocks restores those
     * blocks untouched if the text wasn't edited (the common "just peeking"
     * round-trip); only if the text was actually changed does it collapse to a
     * single block, since freely edited prose can't be re-split into the
     * fragments it came from.
     * @param {'blocks'|'text'} next
     */
    setMode(next) {
        if (next === this.mode) {
            return;
        }
        if (next === 'text') {
            // Flatten using the same smart join value() uses, so the Text view
            // shows exactly what a blocks-mode commit would produce.
            this.text = this.joinedSegments();
            this.caret = this.text.length;
        } else if (this.text !== this.joinedSegments()) {
            // The text diverged from the blocks it came from, so it was edited:
            // collapse to one block. Otherwise leave `segments` as-is and the
            // original blocks come straight back.
            this.segments = this.text ? [this.text] : [];
        }
        this.mode = next;
        this.emit();
    },

    /** Empties everything. */
    clear() {
        this.segments = [];
        this.text = '';
        this.caret = null;
        this.emit();
    },

    /**
     * @param {() => void} listener
     * @returns {() => void} Unsubscribe function.
     */
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    },

    emit() {
        for (const listener of this.listeners) {
            listener();
        }
    },
};

/**
 * Serialises our chat saves.
 *
 * `saveChatConditional` waits only 1s (`debounce_timeout.relaxed`) for an
 * in-flight save to finish, then gives up with a console warning and no thrown
 * error — so a second save issued during the first is silently dropped, and the
 * caller can't tell. Large chats take well over a second to write, so two quick
 * edits used to lose one. Chaining guarantees we only ever ask for one at a time.
 * @type {Promise<void>}
 */
let savePromise = Promise.resolve();

/**
 * Waits for any save SillyTavern already has in flight to finish.
 *
 * Chaining our own saves isn't enough: ST saves on its own schedule too (chat
 * load, autosave), and `saveChatConditional` gives up after just 1s of waiting
 * — silently, with no thrown error. Committing shortly after loading a large
 * chat lands squarely in that window and the write vanishes. ST's other call
 * sites wait `debounce_timeout.extended` (5s) for the same flag, so waiting
 * longer here is in keeping with the codebase, not a hack around it.
 *
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} Whether ST went idle before the timeout.
 */
async function waitForSaveSlot(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (isChatSaving && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return !isChatSaving;
}

/**
 * Queues a chat save behind any save we've already requested.
 * @returns {Promise<void>} Resolves once this save has completed.
 * @throws If SillyTavern never went idle, so callers can surface the failure
 *   instead of reporting success on a write that never happened.
 */
function queueChatSave() {
    savePromise = savePromise
        // A failed save shouldn't poison every save that follows it.
        .catch(() => { })
        .then(async () => {
            if (!await waitForSaveSlot()) {
                throw new Error('SillyTavern was still saving; the write was not attempted.');
            }
            await SillyTavern.getContext().saveChat();
        });
    return savePromise;
}

/**
 * Collects every message that actually carries swipe data.
 * ST only draws swipe arrows on the last message, but `ensureSwipes()` in
 * script.js populates `swipes` on any non-user, non-system message — so the
 * data is there for the whole chat.
 * @returns {{ id: number, message: object }[]} Sculptable messages, in chat order.
 */
function getSculptableMessages() {
    const { chat } = SillyTavern.getContext();

    if (!Array.isArray(chat)) {
        return [];
    }

    return chat
        .map((message, id) => ({ id, message }))
        .filter(({ message }) => Array.isArray(message?.swipes) && message.swipes.length > 0);
}

/**
 * Writes an edited swipe back into the chat and persists it.
 *
 * Mirrors ST's own edit path (`messageEditDone` in script.js): the swipe text
 * and `message.mes` must agree whenever the edited swipe is the active one.
 * `swipe_info` is deliberately left alone — it records how a swipe was
 * generated, and hand-editing the text doesn't change that.
 *
 * @param {number} messageId Index of the message in the chat array.
 * @param {number} swipeIndex Which swipe to overwrite.
 * @param {string} newText The replacement text.
 */
/**
 * The single place `mes` is ever written.
 *
 * `mes` is what the chat displays AND what the prompt is built from, so if it
 * drifts from `swipes[swipe_id]` the model silently receives different text
 * than the user is reading — no error, no visual symptom. Every mutation
 * therefore ends here rather than assigning `mes` itself.
 *
 * @param {number} messageId Index of the message in the chat array.
 */
function syncActiveSwipe(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];

    // Clamp: a missing or out-of-range swipe_id (old/imported/malformed chats,
    // which this tool deliberately reaches into) would make mes = undefined and
    // then persist it. This is the single writer of mes, so repairing swipe_id
    // here is what makes the mes/swipes invariant actually safe.
    const id = Math.min(
        Math.max(Number(message.swipe_id ?? 0), 0),
        Math.max(0, (message.swipes?.length ?? 1) - 1));
    message.swipe_id = id;
    message.mes = message.swipes[id];

    // ST only keeps a window of recent messages in the DOM, and
    // `updateMessageBlock` throws on one that isn't rendered (it hands an empty
    // jQuery set to updateReasoningUI). Older messages need no refresh anyway —
    // there's nothing on screen to update.
    const isRendered = document.querySelector(`#chat .mes[mesid="${messageId}"]`) !== null;
    if (isRendered) {
        context.updateMessageBlock(messageId, message);
        // updateMessageBlock repaints the text but not the "n/m" swipe counter,
        // and `swipe.refresh()` only handles button visibility — this is the
        // call that actually rewrites the numbers under the message.
        updateSwipeCounter(messageId);
    }
}

/**
 * Writes an edited swipe back into the chat and persists it.
 *
 * Mirrors ST's own edit path (`messageEditDone` in script.js). `swipe_info` is
 * deliberately left alone — it records how a swipe was generated, and
 * hand-editing the text doesn't change that.
 *
 * @param {number} messageId Index of the message in the chat array.
 * @param {number} swipeIndex Which swipe to overwrite.
 * @param {string} newText The replacement text.
 */
async function saveSwipeEdit(messageId, swipeIndex, newText) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];

    // Honour the user's Trim Spaces preference, the same way ST's own editor
    // does — otherwise the two editors would disagree on trailing whitespace.
    const text = context.powerUserSettings.trim_spaces ? newText.trim() : newText;

    // Snapshot for rollback: if the save fails, memory must not keep an edit
    // that never reached disk.
    const previous = { swipe: message.swipes[swipeIndex], mes: message.mes };

    // Everything that mutates state lives inside the try, so a throw anywhere
    // (including syncActiveSwipe's DOM work) hits the same rollback.
    try {
        message.swipes[swipeIndex] = text;
        syncActiveSwipe(messageId);
        context.chatMetadata.tainted = true;
        await queueChatSave();
    } catch (error) {
        message.swipes[swipeIndex] = previous.swipe;
        message.mes = previous.mes;
        syncActiveSwipe(messageId);
        throw error;
    }
}

/**
 * Commits the composite as a brand new swipe at the end of the array.
 *
 * Appends rather than overwriting: the raw generations that the composite was
 * assembled from stay exactly where they were, visible in the grid beside the
 * assembled version. `swipe_info` grows in step, since ST expects the two
 * arrays to be the same length.
 *
 * @param {number} messageId Index of the message in the chat array.
 * @param {string} newText The composite text.
 * @returns {Promise<number>} The index of the newly created swipe.
 */
async function commitComposite(messageId, newText) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    const text = context.powerUserSettings.trim_spaces ? newText.trim() : newText;

    // Snapshot for rollback: if the save fails, we must not leave the message
    // displaying (and prompting from) a sculpted swipe that never reached disk.
    const previous = {
        swipes: [...message.swipes],
        swipeInfo: Array.isArray(message.swipe_info) ? [...message.swipe_info] : undefined,
        swipeId: message.swipe_id,
        mes: message.mes,
    };

    const newIndex = message.swipes.length;
    // All mutations inside the try, so any throw hits the rollback.
    try {
        message.swipes.push(text);

        if (!Array.isArray(message.swipe_info)) {
            message.swipe_info = [];
        }
        message.swipe_info[newIndex] = {
            send_date: new Date().toISOString(),
            // Null rather than copied: this swipe was assembled by hand, so there
            // is no generation to have started or finished. `sculpted` is what
            // marks it as hand-built in the grid.
            gen_started: null,
            gen_finished: null,
            extra: { sculpted: true },
        };

        message.swipe_id = newIndex;
        syncActiveSwipe(messageId);

        context.chatMetadata.tainted = true;
        await queueChatSave();
    } catch (error) {
        message.swipes = previous.swipes;
        message.swipe_info = previous.swipeInfo;
        message.swipe_id = previous.swipeId;
        message.mes = previous.mes;
        syncActiveSwipe(messageId);
        throw error;
    }
    return newIndex;
}

/**
 * Swaps a card's body into an editing textarea, and back again on save/cancel.
 * @param {HTMLElement} card The card being edited.
 * @param {object} message The owning chat message.
 * @param {number} messageId Its index in the chat array.
 * @param {number} index Which swipe this card represents.
 */
function beginEdit(card, message, messageId, index, query = '') {
    if (card.classList.contains('swipeSculptCard--editing')) {
        return;
    }
    // One pencil edit at a time — otherwise cancelling one clears the guard
    // while another stays open, re-opening the silent-loss hole it exists to close.
    if (swipeEditActive) {
        toastr.info('Finish the swipe edit you already have open first.', 'Swipe Sculpt');
        return;
    }
    card.classList.add('swipeSculptCard--editing');
    swipeEditActive = true;

    const body = card.querySelector('.swipeSculptCardBody');
    const textarea = document.createElement('textarea');
    textarea.classList.add('swipeSculptEditor', 'text_pole');
    textarea.value = message.swipes[index];

    const controls = document.createElement('div');
    controls.classList.add('swipeSculptEditControls');

    const saveButton = document.createElement('div');
    saveButton.classList.add('menu_button');
    saveButton.textContent = 'Save';

    const cancelButton = document.createElement('div');
    cancelButton.classList.add('menu_button');
    cancelButton.textContent = 'Cancel';

    const finish = () => {
        card.classList.remove('swipeSculptCard--editing');
        swipeEditActive = false;
        // Restore whichever view the card was showing before the edit started.
        renderCardBody(body, message, messageId, index, card.dataset.mode === 'source' ? 'source' : 'rendered', query);
        controls.remove();
    };

    saveButton.addEventListener('click', async () => {
        saveButton.classList.add('disabled');
        try {
            await saveSwipeEdit(messageId, index, textarea.value);
            finish();
        } catch (error) {
            console.error(`[${MODULE_NAME}] Failed to save swipe edit.`, error);
            toastr.error('Could not save the edit. Check the console.', 'Swipe Sculpt');
            saveButton.classList.remove('disabled');
        }
    });
    cancelButton.addEventListener('click', finish);

    controls.appendChild(saveButton);
    controls.appendChild(cancelButton);

    body.replaceChildren(textarea);
    card.appendChild(controls);
    textarea.focus();
}

/**
 * Renders a swipe into a card body, in one of two modes.
 *
 * `rendered` runs the text through ST's formatter — readable, but the markdown
 * syntax has become HTML structure, so text taken from it via the Selection API
 * comes back stripped of asterisks and with whitespace normalised.
 *
 * `source` puts the raw string in a textarea instead. That matters because a
 * textarea exposes `selectionStart`/`selectionEnd` as indices into the string
 * itself, so a fragment is `text.slice(start, end)` — byte-exact by
 * construction, with no serialisation step to mangle it.
 *
 * @param {HTMLElement} body The card body element.
 * @param {object} message The owning chat message.
 * @param {number} messageId Its index in the chat array.
 * @param {number} index Which swipe to render.
 * @param {'rendered'|'source'} mode
 */
/**
 * Wraps every case-insensitive occurrence of `query` inside `root` in a
 * <mark>, the way Ctrl+F highlights matches.
 *
 * Walks text nodes and splits them, rather than a regex over innerHTML, so it
 * never damages the surrounding markup. Matches that straddle an element
 * boundary (e.g. half inside an <em>) won't be caught — a rare case for the
 * plain-word searches this is for, and not worth the complexity of handling.
 * @param {HTMLElement} root
 * @param {string} query
 */
function highlightInElement(root, query) {
    const needle = query.toLowerCase();
    if (!needle) {
        return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        textNodes.push(node);
    }

    for (const textNode of textNodes) {
        const text = textNode.nodeValue;
        const haystack = text.toLowerCase();
        if (!haystack.includes(needle)) {
            continue;
        }
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        let hit = haystack.indexOf(needle);
        while (hit !== -1) {
            if (hit > cursor) {
                fragment.appendChild(document.createTextNode(text.slice(cursor, hit)));
            }
            const mark = document.createElement('mark');
            mark.className = 'swipeSculptMark';
            mark.textContent = text.slice(hit, hit + needle.length);
            fragment.appendChild(mark);
            cursor = hit + needle.length;
            hit = haystack.indexOf(needle, cursor);
        }
        if (cursor < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(cursor)));
        }
        textNode.parentNode.replaceChild(fragment, textNode);
    }
}

/**
 * @param {HTMLElement} body
 * @param {object} message
 * @param {number} messageId
 * @param {number} index
 * @param {'rendered'|'source'} mode
 * @param {string} query Search term to highlight in the rendered view.
 */
function renderCardBody(body, message, messageId, index, mode = 'rendered', query = '') {
    if (mode === 'source') {
        const source = document.createElement('textarea');
        source.classList.add('swipeSculptSource');
        // Read-only: this view exists for selecting, not editing. Editing still
        // goes through the pencil, which is the only path that writes. A plain
        // textarea can't style part of its text, so search highlighting only
        // applies to the rendered view above, not here.
        source.readOnly = true;
        source.value = message.swipes[index];
        body.replaceChildren(source);
        return;
    }

    const context = SillyTavern.getContext();
    body.innerHTML = context.messageFormatting(
        message.swipes[index],
        message.name,
        message.is_system,
        message.is_user,
        messageId,
    );
    if (query.trim()) {
        highlightInElement(body, query.trim());
    }
}

/**
 * Pulls the current selection out of a card's source textarea, verbatim.
 * @param {HTMLElement} card
 * @returns {string} The selected substring, or '' if nothing is selected.
 */
function getSelectedFragment(card) {
    const source = card.querySelector('.swipeSculptSource');
    if (!(source instanceof HTMLTextAreaElement)) {
        return '';
    }
    return source.value.slice(source.selectionStart, source.selectionEnd);
}

/**
 * Returns the plain text selected inside a card's rendered body, or '' if the
 * current selection isn't there. This is the browser's rendered text, with
 * markdown markers already stripped, so it is only trustworthy once mapped
 * back to the source — see resolveRenderedGrab.
 * @param {HTMLElement} card
 * @returns {string}
 */
function getRenderedSelection(card) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return '';
    }
    const body = card.querySelector('.swipeSculptCardBody');
    if (!body) {
        return '';
    }
    // Only honour a selection that actually lives inside this card's text.
    if (!body.contains(selection.getRangeAt(0).commonAncestorContainer)) {
        return '';
    }
    return selection.toString();
}

/**
 * Maps a rendered-view selection back to an exact slice of the source.
 *
 * The browser hands back rendered text with markdown stripped, so we look for
 * that text in the source and return the source slice. The match can only
 * succeed where the source is byte-identical to the selection — i.e. there was
 * no markdown inside it — so a successful grab is exact by construction. A
 * selection that crosses formatting won't be found; one that repeats is
 * ambiguous. Both fail here and the caller falls back to the code view, so a
 * wrong fragment is never grabbed silently.
 * @param {string} sourceText
 * @param {string} selectedText
 * @returns {{ok: true, fragment: string} | {ok: false, reason: 'empty'|'notfound'|'ambiguous'}}
 */
function resolveRenderedGrab(sourceText, selectedText) {
    if (!selectedText) {
        return { ok: false, reason: 'empty' };
    }
    const first = sourceText.indexOf(selectedText);
    if (first === -1) {
        return { ok: false, reason: 'notfound' };
    }
    if (sourceText.indexOf(selectedText, first + 1) !== -1) {
        return { ok: false, reason: 'ambiguous' };
    }
    return { ok: true, fragment: sourceText.slice(first, first + selectedText.length) };
}

/**
 * Builds the grid of swipe cards for one message.
 * @param {object} message The chat message to render swipes for.
 * @param {number} messageId Its index in the chat array.
 * @returns {HTMLElement} The grid container.
 */
function buildSwipeGrid(message, messageId, onChanged, query = '') {
    const swipes = message.swipes ?? [];
    const currentIndex = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
    // Match against source text (not rendered) so a search finds terms
    // regardless of how their markdown renders. Real indices are preserved:
    // skipped cards just aren't built, so a shown card keeps its true number.
    const q = query.trim().toLowerCase();

    const grid = document.createElement('div');
    grid.classList.add('swipeSculptGrid');

    swipes.forEach((swipeText, index) => {
        if (q && !swipeText.toLowerCase().includes(q)) {
            return;
        }
        const card = document.createElement('div');
        card.classList.add('swipeSculptCard');
        if (index === currentIndex) {
            card.classList.add('swipeSculptCard--current');
        }

        const header = document.createElement('div');
        header.classList.add('swipeSculptCardHeader');

        const label = document.createElement('span');
        label.classList.add('swipeSculptCardLabel');
        label.textContent = `Swipe ${index + 1} / ${swipes.length}`;
        header.appendChild(label);

        if (index === currentIndex) {
            const badge = document.createElement('span');
            badge.classList.add('swipeSculptBadge');
            badge.textContent = 'current';
            header.appendChild(badge);
        }

        // Written by commitComposite. A sculpted swipe was assembled by hand
        // rather than generated, which is worth seeing at a glance when the
        // grid is otherwise a wall of near-identical prose.
        if (message.swipe_info?.[index]?.extra?.sculpted) {
            card.classList.add('swipeSculptCard--sculpted');
            const badge = document.createElement('span');
            badge.classList.add('swipeSculptBadge', 'swipeSculptBadge--sculpted');
            badge.textContent = 'sculpted';
            badge.title = 'Assembled by hand in Swipe Sculpt, not generated';
            header.appendChild(badge);
        }

        const actions = document.createElement('div');
        actions.classList.add('swipeSculptCardActions');

        // The grab button works in both views now. In the code (source) view it
        // reads the textarea selection directly and shows a live character
        // count; in the rendered view it maps the browser selection back to the
        // source (see resolveRenderedGrab).
        const grabButton = document.createElement('div');
        grabButton.classList.add('swipeSculptGrabButton', 'menu_button');

        const updateGrabButton = () => {
            if (card.dataset.mode === 'source') {
                const fragment = getSelectedFragment(card);
                grabButton.textContent = fragment ? `Grab ${fragment.length}` : 'Select text';
                grabButton.classList.toggle('disabled', !fragment);
            } else {
                // The rendered selection lives in window.getSelection, which
                // isn't worth watching per-card, so the button stays a plain,
                // always-ready "Grab" and validates on click.
                grabButton.textContent = 'Grab';
                grabButton.classList.remove('disabled');
            }
        };

        const setMode = (next) => {
            card.dataset.mode = next;
            card.classList.toggle('swipeSculptCard--source', next === 'source');
            renderCardBody(body, message, messageId, index, next, query);
            updateGrabButton();
            if (next === 'source') {
                // Track the selection live so the button reflects what would
                // actually be grabbed.
                const source = card.querySelector('.swipeSculptSource');
                ['select', 'keyup', 'mouseup', 'focus'].forEach(
                    eventName => source.addEventListener(eventName, updateGrabButton));
            }
        };

        // Without this the button steals focus on press and the selection —
        // in the textarea or the rendered body — collapses before the click
        // handler can read it.
        grabButton.addEventListener('mousedown', (event) => event.preventDefault());
        grabButton.addEventListener('click', () => {
            // A grab mutates the composite; doing that while a block chip is open
            // in its editor would rebuild the chips and orphan the edit's index.
            if (blockEditActive) {
                toastr.info('Finish the block you are editing before grabbing.', 'Swipe Sculpt');
                return;
            }
            if (card.dataset.mode === 'source') {
                const fragment = getSelectedFragment(card);
                if (!fragment) {
                    return;
                }
                compositeState.insert(fragment);
                toastr.success(`Grabbed ${fragment.length} characters.`, 'Swipe Sculpt');
                return;
            }

            // Rendered view: resolve the selection to an exact source slice.
            const result = resolveRenderedGrab(message.swipes[index], getRenderedSelection(card));
            if (result.ok) {
                compositeState.insert(result.fragment);
                toastr.success(`Grabbed ${result.fragment.length} characters.`, 'Swipe Sculpt');
                return;
            }
            if (result.reason === 'empty') {
                toastr.info('Select some text in this swipe first.', 'Swipe Sculpt');
                return;
            }
            // Crosses formatting (not found) or repeats (ambiguous): drop to the
            // code view so it can be grabbed by exact position, not guesswork.
            setMode('source');
            toastr.info(result.reason === 'ambiguous'
                ? 'That text appears more than once. Select it here to grab the exact one.'
                : 'That selection includes formatting. Select it in this raw view to grab it exactly.',
            'Swipe Sculpt');
        });

        // Card starts in the rendered view, so give the button its label now.
        updateGrabButton();

        const sourceButton = document.createElement('div');
        sourceButton.classList.add('swipeSculptSourceButton', 'fa-solid', 'fa-code');
        sourceButton.title = 'Show raw text, so fragments can be selected exactly';
        sourceButton.addEventListener('click', () => {
            setMode(card.dataset.mode === 'source' ? 'rendered' : 'source');
        });

        const editButton = document.createElement('div');
        editButton.classList.add('swipeSculptEditButton', 'fa-solid', 'fa-pencil');
        editButton.title = 'Edit this swipe';
        editButton.addEventListener('click', () => beginEdit(card, message, messageId, index, query));

        // Two-step, like the other destructive controls: a deleted swipe is
        // gone, and the whole point of this tool is that swipes are expensive.
        const deleteButton = document.createElement('div');
        deleteButton.classList.add('swipeSculptDeleteButton', 'fa-solid', 'fa-trash-can');
        let deleteArmed = false;
        const isOnlySwipe = swipes.length <= 1;
        deleteButton.title = isOnlySwipe
            ? 'A message must keep at least one swipe'
            : 'Delete this swipe';
        deleteButton.classList.toggle('disabled', isOnlySwipe);

        deleteButton.addEventListener('click', async () => {
            if (isOnlySwipe) {
                toastr.info('A message must keep at least one swipe.', 'Swipe Sculpt');
                return;
            }
            if (swipeEditActive) {
                toastr.info('Finish or cancel the open swipe edit first.', 'Swipe Sculpt');
                return;
            }
            // This card's index is only trustworthy until another delete lands.
            if (mutationPending) {
                return;
            }
            if (!deleteArmed) {
                deleteArmed = true;
                deleteButton.classList.add('swipeSculptDeleteButton--armed');
                deleteButton.title = 'Click again to delete this swipe';
                return;
            }

            mutationPending = true;
            try {
                await deleteSwipeAt(messageId, index);
                toastr.success(`Deleted swipe ${index + 1}.`, 'Swipe Sculpt');
                onChanged();
            } catch (error) {
                console.error(`[${MODULE_NAME}] Failed to delete swipe.`, error);
                toastr.error('Could not delete the swipe. Check the console.', 'Swipe Sculpt');
                deleteArmed = false;
                deleteButton.classList.remove('swipeSculptDeleteButton--armed');
            } finally {
                mutationPending = false;
            }
        });

        actions.appendChild(grabButton);
        actions.appendChild(sourceButton);
        actions.appendChild(editButton);
        actions.appendChild(deleteButton);
        header.appendChild(actions);

        const body = document.createElement('div');
        body.classList.add('swipeSculptCardBody');

        card.dataset.mode = 'rendered';
        card.appendChild(header);
        card.appendChild(body);
        renderCardBody(body, message, messageId, index, 'rendered', query);
        grid.appendChild(card);
    });

    return grid;
}

/**
 * Builds the "which message am I looking at" dropdown.
 * @param {{ id: number, message: object }[]} targets
 * @param {number} selectedId
 * @param {(id: number) => void} onChange
 * @returns {HTMLElement}
 */
function buildMessagePicker(targets, selectedId, onChange) {
    const row = document.createElement('div');
    row.classList.add('swipeSculptPicker');

    const label = document.createElement('label');
    label.textContent = 'Message';
    label.htmlFor = 'swipeSculptMessageSelect';

    const select = document.createElement('select');
    select.id = 'swipeSculptMessageSelect';
    select.classList.add('text_pole');

    targets.forEach(({ id, message }) => {
        const option = document.createElement('option');
        option.value = String(id);
        option.selected = id === selectedId;
        const count = message.swipes.length;
        option.textContent = `#${id}: ${message.name ?? 'Unknown'} (${count} swipe${count === 1 ? '' : 's'})`;
        select.appendChild(option);
    });

    select.addEventListener('change', () => onChange(Number(select.value)));

    row.appendChild(label);
    row.appendChild(select);
    return row;
}

/**
 * True while a write that reshuffles swipe indices is in flight.
 *
 * Deleting is async, but the grid only rebuilds once it resolves — so a second
 * click landing in between would act on a card whose index has already moved,
 * and delete the wrong swipe. Observed in testing, caught only by luck because
 * the stale click happened to hit the last-swipe guard.
 */
let mutationPending = false;

/**
 * True while a swipe is open in the pencil editor. Commit and delete rebuild the
 * grid, which would silently discard that unsaved edit — so they refuse while
 * this is set. Reset whenever the grid rebuilds, so a rebuild that tears the
 * editor out some other way can't leave the flag stuck on.
 */
let swipeEditActive = false;

/**
 * True while a composite block chip is open in its inline editor. Grabbing (or
 * anything that mutates the segments) while a chip editor is focused would
 * rebuild the chips and orphan that editor's index — so grab refuses while this
 * is set. Cleared whenever an edit is confirmed or cancelled.
 */
let blockEditActive = false;

/**
 * Deletes one swipe from a message.
 *
 * The index arithmetic mirrors ST's own `deleteSwipe` exactly, but the display
 * update does not: ST finishes by calling `swipe()`, which animates the message
 * element and assumes it is on screen. Sculpt targets messages anywhere in the
 * chat, most of which aren't rendered, so it ends at the same guarded
 * `syncActiveSwipe` every other write here goes through.
 *
 * @param {number} messageId Index of the message in the chat array.
 * @param {number} swipeIndex Which swipe to remove.
 * @returns {Promise<number>} The swipe index that is active afterwards.
 */
async function deleteSwipeAt(messageId, swipeIndex) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];

    if (message.swipes.length <= 1) {
        throw new Error('Cannot delete the only remaining swipe.');
    }

    const currentIndex = Math.min(
        Math.max(Number(message.swipe_id ?? 0), 0),
        message.swipes.length - 1);

    // Snapshot for rollback if the save fails.
    const previous = {
        swipes: [...message.swipes],
        swipeInfo: Array.isArray(message.swipe_info) ? [...message.swipe_info] : undefined,
        swipeId: message.swipe_id,
        mes: message.mes,
    };

    // All mutations inside the try, so any throw hits the rollback.
    let newIndex;
    try {
        message.swipes.splice(swipeIndex, 1);
        if (Array.isArray(message.swipe_info) && message.swipe_info.length) {
            message.swipe_info.splice(swipeIndex, 1);
        }

        // Keep whatever was active still active. Removing an earlier swipe shifts
        // it down one; removing a later one leaves it alone; removing the active
        // swipe itself falls through to its neighbour.
        if (swipeIndex < currentIndex) {
            newIndex = currentIndex - 1;
        } else if (swipeIndex > currentIndex) {
            newIndex = currentIndex;
        } else {
            newIndex = Math.min(swipeIndex, message.swipes.length - 1);
        }

        message.swipe_id = newIndex;
        syncActiveSwipe(messageId);

        context.chatMetadata.tainted = true;
        await queueChatSave();
    } catch (error) {
        message.swipes = previous.swipes;
        message.swipe_info = previous.swipeInfo;
        message.swipe_id = previous.swipeId;
        message.mes = previous.mes;
        syncActiveSwipe(messageId);
        throw error;
    }

    // Announce the deletion only after it's persisted, so other extensions never
    // react to a delete we then rolled back. A throwing third-party listener
    // must not turn our successful delete into a reported failure.
    if (context.event_types?.MESSAGE_SWIPE_DELETED) {
        try {
            await context.eventSource.emit(context.event_types.MESSAGE_SWIPE_DELETED, {
                messageId,
                swipeId: swipeIndex,
                newSwipeId: newIndex,
            });
        } catch (error) {
            console.error(`[${MODULE_NAME}] A MESSAGE_SWIPE_DELETED listener threw.`, error);
        }
    }

    return newIndex;
}

/**
 * Builds the composite pane: a live, editable view of the scratch buffer.
 *
 * Renders `compositeState` rather than holding any text of its own, so the
 * buffer keeps outliving the modal. The standalone window this eventually
 * becomes will render the same state through the same contract.
 * @returns {{ element: HTMLElement, dispose: () => void }}
 */
function buildCompositePane(getTargetMessageId, onCommitted) {
    const pane = document.createElement('div');
    pane.classList.add('swipeSculptComposite');

    const header = document.createElement('div');
    header.classList.add('swipeSculptCompositeHeader');

    const title = document.createElement('span');
    title.classList.add('swipeSculptCompositeTitle');
    title.textContent = 'Composite';

    const count = document.createElement('span');
    count.classList.add('swipeSculptCompositeCount');

    // Blocks | Text view toggle.
    const modeToggle = document.createElement('div');
    modeToggle.classList.add('swipeSculptModeToggle');
    const blocksTab = document.createElement('div');
    blocksTab.classList.add('swipeSculptModeTab');
    blocksTab.textContent = 'Blocks';
    blocksTab.title = 'Arrange grabbed fragments as draggable blocks';
    const textTab = document.createElement('div');
    textTab.classList.add('swipeSculptModeTab');
    textTab.textContent = 'Text';
    textTab.title = 'Edit the whole composite as free text';
    blocksTab.addEventListener('click', () => compositeState.setMode('blocks'));
    textTab.addEventListener('click', () => compositeState.setMode('text'));
    modeToggle.append(blocksTab, textTab);
    const updateModeToggle = () => {
        blocksTab.classList.toggle('swipeSculptModeTab--active', compositeState.mode === 'blocks');
        textTab.classList.toggle('swipeSculptModeTab--active', compositeState.mode === 'text');
    };

    // Two-step, because a stray click here would throw away an entire stitch.
    const clearButton = document.createElement('div');
    clearButton.classList.add('menu_button', 'swipeSculptClearButton');
    let armed = false;
    const resetClearButton = () => {
        armed = false;
        clearButton.textContent = 'Clear';
        clearButton.classList.remove('swipeSculptClearButton--armed');
    };
    resetClearButton();
    clearButton.addEventListener('click', () => {
        if (!compositeState.value()) {
            return;
        }
        if (!armed) {
            armed = true;
            clearButton.textContent = 'Confirm Clear';
            clearButton.classList.add('swipeSculptClearButton--armed');
            return;
        }
        compositeState.clear();
        resetClearButton();
    });

    const commitButton = document.createElement('div');
    commitButton.classList.add('menu_button', 'swipeSculptCommitButton');
    let commitArmed = false;

    const resetCommitButton = () => {
        commitArmed = false;
        commitButton.textContent = 'Commit as New Swipe';
        commitButton.classList.remove('swipeSculptCommitButton--armed');
    };
    resetCommitButton();

    commitButton.addEventListener('click', async () => {
        if (swipeEditActive) {
            toastr.info('Finish or cancel the open swipe edit first.', 'Swipe Sculpt');
            return;
        }
        const context = SillyTavern.getContext();
        const messageId = getTargetMessageId();

        if (!compositeState.value().trim()) {
            toastr.info('Nothing to commit. The composite is empty.', 'Swipe Sculpt');
            return;
        }

        // Committing activates the new swipe, which rewrites what this message
        // says. On anything but the newest message, later replies were written
        // in response to the old text, so that gets a deliberate second step.
        const isLastMessage = messageId === context.chat.length - 1;
        if (!isLastMessage && !commitArmed) {
            commitArmed = true;
            commitButton.textContent = 'Commit — changes an older message?';
            commitButton.classList.add('swipeSculptCommitButton--armed');
            return;
        }

        if (mutationPending) {
            return;
        }

        mutationPending = true;
        commitButton.classList.add('disabled');
        try {
            const newIndex = await commitComposite(messageId, compositeState.value());
            toastr.success(`Committed as swipe ${newIndex + 1}.`, 'Swipe Sculpt');
            onCommitted();
        } catch (error) {
            console.error(`[${MODULE_NAME}] Failed to commit composite.`, error);
            toastr.error('Could not commit. Check the console.', 'Swipe Sculpt');
        } finally {
            mutationPending = false;
            commitButton.classList.remove('disabled');
            resetCommitButton();
        }
    });

    header.append(title, count, modeToggle, commitButton, clearButton);

    // The text-mode editor. Persistent (not rebuilt each render) so typing keeps
    // its caret; the value-guard in render only rewrites it on external changes.
    const editor = document.createElement('textarea');
    editor.classList.add('swipeSculptCompositeEditor', 'text_pole');
    editor.placeholder = 'Grabbed fragments land here.\n\nEdit freely. This is a scratch pad. Nothing reaches the chat until you commit it as a new swipe.';
    // Keep the tracked caret in sync with wherever the user's cursor actually
    // is, so a grab drops in there rather than always at the end. The textarea
    // keeps its selectionStart even while blurred (i.e. while the user is off
    // selecting text in a swipe card), so this stays accurate.
    const trackCaret = () => compositeState.setCaret(editor.selectionStart);
    ['keyup', 'click', 'mouseup', 'select', 'focus'].forEach(
        eventName => editor.addEventListener(eventName, trackCaret));
    editor.addEventListener('input', () => {
        compositeState.setText(editor.value);
        compositeState.setCaret(editor.selectionStart);
    });

    const bodyHost = document.createElement('div');
    bodyHost.classList.add('swipeSculptCompositeBody');

    // Which block index is being dragged, shared across one drag operation.
    let dragFrom = null;

    // Inline block-editing state, shared across a single edit.
    let editingIndex = null;
    let editingTextarea = null;
    let editingIsNew = false;
    let addButtonRef = null;

    const setAddButtonLabel = () => {
        if (!addButtonRef) {
            return;
        }
        const editing = editingIndex !== null;
        addButtonRef.textContent = editing ? 'Confirm' : '+ Add block';
        addButtonRef.classList.toggle('swipeSculptAddBlock--confirm', editing);
    };

    // Saves the block being edited (a blank block is kept) and closes it.
    const confirmEdit = () => {
        if (editingIndex === null) {
            return;
        }
        blockEditActive = false;
        const index = editingIndex;
        const value = editingTextarea ? editingTextarea.value : '';
        editingIndex = null;
        editingTextarea = null;
        editingIsNew = false;
        compositeState.updateSegment(index, value); // emits -> rebuild
    };

    // Abandons the edit. A brand-new block is removed (Escape = never mind);
    // an existing block reverts to its saved text.
    const cancelEdit = () => {
        if (editingIndex === null) {
            return;
        }
        blockEditActive = false;
        const index = editingIndex;
        const wasNew = editingIsNew;
        editingIndex = null;
        editingTextarea = null;
        editingIsNew = false;
        if (wasNew) {
            compositeState.removeSegment(index); // emits -> rebuild
        } else {
            compositeState.emit(); // rebuild from unchanged segments -> revert
        }
    };

    // Turns a block into an inline editor. Used by clicking a block's text and
    // by "+ Add block" (which opens the fresh block straight away, isNew=true).
    const enterEdit = (chip, index, isNew = false) => {
        if (editingIndex !== null) {
            return;
        }
        editingIndex = index;
        editingIsNew = isNew;
        blockEditActive = true;
        chip.classList.add('swipeSculptChip--editing');
        chip.draggable = false;
        // The × doubles as "cancel this edit" while editing (see its click
        // handler); just relabel it here.
        const del = chip.querySelector('.swipeSculptChipDelete');
        if (del) {
            del.title = 'Cancel edit';
        }

        const textSpan = chip.querySelector('.swipeSculptChipText');
        const textarea = document.createElement('textarea');
        textarea.classList.add('swipeSculptChipEditor', 'text_pole');
        textarea.value = compositeState.segments[index] ?? '';
        editingTextarea = textarea;

        // Clicking outside confirms. There's deliberately no Escape handling:
        // Escape belongs to the popup dialog (it closes the modal), so an edit is
        // cancelled with the block's × instead.
        textarea.addEventListener('blur', () => confirmEdit());

        textSpan.replaceWith(textarea);
        textarea.focus();
        setAddButtonLabel();
    };

    const buildChips = () => {
        const wrap = document.createElement('div');
        wrap.classList.add('swipeSculptBlocks');

        const list = document.createElement('div');
        list.classList.add('swipeSculptChips');
        if (compositeState.segments.length === 0) {
            const hint = document.createElement('div');
            hint.classList.add('swipeSculptChipsEmpty');
            hint.textContent = 'Grab fragments or add your own. Click a block to edit, drag to reorder, X to remove.';
            list.appendChild(hint);
        } else {
            compositeState.segments.forEach((segment, index) => {
                const chip = document.createElement('div');
                chip.classList.add('swipeSculptChip');
                chip.draggable = true;
                chip.dataset.index = String(index);

                const handle = document.createElement('span');
                handle.classList.add('swipeSculptChipHandle', 'fa-solid', 'fa-grip-vertical');

                const text = document.createElement('span');
                text.classList.add('swipeSculptChipText');
                if (segment === '') {
                    text.classList.add('swipeSculptChipText--empty');
                    text.textContent = 'click to add text';
                } else {
                    text.textContent = segment;
                }
                text.title = 'Click to edit this block';
                text.addEventListener('click', () => enterEdit(chip, index));

                const del = document.createElement('span');
                del.classList.add('swipeSculptChipDelete', 'fa-solid', 'fa-xmark');
                del.title = 'Remove this block';
                // Don't steal focus on press, so clicking × while editing doesn't
                // blur (and thereby confirm) the block before we can cancel it.
                del.addEventListener('mousedown', (event) => event.preventDefault());
                del.addEventListener('click', (event) => {
                    event.stopPropagation();
                    if (editingIndex === index) {
                        // The × of the block being edited cancels that edit
                        // (removes a new block, reverts an existing one).
                        cancelEdit();
                    } else {
                        // Deleting a *different* block: flush any in-progress edit
                        // to its correct index FIRST, before this removal shifts
                        // the list — otherwise the edit would save to the wrong
                        // block (or fail to display). Then delete.
                        if (editingIndex !== null) {
                            confirmEdit();
                        }
                        compositeState.removeSegment(index);
                    }
                });

                chip.addEventListener('dragstart', () => {
                    dragFrom = index;
                    chip.classList.add('swipeSculptChip--dragging');
                });
                chip.addEventListener('dragend', () => {
                    dragFrom = null;
                    list.querySelectorAll('.swipeSculptChip--over, .swipeSculptChip--dragging')
                        .forEach(c => c.classList.remove('swipeSculptChip--over', 'swipeSculptChip--dragging'));
                });
                chip.addEventListener('dragover', (event) => {
                    // preventDefault is what actually allows a drop to land here.
                    event.preventDefault();
                    if (dragFrom !== null && dragFrom !== index) {
                        chip.classList.add('swipeSculptChip--over');
                    }
                });
                chip.addEventListener('dragleave', () => chip.classList.remove('swipeSculptChip--over'));
                chip.addEventListener('drop', (event) => {
                    event.preventDefault();
                    chip.classList.remove('swipeSculptChip--over');
                    if (dragFrom !== null && dragFrom !== index) {
                        compositeState.moveSegment(dragFrom, index);
                    }
                });

                chip.append(handle, text, del);
                list.appendChild(chip);
            });
        }

        const addButton = document.createElement('div');
        addButton.classList.add('menu_button', 'swipeSculptAddBlock');
        addButton.title = 'Add a new block and type your own text';
        addButtonRef = addButton;
        setAddButtonLabel();
        // preventDefault so clicking Confirm doesn't blur the editor first — we
        // confirm explicitly here instead, avoiding a double save.
        addButton.addEventListener('mousedown', (event) => event.preventDefault());
        addButton.addEventListener('click', () => {
            if (editingIndex !== null) {
                confirmEdit();
                return;
            }
            const newIndex = compositeState.addSegment('');
            const newChip = bodyHost.querySelector(`.swipeSculptChip[data-index="${newIndex}"]`);
            if (newChip) {
                enterEdit(newChip, newIndex, true);
            }
        });

        wrap.append(list, addButton);
        return wrap;
    };

    const render = () => {
        const value = compositeState.value();
        count.textContent = `${value.length} characters`;
        updateModeToggle();
        if (!value) {
            resetClearButton();
        }

        if (compositeState.mode === 'text') {
            if (!bodyHost.contains(editor)) {
                bodyHost.replaceChildren(editor);
            }
            // Only rewrite the textarea when the change came from elsewhere;
            // doing it mid-type would reset the caret.
            if (editor.value !== value) {
                editor.value = value;
                const caret = compositeState.caret == null ? value.length : compositeState.caret;
                editor.selectionStart = editor.selectionEnd = caret;
                if (caret === value.length) {
                    editor.scrollTop = editor.scrollHeight;
                }
            }
        } else {
            bodyHost.replaceChildren(buildChips());
        }
    };

    const dispose = compositeState.subscribe(render);
    render();

    pane.append(header, bodyHost);
    return { element: pane, dispose };
}

/**
 * Opens the Sculpt modal.
 * @param {number} [messageId] Message to open on. Defaults to the last sculptable one.
 */
async function showSwipeSculpt(messageId) {
    const context = SillyTavern.getContext();
    const targets = getSculptableMessages();

    if (targets.length === 0) {
        toastr.info('No messages with swipe data in this chat yet.', 'Swipe Sculpt');
        return;
    }

    let activeId = targets.some(t => t.id === messageId)
        ? messageId
        : targets[targets.length - 1].id;
    let searchQuery = '';

    const wrapper = document.createElement('div');
    wrapper.classList.add('swipeSculptModal');

    const gridHost = document.createElement('div');

    // Search row: filters the grid to swipes whose source contains the query.
    const searchRow = document.createElement('div');
    searchRow.classList.add('swipeSculptSearch');
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.classList.add('text_pole');
    searchInput.placeholder = 'Search swipes…';
    const searchCount = document.createElement('span');
    searchCount.classList.add('swipeSculptSearchCount');
    searchRow.append(searchInput, searchCount);

    const updateSearchCount = (shown, total) => {
        searchCount.textContent = searchQuery.trim()
            ? `showing ${shown} of ${total}`
            : `${total} swipe${total === 1 ? '' : 's'}`;
    };

    // Debounced so typing on an 80-swipe message doesn't re-render the whole
    // grid on every keystroke.
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            searchQuery = searchInput.value;
            renderGrid();
        }, 150);
    });

    // Deleting shifts every index after it, so the grid and the picker's swipe
    // counts both have to be rebuilt from the current chat state.
    const refreshAll = () => {
        targets.length = 0;
        targets.push(...getSculptableMessages());
        renderPicker();
        renderGrid();
    };

    const renderGrid = () => {
        // Any grid rebuild tears out an open pencil editor, so clear the guard
        // here — this covers the empty-search and no-target early returns too,
        // which never reach buildSwipeGrid and would otherwise soft-lock it on.
        swipeEditActive = false;
        const target = targets.find(t => t.id === activeId);
        if (!target) {
            gridHost.replaceChildren();
            updateSearchCount(0, 0);
            return;
        }
        const swipes = target.message.swipes ?? [];
        const q = searchQuery.trim().toLowerCase();
        const shown = q ? swipes.filter(s => s.toLowerCase().includes(q)).length : swipes.length;
        updateSearchCount(shown, swipes.length);

        if (q && shown === 0) {
            const empty = document.createElement('div');
            empty.classList.add('swipeSculptEmpty');
            empty.textContent = `No swipes on this message contain “${searchQuery.trim()}”.`;
            gridHost.replaceChildren(empty);
            return;
        }
        gridHost.replaceChildren(buildSwipeGrid(target.message, target.id, refreshAll, searchQuery));
    };

    const pickerHost = document.createElement('div');
    const renderPicker = () => {
        pickerHost.replaceChildren(buildMessagePicker(targets, activeId, (id) => {
            activeId = id;
            renderGrid();
        }));
    };
    wrapper.appendChild(pickerHost);
    renderPicker();

    const composite = buildCompositePane(() => activeId, refreshAll);
    wrapper.appendChild(composite.element);

    wrapper.appendChild(searchRow);
    wrapper.appendChild(gridHost);
    renderGrid();

    await context.callGenericPopup(wrapper, context.POPUP_TYPE.TEXT, '', {
        // `wide` only reaches --sheldWidth (~500px), which collapses the grid to
        // a single column. `wider` starts at 750px and scales with the viewport.
        wider: true,
        large: true,
        allowVerticalScrolling: true,
    });

    // The buffer survives the modal; only this view of it goes away.
    composite.dispose();
}

function addWandButton() {
    const container = document.getElementById('extensionsMenu');
    if (!(container instanceof HTMLElement)) {
        console.warn(`[${MODULE_NAME}] Extensions menu not found, skipping wand button.`);
        return;
    }

    const button = document.createElement('div');
    button.id = 'swipe_sculpt_wand_button';
    button.classList.add('list-group-item', 'flex-container', 'flexGap5');

    const icon = document.createElement('div');
    icon.classList.add('fa-solid', 'fa-layer-group', 'extensionsMenuExtensionButton');

    const text = document.createElement('span');
    text.textContent = 'Swipe Sculpt';

    button.appendChild(icon);
    button.appendChild(text);
    button.addEventListener('click', () => showSwipeSculpt());

    container.appendChild(button);
}

(function init() {
    const { eventSource, event_types } = SillyTavern.getContext();

    // Debug handle. Also the seam the standalone composite window will attach
    // to, since it will need to reach this state from outside the modal.
    globalThis.swipeSculpt = { compositeState };

    if (document.getElementById('extensionsMenu')) {
        addWandButton();
        return;
    }

    // The menu is built as part of app startup, so retry once it's ready.
    eventSource.once(event_types.APP_READY, addWandButton);
})();
