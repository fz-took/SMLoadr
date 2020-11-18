const exec = require('child_process').execSync;

module.exports = class Linux {
    static getTotalMemory() {
        return parseInt(exec('free -b | grep "Mem:" | awk \'{print $2}\'', {'encoding': 'utf8'}), 10);
    }

    static getUsedMemory() {
        return parseInt(exec('free -b | grep "Mem:" | awk \'{print $7}\'', {'encoding': 'utf8'}), 10);
    }

    static getFreeMemory() {
        return this.getTotalMemory() - this.getUsedMemory();
    }
};
