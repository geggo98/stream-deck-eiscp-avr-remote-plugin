document.addEventListener('DOMContentLoaded', () => {
    // No track-change preview here: this dial shows the track permanently, and that
    // setting doubles as membership in the cooperating panel group.
    EiscpPI.renderDeviceIp('deviceIp', { trackChange: false });
    EiscpPI.buildCommandSelect(document.querySelector('[setting="command"]'), null);
    EiscpPI.buildCommandSelect(document.querySelector('[setting="pressCommand"]'), null);
    EiscpPI.setupCustomToggle('upParam', 'customUpParamItem');
    EiscpPI.setupCustomToggle('downParam', 'customDownParamItem');
    EiscpPI.setupCustomToggle('pressParam', 'customPressParamItem');
    EiscpPI.revealWhen(document.querySelector('[setting="showActionFeedback"]'), [
        document.getElementById('actionSecondsItem'),
        document.getElementById('actionOverCoverItem'),
    ]);
});
