const exec = require('child_process').execSync;

module.exports = class Darwin {
    static getTotalMemory() {
        return parseInt(exec('sysctl -n hw.memsize', {'encoding': 'utf8'}), 10);
    }

    static getUsedMemory() {
        const memoryTypes = ['active', 'wired down', 'inactive'];
        const pageSize = this.getPageSize();
        let totalMemoryUsed = 0;

        memoryTypes.forEach((memoryType) => {
            totalMemoryUsed += this.getMemoryTypeUsage(memoryType);
        });

        return (totalMemoryUsed * pageSize);
    }

    static getFreeMemory() {
        return this.getTotalMemory() - this.getUsedMemory();
    }

    static getPageSize() {
        return parseInt(exec('sysctl -n hw.pagesize', {'encoding': 'utf8'}), 10);
    }

    static getMemoryTypeUsage(memoryType) {
        let position = 3;

        if (1 < memoryType.split(' ').length) {
            position = 4;
        }

        return parseInt(exec(`vm_stat | grep 'Pages ${memoryType}:' | awk '{print $${position}}'`, {'encoding': 'utf8'}), 10);
    }
};
