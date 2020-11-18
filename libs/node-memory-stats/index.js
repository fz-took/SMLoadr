const WindowsPlatform = require('./platforms/windows');
const LinuxPlatform = require('./platforms/linux');
const DarwinPlatform = require('./platforms/darwin');


function getMethods() {
    const classes = {
        'win32':   WindowsPlatform,
        'linux':   LinuxPlatform,
        'android': LinuxPlatform,
        'darwin':  DarwinPlatform
    };

    return classes[process.platform];
}

const methods = getMethods();

function total() {
    return methods.getTotalMemory();
}

function used() {
    return methods.getUsedMemory();
}

function free() {
    return methods.getFreeMemory();
}


module.exports = {total, used, free};
