document.addEventListener('DOMContentLoaded', () => {
    EiscpPI.renderDeviceIp('deviceIp');
    EiscpPI.buildCommandSelect(document.querySelector('[setting="command"]'), null);
    EiscpPI.buildCommandSelect(document.querySelector('[setting="pressCommand"]'), null);
    EiscpPI.setupCustomToggle('upParam', 'customUpParamItem');
    EiscpPI.setupCustomToggle('downParam', 'customDownParamItem');
    EiscpPI.setupCustomToggle('pressParam', 'customPressParamItem');
});
