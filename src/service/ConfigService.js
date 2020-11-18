const nodeJsonFile = require('jsonfile');

module.exports = class ConfigService {

    constructor(configFile) {
        this.configFile = configFile;

        this.config = {
            "arl": ""
        };

        this.loadConfig();
        this.saveConfig();
    }

    loadConfig() {
        let configFileContent = this.config;
        try {
            configFileContent = nodeJsonFile.readFileSync(this.configFile);
        } catch (e) {
            return this.config;
        }

        Object.entries(configFileContent).forEach(([key, value]) => {
            this.config[key] = value;
        });

        return this.config;
    }

    saveConfig() {
        nodeJsonFile.writeFileSync(this.configFile, this.config, {spaces: 4, EOL: '\r\n'});
    }

    set(key, value) {
        this.config[key] = value
    }

    get(key) {
        if (typeof key === 'undefined') {
            return this.config;
        }

        return this.config[key];
    }
};