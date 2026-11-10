/**
 * Operator-facing copy for the machine-readable config reasons (M0).
 *
 * Why: the refusal vocabulary is data, not prose - `lib/effectiveConfig.js` emits codes like
 * `unknown-key:features.watchLater`, and since C135 a refused layer is dropped **whole**, so a person
 * who saved one stale checkbox can lose every edit in the store and see nothing but a channel that
 * quietly reverted. The GATE T8 row says every pipeline failure must be refused with a
 * machine-readable reason; an operator still has to be told what to do about it, in their language,
 * with the machine-readable detail kept visible because it is what they paste into a support message.
 *
 * Rule this module follows: a code without an entry is reported verbatim, never smoothed over.
 * `tests/unit/test-configStore-write-path.mjs` pins that, plus that no entry is a placeholder.
 */

const detail = (reason, prefix) => (reason.startsWith(prefix) ? reason.slice(prefix.length).trim() : '');

const CATALOGUE = [
    {
        code: 'unknown-key',
        copy: (d) =>
            `“${d}” is not a setting the television reads, so nothing was saved. Delete that entry, or set the field the setup guide names.`
    },
    {
        code: 'missing-required',
        copy: (d) =>
            `“${d}” is required and is empty. Fill it in and save again - a channel without it cannot be built.`
    },
    {
        code: 'invalid-type',
        copy: (d) =>
            `“${d}” holds a value of the wrong kind (for example words where a number, true/false or a 0xRRGGBB colour belongs). Nothing was saved.`
    },
    {
        code: 'store-rejected',
        copy: () =>
            'The saved channel settings were refused in full, so the television is still running the last settings that passed. Fix the reason named above and save again.'
    },
    {
        code: 'store-not-an-object',
        copy: () =>
            'The channel settings file does not hold a list of settings, so nothing was changed. It usually needs restoring from a backup.'
    },
    {
        code: 'store-unreadable',
        copy: (d) => `The channel settings file could not be read (${d || 'no detail'}). Nothing was changed.`
    },
    {
        code: 'profile-rejected',
        copy: () =>
            'This server’s own channel profile holds a setting the contract does not know, so that layer was skipped. The deploy that set it needs fixing.'
    },
    {
        code: 'feed-rejected',
        copy: () =>
            'The settings block that came with the content feed was refused, so the television kept the ones from the server. The producer is emitting a key the contract does not know.'
    },
    {
        code: 'no-config-layer',
        copy: () =>
            'No channel settings passed validation, so the television is running on its built-in defaults. Fix or restore the settings file.'
    },
    {
        code: 'invalid-effective-config',
        copy: (d) =>
            `The settings a television would receive are incomplete or wrong (${d || 'no detail'}). They were not served.`
    },
    {
        code: 'schema-drift',
        copy: (d) =>
            `Two copies of the channel contract disagree (${d || 'no detail'}). Deploy the matching build of the app and the server before saving again.`
    },
    {
        code: 'schema-copy-unreadable',
        copy: (d) => `The channel contract file could not be read (${d || 'no detail'}). This install is incomplete.`
    }
];

function copyFor(reason) {
    const text = String(reason || '');
    for (const entry of CATALOGUE) {
        const prefix = `${entry.code}:`;
        if (text.startsWith(prefix)) return entry.copy(detail(text, prefix));
        if (text === entry.code) return entry.copy('');
    }
    // No entry, no euphemism: the code is the message.
    return `The channel settings were refused: ${text}. Quote this line when you ask for help.`;
}

/** One line per distinct reason, machine-readable detail intact, in the order the gate reported them. */
function summary(reasons) {
    const seen = new Set();
    const lines = [];
    for (const reason of reasons || []) {
        if (!reason || seen.has(reason)) continue;
        seen.add(reason);
        lines.push(`${copyFor(reason)} [${reason}]`);
    }
    return lines;
}

module.exports = { CATALOGUE, copyFor, summary };
