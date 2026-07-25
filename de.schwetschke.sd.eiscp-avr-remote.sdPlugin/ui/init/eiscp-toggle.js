document.addEventListener('DOMContentLoaded', () => {
    EiscpPI.renderDeviceIp('deviceIp');
    EiscpPI.buildCommandSelect(document.querySelector('[setting="command"]'), null);
    EiscpPI.setupCustomToggle('onValue', 'customOnValueItem');
    EiscpPI.setupCustomToggle('offValue', 'customOffValueItem');
});
