const exec = require('child_process').execSync;

module.exports = class Windows {
    static getTotalMemory() {
        return parseInt(exec('wmic OS get TotalVisibleMemorySize /value', {'encoding': 'utf8'}).trim().split('=')[1], 10) * 1024;
    }

    static getUsedMemory() {
        return this.getTotalMemory() - this.getFreeMemory();
    }

    static getFreeMemory() {
        return parseInt(exec('wmic OS get FreePhysicalMemory /value', {'encoding': 'utf8'}).trim().split('=')[1], 10) * 1024;
    }
};
