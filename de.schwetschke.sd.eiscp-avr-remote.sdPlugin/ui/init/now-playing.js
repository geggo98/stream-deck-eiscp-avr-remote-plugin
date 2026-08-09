document.addEventListener('DOMContentLoaded', () => {
    // No track-change preview here: this key already shows the track, and the shared
    // setting would paint a different face over it for a few seconds once per song.
    EiscpPI.renderDeviceIp('deviceIp', { trackChange: false });
    EiscpPI.revealWhenValue(document.querySelector('[setting="textMode"]'), 'onChange', [
        document.getElementById('textSecondsItem'),
    ]);
    migrateGlyphSetting();
});

/**
 * Show the truth about a key configured before the glyph became a three-way choice.
 *
 * Those keys store `showGlyph: false`, which the plugin still honours as "never". The
 * new dropdown would otherwise open on its own default and claim "Only when there is no
 * cover" while the key draws no glyph at all — a panel disagreeing with the key it
 * configures. Writing the value through settles it: the old flag becomes the new one,
 * once, the first time somebody looks.
 *
 * Deliberately after a settle rather than immediately: the component loads its own value
 * asynchronously, and a write that beat it would be overwritten. `undefined` after the
 * settle means the setting genuinely is not there.
 */
function migrateGlyphSetting() {
    const select = document.querySelector('[setting="glyphMode"]');
    if (!select || !window.SDPIComponents) return;
    try {
        SDPIComponents.streamDeckClient
            .getSettings()
            .then((payload) => {
                const settings = (payload && (payload.settings || payload)) || {};
                if (settings.showGlyph !== false) return;
                setTimeout(() => {
                    if (select.value === undefined || select.value === null) select.value = 'never';
                }, 500);
            })
            .catch(() => {
                /* nothing to migrate that is worth an error */
            });
    } catch (e) {
        /* sdpi client not ready; the dropdown still works, it just shows its default */
    }
}
