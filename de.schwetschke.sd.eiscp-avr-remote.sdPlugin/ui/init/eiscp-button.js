document.addEventListener('DOMContentLoaded', () => {
    EiscpPI.renderDeviceIp('deviceIp');
    const cmdSel = document.querySelector('[setting="command"]');
    EiscpPI.buildCommandSelect(cmdSel, null);

    // When "custom" is chosen, offer the selected command's real values.
    const customSel = document.querySelector('[setting="customParameter"]');
    const rebuildCustom = () => EiscpPI.buildParamSelect(customSel, cmdSel.value, null);
    cmdSel.addEventListener('valuechange', rebuildCustom);
    setTimeout(rebuildCustom, 250);

    EiscpPI.setupCustomToggle('parameter', 'customParameterItem');
});
