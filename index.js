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
    /** @type {string} */
    text: '',
    /** @type {Set<(text: string) => void>} */
    listeners: new Set(),

    /**
     * Appends a fragment verbatim. No separator is inserted — seams are the
     * user's to smooth, and silently adding whitespace would break the
     * byte-for-byte guarantee that makes grabbing trustworthy.
     * @param {string} fragment
     */
    append(fragment) {
        this.text += fragment;
        this.emit();
    },

    /** @param {string} value */
    set(value) {
        this.text = value;
        this.emit();
    },

    /**
     * @param {(text: string) => void} listener
     * @returns {() => void} Unsubscribe function.
     */
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    },

    emit() {
        for (const listener of this.listeners) {
            listener(this.text);
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

    message.mes = message.swipes[message.swipe_id];

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

    message.swipes[swipeIndex] = text;
    syncActiveSwipe(messageId);

    context.chatMetadata.tainted = true;
    await queueChatSave();
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

    const newIndex = message.swipes.length;
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
    return newIndex;
}

/**
 * Swaps a card's body into an editing textarea, and back again on save/cancel.
 * @param {HTMLElement} card The card being edited.
 * @param {object} message The owning chat message.
 * @param {number} messageId Its index in the chat array.
 * @param {number} index Which swipe this card represents.
 */
function beginEdit(card, message, messageId, index) {
    if (card.classList.contains('swipeSculptCard--editing')) {
        return;
    }
    card.classList.add('swipeSculptCard--editing');

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
        // Restore whichever view the card was showing before the edit started.
        renderCardBody(body, message, messageId, index, card.dataset.mode === 'source' ? 'source' : 'rendered');
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
function renderCardBody(body, message, messageId, index, mode = 'rendered') {
    if (mode === 'source') {
        const source = document.createElement('textarea');
        source.classList.add('swipeSculptSource');
        // Read-only: this view exists for selecting, not editing. Editing still
        // goes through the pencil, which is the only path that writes.
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
 * Builds the grid of swipe cards for one message.
 * @param {object} message The chat message to render swipes for.
 * @param {number} messageId Its index in the chat array.
 * @returns {HTMLElement} The grid container.
 */
function buildSwipeGrid(message, messageId, onChanged) {
    const swipes = message.swipes ?? [];
    const currentIndex = typeof message.swipe_id === 'number' ? message.swipe_id : 0;

    const grid = document.createElement('div');
    grid.classList.add('swipeSculptGrid');

    swipes.forEach((swipeText, index) => {
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

        // Only meaningful in source view, where an exact selection is possible.
        // Shown at all times in rendered view, it just told people to select
        // text they had in fact already selected — the selection was in the
        // rendered HTML, which this deliberately refuses to read.
        const grabButton = document.createElement('div');
        grabButton.classList.add('swipeSculptGrabButton', 'menu_button');
        grabButton.hidden = true;

        const updateGrabButton = () => {
            const fragment = getSelectedFragment(card);
            grabButton.textContent = fragment
                ? `Grab ${fragment.length}`
                : 'Select text';
            grabButton.classList.toggle('disabled', !fragment);
        };

        // Without this the button steals focus on press and the textarea's
        // selection collapses before the click handler ever runs.
        grabButton.addEventListener('mousedown', (event) => event.preventDefault());
        grabButton.addEventListener('click', () => {
            const fragment = getSelectedFragment(card);
            if (!fragment) {
                return;
            }
            compositeState.append(fragment);
            toastr.success(`Grabbed ${fragment.length} characters.`, 'Swipe Sculpt');
        });

        const sourceButton = document.createElement('div');
        sourceButton.classList.add('swipeSculptSourceButton', 'fa-solid', 'fa-code');
        sourceButton.title = 'Show raw text, so fragments can be selected exactly';
        sourceButton.addEventListener('click', () => {
            const next = card.dataset.mode === 'source' ? 'rendered' : 'source';
            card.dataset.mode = next;
            card.classList.toggle('swipeSculptCard--source', next === 'source');
            renderCardBody(body, message, messageId, index, next);

            grabButton.hidden = next !== 'source';
            if (next === 'source') {
                updateGrabButton();
                // Track the selection live so the button always reflects what
                // would actually be grabbed.
                const source = card.querySelector('.swipeSculptSource');
                ['select', 'keyup', 'mouseup', 'focus'].forEach(
                    eventName => source.addEventListener(eventName, updateGrabButton));
            }
        });

        const editButton = document.createElement('div');
        editButton.classList.add('swipeSculptEditButton', 'fa-solid', 'fa-pencil');
        editButton.title = 'Edit this swipe';
        editButton.addEventListener('click', () => beginEdit(card, message, messageId, index));

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
        renderCardBody(body, message, messageId, index, 'rendered');
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
        option.textContent = `#${id} — ${message.name ?? 'Unknown'} (${count} swipe${count === 1 ? '' : 's'})`;
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

    message.swipes.splice(swipeIndex, 1);
    if (Array.isArray(message.swipe_info) && message.swipe_info.length) {
        message.swipe_info.splice(swipeIndex, 1);
    }

    // Keep whatever was active still active. Removing an earlier swipe shifts
    // it down one; removing a later one leaves it alone; removing the active
    // swipe itself falls through to its neighbour.
    let newIndex;
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

    // Other extensions listen for this; deleting quietly would leave them stale.
    if (context.event_types?.MESSAGE_SWIPE_DELETED) {
        await context.eventSource.emit(context.event_types.MESSAGE_SWIPE_DELETED, {
            messageId,
            swipeId: swipeIndex,
            newSwipeId: newIndex,
        });
    }

    await queueChatSave();
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

    // Two-step, because a grab can't be undone and a stray click here would
    // throw away an entire stitch.
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
        if (!compositeState.text) {
            return;
        }
        if (!armed) {
            armed = true;
            clearButton.textContent = 'Clear — sure?';
            clearButton.classList.add('swipeSculptClearButton--armed');
            return;
        }
        compositeState.set('');
        resetClearButton();
    });

    const commitButton = document.createElement('div');
    commitButton.classList.add('menu_button', 'swipeSculptCommitButton');
    let commitArmed = false;

    const resetCommitButton = () => {
        commitArmed = false;
        commitButton.textContent = 'Commit as new swipe';
        commitButton.classList.remove('swipeSculptCommitButton--armed');
    };
    resetCommitButton();

    commitButton.addEventListener('click', async () => {
        const context = SillyTavern.getContext();
        const messageId = getTargetMessageId();

        if (!compositeState.text.trim()) {
            toastr.info('Nothing to commit — the composite is empty.', 'Swipe Sculpt');
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
            const newIndex = await commitComposite(messageId, compositeState.text);
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

    header.append(title, count, commitButton, clearButton);

    const editor = document.createElement('textarea');
    editor.classList.add('swipeSculptCompositeEditor', 'text_pole');
    editor.placeholder = 'Grabbed fragments land here.\n\nEdit freely — this is a scratch pad. Nothing reaches the chat until you commit it as a new swipe.';
    editor.addEventListener('input', () => compositeState.set(editor.value));

    const render = (text) => {
        // Only touch the textarea when the change came from somewhere else;
        // rewriting it while the user types would reset their caret.
        if (editor.value !== text) {
            editor.value = text;
            editor.scrollTop = editor.scrollHeight;
        }
        count.textContent = `${text.length} characters`;
        if (!text) {
            resetClearButton();
        }
    };

    const dispose = compositeState.subscribe(render);
    render(compositeState.text);

    pane.append(header, editor);
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

    const wrapper = document.createElement('div');
    wrapper.classList.add('swipeSculptModal');

    const gridHost = document.createElement('div');

    // Deleting shifts every index after it, so the grid and the picker's swipe
    // counts both have to be rebuilt from the current chat state.
    const refreshAll = () => {
        targets.length = 0;
        targets.push(...getSculptableMessages());
        renderPicker();
        renderGrid();
    };

    const renderGrid = () => {
        const target = targets.find(t => t.id === activeId);
        if (!target) {
            gridHost.replaceChildren();
            return;
        }
        gridHost.replaceChildren(buildSwipeGrid(target.message, target.id, refreshAll));
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
