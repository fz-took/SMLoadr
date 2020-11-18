module.exports = class NamingService {

    /**
     * @param {ConfigService} configService
     */
    constructor(configService) {
        this.configService = configService;
    }

    getConfig(type) {
        return this.configService.get('naming')[type];
    }

    /**
     * @param variables
     * @returns {string}
     */
    getPath(variables) {
        let name = this.getConfig('path');
        variables['albumName'] = this.getAlbumName(variables);

        for (let variableKey in variables) {
            name = name.replace('%' + variableKey + '%', variables[variableKey])
        }

        return name
    }

    /**
     * @param variables
     * @returns {string}
     */
    getDiscPath(variables) {
        let name = this.getConfig('discPath');
        variables['path'] = this.getPath(variables);

        for (let variableKey in variables) {
            name = name.replace('%' + variableKey + '%', variables[variableKey])
        }

        return name
    }

    /**
     * @param variables
     * @returns {string}
     */
    getAlbumName(variables) {
        let name = this.getConfig('albumName');

        for (let variableKey in variables) {
            name = name.replace('%' + variableKey + '%', variables[variableKey])
        }

        return name
    }

    /**
     * @param variables
     * @returns {string}
     */
    getFileName(variables) {
        let name = this.getConfig('fileName');

        for (let variableKey in variables) {
            name = name.replace('%' + variableKey + '%', variables[variableKey])
        }

        return name
    }
};