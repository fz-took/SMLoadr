const Promise = require('bluebird');
const chalk = require('chalk');
const ora = require('ora');
const sanitize = require('sanitize-filename');
const cacheManager = require('cache-manager');
require('./node_modules/cache-manager/lib/stores/memory');
const requestPlus = require('request-plus');
const id3Writer = require('./libs/browser-id3-writer');
const flacMetadata = require('./libs/flac-metadata');
const inquirer = require('inquirer');
const fs = require('fs');
const stream = require('stream');
const nodePath = require('path');
const memoryStats = require('./libs/node-memory-stats');
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');
const openUrl = require('openurl');
const packageJson = require('./package.json');
const winston = require('winston');

const configFile = 'SMLoadrConfig.json';
const ConfigService = require('./src/service/ConfigService');
let configService = new ConfigService(configFile);

const EncryptionService = require('./src/service/EncryptionService');
let encryptionService = new EncryptionService();

let DOWNLOAD_DIR = 'DOWNLOADS/';
let PLAYLIST_DIR = 'PLAYLISTS/';
let PLAYLIST_FILE_ITEMS = {};

let DOWNLOAD_LINKS_FILE = 'downloadLinks.txt';
let DOWNLOAD_MODE = 'single';

const musicQualities = {
    MP3_128: {
        id: 1,
        name: 'MP3 - 128 kbps',
        aproxMaxSizeMb: '100'
    },
    MP3_320: {
        id: 3,
        name: 'MP3 - 320 kbps',
        aproxMaxSizeMb: '200'
    },
    FLAC: {
        id: 9,
        name: 'FLAC - 1411 kbps',
        aproxMaxSizeMb: '700'
    },
    MP3_MISC: {
        id: 0,
        name: 'User uploaded song'
    }
};

let selectedMusicQuality = musicQualities.MP3_320;

const cliOptionDefinitions = [
    {
        name: 'help',
        alias: 'h',
        description: 'Print this usage guide :)'
    },
    {
        name: 'quality',
        alias: 'q',
        type: String,
        defaultValue: 'MP3_320',
        description: 'The quality of the files to download: MP3_128/MP3_320/FLAC'
    },
    {
        name:         'path',
        alias:        'p',
        type:         String,
        defaultValue: DOWNLOAD_DIR,
        description:  'The path to download the files to: path with / in the end'
    },
    {
        name: 'url',
        alias: 'u',
        type: String,
        defaultOption: true,
        description: 'Downloads single deezer url: album/artist/playlist/profile/track url'
    },
    {
        name: 'downloadmode',
        alias: 'd',
        type: String,
        defaultValue: 'single',
        description: 'Downloads multiple urls from list: "all" for downloadLinks.txt'
    }
];

let cliOptions;
const isCli = process.argv.length > 2;

const downloadSpinner = new ora({
    spinner: {
        interval: 400,
        frames: [
            '♫',
            ' '
        ]
    },
    color: 'white'
});

const unofficialApiUrl = 'https://www.deezer.com/ajax/gw-light.php';
const ajaxActionUrl = 'https://www.deezer.com/ajax/action.php';

let unofficialApiQueries = {
    api_version: '1.0',
    api_token: '',
    input: 3
};

let httpHeaders;
let requestWithoutCache;
let requestWithoutCacheAndRetry;
let requestWithCache;

function initRequest() {
    httpHeaders = {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.121 Safari/537.36',
        'cache-control': 'max-age=0',
        'accept-language': 'en-US,en;q=0.9,en-US;q=0.8,en;q=0.7',
        'accept-charset': 'utf-8,ISO-8859-1;q=0.8,*;q=0.7',
        'content-type': 'text/plain;charset=UTF-8',
        'cookie': 'arl=' + configService.get('arl')
    };

    let requestConfig = {
        retry: {
            attempts: 9999999999,
            delay: 1000, // 1 second
            errorFilter: error => 403 !== error.statusCode // retry all errors
        },
        defaults: {
            headers: httpHeaders,
        }
    };

    requestWithoutCache = requestPlus(requestConfig);


    let requestConfigWithoutCacheAndRetry = {
        defaults: {
            headers: httpHeaders
        }
    };

    requestWithoutCacheAndRetry = requestPlus(requestConfigWithoutCacheAndRetry);

    const cacheManagerCache = cacheManager.caching({
        store: 'memory',
        max: 1000
    });

    requestConfig.cache = {
        cache: cacheManagerCache,
        cacheOptions: {
            ttl: 3600 * 2 // 2 hours
        }
    };

    requestWithCache = requestPlus(requestConfig);
}

/**
 * Application init.
 */
(function initApp() {
    process.on('unhandledRejection', (reason, p) => {
        console.error('\n' + reason + '\nUnhandled Rejection at Promise' + JSON.stringify(p) + '\n');
    });

    process.on('uncaughtException', (err) => {
        console.error('\n' + err + '\nUncaught Exception thrown' + '\n');
        process.exit(1);
    });

    // App info
    console.log(chalk.cyan('╔══════════════════════════════════════════════════════════════════╗'));
    console.log(chalk.cyan('║') + chalk.bold.yellow('                          SMLoadr v' + packageJson.version + '                         ') + chalk.cyan('║'));
    console.log(chalk.cyan('╚══════════════════════════════════════════════════════════════════╝'));


    if (!fs.existsSync(DOWNLOAD_LINKS_FILE)) {
        ensureDir(DOWNLOAD_LINKS_FILE);
        fs.writeFileSync(DOWNLOAD_LINKS_FILE, '');
    }

	nodePath.normalize(DOWNLOAD_DIR).replace(/\/$|\\$/, '');
    nodePath.normalize(PLAYLIST_DIR).replace(/\/$|\\$/, '');

    if (isCli) {
        try {
            cliOptions = commandLineArgs(cliOptionDefinitions);
        } catch (err) {
            downloadSpinner.fail(err.message);
            process.exit(1);
        }
    }

    startApp();
})();

/**
 * Start the app.
 */
function startApp() {
    initRequest();

    initDeezerCredentials().then(() => {
        downloadSpinner.text = 'Initiating Deezer API...';
        downloadSpinner.start();

        initDeezerApi().then(() => {
            downloadSpinner.succeed('Connected to Deezer API');
            selectMusicQuality();
        }).catch((err) => {
            if ('Wrong Deezer credentials!' === err) {
                downloadSpinner.fail('Wrong Deezer credentials!');
                configService.set('arl', null);
                configService.saveConfig();

                startApp();
            } else {
                downloadSpinner.fail(err);
            }
        });
    });
}

/**
 * Create directories of the given path if they don't exist.
 *
 * @param {String} filePath
 * @return {boolean}
 */
function ensureDir(filePath) {
    const dirName = nodePath.dirname(filePath);

    if (fs.existsSync(dirName)) {
        return true;
    }

    ensureDir(dirName);
    fs.mkdirSync(dirName);
}

/**
 * Fetch and set the api token.
 */
function initDeezerApi() {
    return new Promise((resolve, reject) => {

        requestWithoutCacheAndRetry({
            method: 'POST',
            url: unofficialApiUrl,
            qs: Object.assign(unofficialApiQueries, {
                method: 'deezer.getUserData',
                cid: getApiCid()
            }),
            json: true,
            jar: true
        }).then((response) => {
            if (!response || 0 < Object.keys(response.error).length) {
                throw 'Unable to initialize Deezer API.';
            } else {
                if (response.results['USER']['USER_ID'] !== 0) {
                    requestWithoutCacheAndRetry({
                        method: 'POST',
                        url: unofficialApiUrl,
                        qs: Object.assign(unofficialApiQueries, {
                            method: 'deezer.getUserData',
                            cid: getApiCid()
                        }),
                        json: true,
                        jar: true
                    }).then((response) => {
                        if (!response || 0 < Object.keys(response.error).length) {
                            throw 'Unable to initialize Deezer API.';
                        } else {
                            if (response.results && response.results.checkForm) {

                                unofficialApiQueries.api_token = response.results.checkForm;

                                resolve();
                            } else {
                                throw 'Unable to initialize Deezer API.';
                            }
                        }
                    }).catch((err) => {
                        if (404 === err.statusCode) {
                            err = 'Could not connect to Deezer.';
                        }

                        reject(err);
                    });
                } else {
                    reject('Wrong Deezer credentials!');
                }
            }
        });
    });
}

/**
 * Ask and set new Deezer account credentials.
 */
function initDeezerCredentials() {
    return new Promise((resolve) => {
        let arl = configService.get('arl');

        if (arl) {
            resolve();
        } else {

            let questions = [
                {
                    type: 'input',
                    name: 'arl',
                    prefix: '♫',
                    message: 'arl cookie:'
                }
            ];

            inquirer.prompt(questions).then(answers => {
                configService.set('arl', answers.arl);

                configService.saveConfig();
                initRequest();

                resolve();
            });
        }
    });
}

/**
 * Get a cid for a unofficial api request.
 *
 * @return {Number}
 */
function getApiCid() {
    return Math.floor(1e9 * Math.random());
}

/**
 * Show user selection for the music download quality.
 */
function selectMusicQuality() {
    console.log('');

    if (isCli) {
        let cliHelp = cliOptions['help'];

        if (cliHelp || null === cliHelp) {
            const helpSections = [
                {
                    header: 'CLI Options',
                    optionList: cliOptionDefinitions
                },
                {
                    content: 'More help here: https://git.fuwafuwa.moe/SMLoadrDev/SMLoadr',
                }
            ];

            console.log(commandLineUsage(helpSections));
            process.exit(1);
        } else {
            let cliUrl = cliOptions['url'];
            let cliQuality = cliOptions['quality'];
            let cliPath = cliOptions['path'];
            let cliDownloadMode = cliOptions['downloadmode'];

            switch (cliQuality) {
                case 'MP3_128':
                    selectedMusicQuality = musicQualities.MP3_128;
                    break;
                case 'MP3_320':
                    selectedMusicQuality = musicQualities.MP3_320;
                    break;
                case 'FLAC':
                    selectedMusicQuality = musicQualities.FLAC;
                    break;
            }

            DOWNLOAD_DIR = nodePath.normalize(cliPath).replace(/\/$|\\$/, '');
            DOWNLOAD_MODE = cliDownloadMode;

            downloadSpinner.warn(chalk.yellow('Do not scroll while downloading! This will mess up the UI!'));

            if ('all' === DOWNLOAD_MODE) {
                downloadLinksFromFile();
            } else if ('single' === DOWNLOAD_MODE) {
                startDownload(cliUrl).then(() => {
                    setTimeout(() => {
                        setTimeout(() => {
                            process.exit(1);
                        }, 100);
                    }, 100);
                }).catch((err) => {
                    downloadSpinner.fail(err);
                    downloadStateInstance.finish();
                    process.exit(1);
                });
            }
        }
    } else {
        inquirer.prompt([
            {
                type: 'list',
                name: 'musicQuality',
                prefix: '♫',
                message: 'Select music quality:',
                choices: [
                    'MP3  - 128  kbps',
                    'MP3  - 320  kbps',
                    'FLAC - 1411 kbps'
                ],
                default: 1
            }
        ]).then((answers) => {
            switch (answers.musicQuality) {
                case 'MP3  - 128  kbps':
                    selectedMusicQuality = musicQualities.MP3_128;
                    break;
                case 'MP3  - 320  kbps':
                    selectedMusicQuality = musicQualities.MP3_320;
                    break;
                case 'FLAC - 1411 kbps':
                    selectedMusicQuality = musicQualities.FLAC;
                    break;
            }

            selectDownloadMode();
        });
    }
}

/**
 * Ask for download mode (single or all).
 */
function selectDownloadMode() {
    inquirer.prompt([
        {
            type: 'list',
            name: 'downloadMode',
            prefix: '♫',
            message: 'Select download mode:',
            choices: [
                'Single (Download single link)',
                'All    (Download all links in "' + DOWNLOAD_LINKS_FILE + '")'
            ],
            default: 0
        }
    ]).then((answers) => {
        if ('All    (Download all links in "' + DOWNLOAD_LINKS_FILE + '")' === answers.downloadMode) {
            console.log('');
            downloadSpinner.warn(chalk.yellow('Do not scroll while downloading! This will mess up the UI!'));

            downloadLinksFromFile();
        } else {
            askForNewDownload();
        }
    });
}

/**
 * Download all links from file
 */
function downloadLinksFromFile() {
    const lines = fs
        .readFileSync(DOWNLOAD_LINKS_FILE, 'utf-8')
        .split(/^(.*)[\r|\n]/)
        .filter(Boolean);

    if (lines[0]) {
        const firstLine = lines[0].trim();

        if ('' === firstLine) {
            removeFirstLineFromFile(DOWNLOAD_LINKS_FILE);
            downloadLinksFromFile();
        } else {
            startDownload(firstLine, true).then(() => {
                removeFirstLineFromFile(DOWNLOAD_LINKS_FILE);
                downloadLinksFromFile();
            }).catch((err) => {
                downloadSpinner.fail(err);
                downloadStateInstance.finish(false);

                removeFirstLineFromFile(DOWNLOAD_LINKS_FILE);
                downloadLinksFromFile();
            });
        }
    } else {
        downloadSpinner.succeed('Finished downloading from text file');

        if (isCli) {
            setTimeout(() => {
                process.exit(1);
            }, 100);
        } else {
            console.log('\n');
            selectDownloadMode();
        }
    }
}

/**
 * Remove the first line from the given file.
 *
 * @param {String} filePath
 */
function removeFirstLineFromFile(filePath) {
    const lines = fs
        .readFileSync(filePath, 'utf-8')
        .split(/^(.*)[\r|\n]/)
        .filter(Boolean);

    let contentToWrite = '';

    if (lines[1]) {
        contentToWrite = lines[1].trim();
    }

    fs.writeFileSync(filePath, contentToWrite);
}

/**
 * Ask for a album, playlist or track link to start the download.
 */
function askForNewDownload() {
    console.log('\n');

    let questions = [
        {
            type: 'input',
            name: 'deezerUrl',
            prefix: '♫',
            message: 'Deezer URL:',
            validate: (deezerUrl) => {
                if (deezerUrl) {
                    let deezerUrlType = getDeezerUrlParts(deezerUrl).type;
                    let allowedDeezerUrlTypes = [
                        'album',
                        'artist',
                        'playlist',
                        'profile',
                        'track'
                    ];

                    if (allowedDeezerUrlTypes.includes(deezerUrlType)) {
                        return true;
                    }
                }

                return 'Deezer URL example: https://www.deezer.com/album|artist|playlist|profile|track/0123456789';
            }
        }
    ];

    inquirer.prompt(questions).then(answers => {
        downloadSpinner.warn(chalk.yellow('Do not scroll while downloading! This will mess up the UI!'));

        startDownload(answers.deezerUrl).then(() => {
            askForNewDownload();
        }).catch((err) => {
            downloadSpinner.fail(err);
            downloadStateInstance.finish();
            askForNewDownload();
        });
    });
}

/**
 * Remove empty files.
 *
 * @param {Object} filePaths
 */
function removeEmptyFiles(filePaths) {
    filePaths.forEach((filePath) => {
        if (fs.existsSync(filePath)) {
            const fileContent = fs.readFileSync(filePath, 'utf-8').trim();

            if ('' === fileContent) {
                fs.unlinkSync(filePath);
            }
        }
    });
}

class downloadState {
    constructor() {
        this.currentlyDownloading = {};
        this.currentlyDownloadingPaths = [];
        this.downloading = false;
        this.numberTracksFinished = 0;
        this.numberTracksToDownload = 0;
        this.downloadType = '';
        this.downloadTypeId = 0;
        this.downloadTypeName = '';
        this.downloadedSuccessfully = null;
        this.downloadedUnsuccessfully = null;
        this.downloadedWithWarning = null;
    }

    start(downloadType, downloadTypeId) {
        this.downloading = true;
        this.downloadType = downloadType;
        this.downloadTypeId = downloadTypeId;

        this.downloadedSuccessfully = fs.createWriteStream('downloadedSuccessfully.txt', {
            flags: 'a' // 'a' means appending (old data will be preserved)
        });

        this.downloadedUnsuccessfully = fs.createWriteStream('downloadedUnsuccessfully.txt', {
            flags: 'a' // 'a' means appending (old data will be preserved)
        });

        this.downloadedWithWarning = fs.createWriteStream('downloadedWithWarning.txt', {
            flags: 'a' // 'a' means appending (old data will be preserved)
        });

        this.display();
    }

    updateNumberTracksToDownload(numberTracksToDownload) {
        this.numberTracksToDownload = numberTracksToDownload;
    }

    finish(showFinishMessage = true) {
        this.downloading = false;

        if (showFinishMessage) {
            let downloadTypeAndName = this.downloadType;

            if (this.downloadTypeName) {
                downloadTypeAndName += ' "' + this.downloadTypeName + '"';
            }

            downloadSpinner.succeed('Finished downloading ' + downloadTypeAndName);
        }

        if ('-' !== this.downloadTypeId.toString().charAt(0)) {
            this.downloadedSuccessfully.write('https://www.deezer.com/' + this.downloadType + '/' + this.downloadTypeId + '\r\n');
        }

        this.downloadedSuccessfully.end();
        this.downloadedUnsuccessfully.end();
        this.downloadedWithWarning.end();

        removeEmptyFiles([
            'downloadedSuccessfully.txt',
            'downloadedUnsuccessfully.txt',
            'downloadedWithWarning.txt'
        ]);

        this.currentlyDownloading = {};
        this.currentlyDownloadingPaths = [];
        this.numberTracksFinished = 0;
        this.numberTracksToDownload = 0;
        this.downloadType = '';
        this.downloadTypeId = 0;
        this.downloadTypeName = '';
    }

    setDownloadTypeName(downloadTypeName) {
        this.downloadTypeName = downloadTypeName;

        this.display();
    }

    add(trackId, message) {

        this.currentlyDownloading[trackId] = message;

        this.display();
    }

    update(trackId, message) {
        this.add(trackId, message);
    }

    remove(trackId) {
        delete this.currentlyDownloading[trackId];

        this.display();
    }

    success(trackId, message) {
        downloadSpinner.succeed(message);

        this.numberTracksFinished++;
        this.remove(trackId);
    }

    warn(trackId, message) {
        downloadSpinner.warn(message);

        if ('-' !== trackId.toString().charAt(0)) {
            this.downloadedWithWarning.write('https://www.deezer.com/track/' + trackId + '\r\n');
        }

        this.numberTracksFinished++;
        this.remove(trackId);
    }

    fail(trackId, message) {
        downloadSpinner.fail(message);

        if ('-' !== trackId.toString().charAt(0)) {
            this.downloadedUnsuccessfully.write('https://www.deezer.com/track/' + trackId + '\r\n');
        }

        this.numberTracksFinished++;
        this.remove(trackId);
    }

    display() {
        if (this.downloading) {
            let downloadTypeAndName = this.downloadType;

            if (this.downloadTypeName) {
                downloadTypeAndName += ' "' + this.downloadTypeName + '"';
            }

            let finishedPercentage = '0.00';

            if (0 !== this.numberTracksToDownload) {
                finishedPercentage = (this.numberTracksFinished / this.numberTracksToDownload * 100).toFixed(2);
            }

            let downloadSpinnerText = chalk.green('Downloading ' + downloadTypeAndName + ' [' + this.numberTracksFinished + '/' + this.numberTracksToDownload + ' - ' + finishedPercentage + '%]:\n');

            if (0 < Object.keys(this.currentlyDownloading).length) {
                downloadSpinnerText += '  › ' + Object.values(this.currentlyDownloading).join('\n  › ');
            } else {
                downloadSpinnerText += '  › Fetching infos...';
            }

            downloadSpinner.start(downloadSpinnerText);
        }
    }

    addCurrentlyDownloadingPath(downloadPath) {
        this.currentlyDownloadingPaths.push(downloadPath);
    }

    removeCurrentlyDownloadingPath(downloadPath) {
        const index = this.currentlyDownloadingPaths.indexOf(downloadPath);

        if (-1 !== index) {
            this.currentlyDownloadingPaths.splice(index, 1);
        }
    }

    isCurrentlyDownloadingPathUsed(downloadPath) {
        return (this.currentlyDownloadingPaths.indexOf(downloadPath) > -1);
    }
}

let downloadStateInstance = new downloadState();

/**
 * Start a deezer download.
 *
 * @param {String}  deezerUrl
 * @param {Boolean} downloadFromFile
 */
function startDownload(deezerUrl, downloadFromFile = false) {

    const deezerUrlParts = getDeezerUrlParts(deezerUrl);

    downloadStateInstance.start(deezerUrlParts.type, deezerUrlParts.id);

    switch (deezerUrlParts.type) {
        case 'album':
        case 'playlist':
        case 'profile':
            return downloadMultiple(deezerUrlParts.type, deezerUrlParts.id).then(() => {
                downloadStateInstance.finish(!downloadFromFile);
            });
        case 'artist':
            return downloadArtist(deezerUrlParts.id).then(() => {
                downloadStateInstance.finish(!downloadFromFile);
            });
        case 'track':
            downloadStateInstance.updateNumberTracksToDownload(1);

            return downloadSingleTrack(deezerUrlParts.id).then(() => {
                downloadStateInstance.finish(!downloadFromFile);
            });
    }
}

/**
 * Get the url type (album/artist/playlist/profile/track) and the id from the deezer url.
 *
 * @param {String} deezerUrl
 *
 * @return {Object}
 */
function getDeezerUrlParts(deezerUrl) {
    const urlParts = deezerUrl.split(/\/(\w+)\/(\d+)/);

    return {
        type: urlParts[1],
        id: urlParts[2]
    };
}

/**
 * Download all tracks of an artists.
 *
 * @param {Number} id
 */
function downloadArtist(id) {
    return new Promise((resolve, reject) => {
        let requestParams = {
            method: 'POST',
            url: unofficialApiUrl,
            qs: Object.assign(unofficialApiQueries, {
                method: 'artist.getData',
                cid: getApiCid()
            }),
            body: {
                art_id: id,
                filter_role_id: [0],
                lang: 'us',
                tab: 0,
                nb: -1,
                start: 0
            },
            json: true,
            jar: true
        };

        requestWithCache(requestParams).then((response) => {
            if (!response || 0 < Object.keys(response.error).length) {
                if (response.error.VALID_TOKEN_REQUIRED) {
                    initDeezerApi();

                    setTimeout(() => {
                        downloadArtist(id).then(() => {
                            resolve();
                        }).catch((err) => {
                            reject(err);
                        });
                    }, 1000);
                } else {
                    throw 'Could not fetch the artist!';
                }
            } else {

                const artistName = response.results.ART_NAME;
                downloadStateInstance.setDownloadTypeName(artistName);

                requestParams.qs.method = 'album.getDiscography';
                requestParams.qs.cid = getApiCid();
                requestParams.body = {
                    art_id: id,
                    filter_role_id: [0],
                    lang: 'us',
                    nb: 500,
                    nb_songs: 300,
                    start: 0
                };

                requestWithoutCache(requestParams).then((response) => {
                    if (!response || 0 < Object.keys(response.error).length) {
                        if (response.error.VALID_TOKEN_REQUIRED) {
                            initDeezerApi();

                            setTimeout(() => {
                                downloadArtist(id).then(() => {
                                    resolve();
                                }).catch((err) => {
                                    reject(err);
                                });
                            }, 1000);
                        } else {
                            throw 'Could not fetch "' + artistName + '" albums!';
                        }
                    } else {

                        if (0 < response.results.data.length) {
                            let trackList = [];
                            let albumList = {};

                            response.results.data.forEach((album) => {
                                albumList[album.ALB_ID] = album;

                                album.SONGS.data.forEach((track) => {
                                    trackList.push(track);
                                });
                            });

                            downloadStateInstance.updateNumberTracksToDownload(trackList.length);

                            trackListDownload(trackList, albumList).then(() => {
                                resolve();
                            });
                        } else {
                            downloadSpinner.warn('No tracks to download for artist "' + artistName + '"');

                            resolve();
                        }
                    }
                }).catch((err) => {
                    reject(err);
                });
            }
        }).catch((err) => {
            reject(err);
        });
    });
}

/**
 * Download multiple tracks (album, playlist or users favourite tracks)
 *
 * @param {String} type
 * @param {Number} id
 */
function downloadMultiple(type, id) {
    let requestBody;
    let requestQueries = unofficialApiQueries;

    switch (type) {
        case 'album':
            requestQueries.method = 'deezer.pageAlbum';
            requestBody = {
                alb_id: id,
                lang: 'en',
                tab: 0
            };
            break;

        case 'playlist':
            requestQueries.method = 'deezer.pagePlaylist';
            requestBody = {
                playlist_id: id,
                lang: 'en',
                nb: -1,
                start: 0,
                tab: 0,
                tags: true,
                header: true
            };
            break;

        case 'profile':
            requestQueries.method = 'deezer.pageProfile';
            requestBody = {
                user_id: id,
                tab: 'loved',
                nb: -1
            };
            break;
    }

    let requestParams = {
        method: 'POST',
        url: unofficialApiUrl,
        qs: requestQueries,
        body: requestBody,
        json: true,
        jar: true
    };

    let request = requestWithoutCache;

    if (!['playlist', 'profile'].includes(type)) {
        request = requestWithCache;
    }

    return new Promise((resolve, reject) => {
        request(requestParams).then((response) => {
            if (!response || 0 < Object.keys(response.error).length || ('playlist' === type && 1 === Number(response.results.DATA.STATUS) && 0 < response.results.DATA.DURATION && 0 === response.results.SONGS.data.length)) {
                if (response.error.VALID_TOKEN_REQUIRED) {
                    initDeezerApi();

                    setTimeout(() => {
                        downloadMultiple(type, id).then(() => {
                            resolve();
                        }).catch((err) => {
                            reject(err);
                        });
                    }, 1000);
                } else if ('playlist' === type && response.results && response.results.DATA && 1 === Number(response.results.DATA.STATUS && 0 < response.results.DATA.DURATION && 0 === response.results.SONGS.data.length)) {
                    throw 'Other users private playlists are not supported!';
                } else {
                    throw 'Could not fetch the ' + type + '!';
                }
            } else {

                let trackList = [];
                let albumList = {};
                let downloadTypeName = '';

                switch (type) {
                    case 'album':
                        trackList = response.results.SONGS.data;

                        response.results.DATA.SONGS = response.results.SONGS;
                        albumList[response.results.DATA.ALB_ID] = response.results.DATA;

                        downloadTypeName = response.results.DATA.ALB_TITLE;

                        break;
                    case 'playlist':
                        trackList = response.results.SONGS.data;
                        downloadTypeName = response.results.DATA.TITLE;

                        break;
                    case 'profile':
                        trackList = response.results.TAB.loved.data;
                        downloadTypeName = response.results.DATA.USER.DISPLAY_NAME;

                        break;
                }

                downloadStateInstance.setDownloadTypeName(downloadTypeName);

                if (0 < trackList.length) {
                    // We don't want to generate a playlist file if this is no playlist
                    if (['profile', 'album'].includes(type)) {
                        PLAYLIST_FILE_ITEMS = null;
                    } else {
                        PLAYLIST_FILE_ITEMS = {};
                    }

                    downloadStateInstance.updateNumberTracksToDownload(trackList.length);

                    trackListDownload(trackList, albumList).then(() => {
                        // Generate the playlist file
                        if (PLAYLIST_FILE_ITEMS != null) {
                            const playlistName = multipleWhitespacesToSingle(sanitizeFilename(response.results.DATA.TITLE));
                            const playlistFile = nodePath.join(PLAYLIST_DIR, playlistName + '.m3u8');
                            let playlistFileContent = '';

                            for (let i = 0; i < PLAYLIST_FILE_ITEMS.length; i++) {
                                playlistFileContent += PLAYLIST_FILE_ITEMS[i] + '\r\n';
                            }

                            trackList.forEach((trackInfos) => {
                                if (PLAYLIST_FILE_ITEMS[trackInfos.SNG_ID]) {
                                    const playlistFileItem = PLAYLIST_FILE_ITEMS[trackInfos.SNG_ID];

                                    playlistFileContent += '#EXTINF:' + playlistFileItem.trackDuration + ',' + playlistFileItem.trackArtist + ' - ' + playlistFileItem.trackTitle + '\r\n';
                                    playlistFileContent += '../' + playlistFileItem.trackSavePath + '\r\n';
                                }
                            });

                            ensureDir(playlistFile);
                            fs.writeFileSync(playlistFile, playlistFileContent);
                        }

                        resolve();
                    });
                } else {
                    downloadSpinner.warn('No tracks to download for ' + type + ' "' + downloadTypeName + '"');

                    resolve();
                }
            }
        }).catch((err) => {
            reject(err);
        });
    });
}

/**
 * Get the number of parallel downloads to use for the current available memory and selected quality.
 *
 * @return {Number}
 */
function getNumberOfParallelDownloads() {
    let freeMemoryMb;
    const approxMaxSizeMb = selectedMusicQuality.aproxMaxSizeMb;

    try {
        freeMemoryMb = memoryStats.free() / 1024 / 1024;
    } catch (e) {
        freeMemoryMb = 0;
    }

    let numberOfParallel = parseInt(((freeMemoryMb - 300) / approxMaxSizeMb).toString());

    if (8 > numberOfParallel) {
        numberOfParallel = 8;
    } else if (1 > numberOfParallel) {
        numberOfParallel = 1;
    }

    return numberOfParallel;
}

/**
 * Map through a track list and download it.
 *
 * @param {Object} trackList
 * @param {Object} albumInfos
 */
function trackListDownload(trackList, albumInfos = {}) {
    const numberOfParallel = getNumberOfParallelDownloads();

    return Promise.map(trackList, (trackInfos) => {
        let trackAlbumInfos;

        if (albumInfos[trackInfos.ALB_ID]) {
            trackAlbumInfos = albumInfos[trackInfos.ALB_ID];
        }

        trackInfos.SNG_TITLE_VERSION = trackInfos.SNG_TITLE;

        if (trackInfos.VERSION) {
            trackInfos.SNG_TITLE_VERSION = (trackInfos.SNG_TITLE + ' ' + trackInfos.VERSION).trim();
        }

        let artistName = trackInfos.ART_NAME;

        if (trackAlbumInfos && '' !== trackAlbumInfos.ART_NAME) {
            artistName = trackAlbumInfos.ART_NAME;
        }

        artistName = multipleWhitespacesToSingle(sanitizeFilename(artistName));

        if ('' === artistName.trim()) {
            artistName = 'Unknown artist';
        }

        if ('various' === artistName.trim().toLowerCase()) {
            artistName = 'Various Artists';
        }

        let albumName = multipleWhitespacesToSingle(sanitizeFilename(trackInfos.ALB_TITLE));

        if ('' === albumName.trim()) {
            albumName = 'Unknown album';
        }

        albumName += ' (Album)';

        let saveFileDir = nodePath.join(DOWNLOAD_DIR, artistName, albumName);

        if (trackAlbumInfos && trackAlbumInfos.SONGS && trackAlbumInfos.SONGS.data && 0 < trackAlbumInfos.SONGS.data.length && '' !== trackAlbumInfos.SONGS.data[trackAlbumInfos.SONGS.data.length - 1].DISK_NUMBER) {
            const albumNumberOfDisks = trackAlbumInfos.SONGS.data[trackAlbumInfos.SONGS.data.length - 1].DISK_NUMBER;

            if (albumNumberOfDisks > 1) {
                saveFileDir += nodePath.join(saveFileDir, 'Disc ' + toTwoDigits(trackInfos.DISK_NUMBER));
            }
        }

        let saveFileName = multipleWhitespacesToSingle(sanitizeFilename(toTwoDigits(trackInfos.TRACK_NUMBER) + ' ' + trackInfos.SNG_TITLE_VERSION));
        let fileExtension = 'mp3';

        if (musicQualities.FLAC.id === selectedMusicQuality.id) {
            fileExtension = 'flac';
        }

        const downloadingMessage = artistName + ' - ' + trackInfos.SNG_TITLE_VERSION;
        downloadStateInstance.add(trackInfos.SNG_ID, downloadingMessage);

        return downloadSingleTrack(trackInfos.SNG_ID, trackInfos, trackAlbumInfos);
    }, {
        concurrency: numberOfParallel
    });
}

/**
 * Download a track + id3tags (album cover...) and save it in the downloads folder.
 *
 * @param {Number}  id
 * @param {Object}  trackInfos
 * @param {Object}  albumInfos
 * @param {Boolean} isAlternativeTrack
 * @param {Number}  numberRetry
 */
function downloadSingleTrack(id, trackInfos = {}, albumInfos = {}, isAlternativeTrack = false, numberRetry = 0) {
    let dirPath;
    let saveFilePath;
    let originalTrackInfos;
    let fileExtension = 'mp3';
    let trackQuality;

    return new Promise((resolve) => {
        if ('-' === id.toString().charAt(0) && 0 < Object.keys(trackInfos).length) {
            getTrackAlternative(trackInfos).then((alternativeTrackInfos) => {
                downloadStateInstance.remove(id);

                downloadSingleTrack(alternativeTrackInfos.SNG_ID, {}, {}, true).then(() => {
                    resolve();
                });
            }).catch(() => {
                startTrackInfoFetching();
            });
        } else {
            startTrackInfoFetching();
        }

        function startTrackInfoFetching() {
            if (!isAlternativeTrack && 0 < Object.keys(trackInfos).length) {
                originalTrackInfos = trackInfos;

                afterTrackInfoFetching();
            } else {
                getTrackInfos(id).then((trackInfosResponse) => {
                    originalTrackInfos = trackInfosResponse;

                    afterTrackInfoFetching();
                }).catch((err) => {
                    errorHandling(err);
                });
            }
        }

        function afterTrackInfoFetching() {
            if (!isAlternativeTrack || 0 === Object.keys(trackInfos).length) {
                trackInfos = originalTrackInfos;
            }

            trackQuality = getValidTrackQuality(originalTrackInfos);

            originalTrackInfos.SNG_TITLE_VERSION = originalTrackInfos.SNG_TITLE;

            if (originalTrackInfos.VERSION) {
                originalTrackInfos.SNG_TITLE_VERSION = (originalTrackInfos.SNG_TITLE + ' ' + originalTrackInfos.VERSION).trim();
            }

            if (0 < Object.keys(albumInfos).length || 0 === trackInfos.ALB_ID) {
                afterAlbumInfoFetching();
            } else {
                const downloadingMessage = trackInfos.ART_NAME + ' - ' + trackInfos.SNG_TITLE_VERSION;
                downloadStateInstance.update(originalTrackInfos.SNG_ID, downloadingMessage);

                getAlbumInfos(trackInfos.ALB_ID).then((albumInfosResponse) => {
                    albumInfos = albumInfosResponse;

                    albumInfos.TYPE = 'album';
                    albumInfos.GENRES = [];

                    afterAlbumInfoFetching();
                }).catch(() => {
                    afterAlbumInfoFetching();
                });
            }
        }

        function afterAlbumInfoFetching() {
            originalTrackInfos.ALB_UPC = '';
            originalTrackInfos.ALB_LABEL = '';
            originalTrackInfos.ALB_NUM_TRACKS = '';
            originalTrackInfos.ALB_NUM_DISCS = '';

            if (albumInfos.UPC) {
                originalTrackInfos.ALB_UPC = albumInfos.UPC;
            }

            if (albumInfos.PHYSICAL_RELEASE_DATE && !trackInfos.ALB_RELEASE_DATE) {
                originalTrackInfos.ALB_RELEASE_DATE = albumInfos.PHYSICAL_RELEASE_DATE;
            }

            if (albumInfos.SONGS && 0 < albumInfos.SONGS.data.length && albumInfos.SONGS.data[albumInfos.SONGS.data.length - 1].DISK_NUMBER) {
                originalTrackInfos.ALB_NUM_DISCS = albumInfos.SONGS.data[albumInfos.SONGS.data.length - 1].DISK_NUMBER;
            }

            originalTrackInfos.ALB_ART_NAME = originalTrackInfos.ART_NAME;

            if (albumInfos.ART_NAME) {
                originalTrackInfos.ALB_ART_NAME = albumInfos.ART_NAME;
            }

            if (!originalTrackInfos.ARTISTS || 0 === originalTrackInfos.ARTISTS.length) {
                originalTrackInfos.ARTISTS = [
                    {
                        ART_ID: originalTrackInfos.ART_ID,
                        ART_NAME: originalTrackInfos.ALB_ART_NAME,
                        ART_PICTURE: originalTrackInfos.ART_PICTURE
                    }
                ];
            }

            if ('various' === originalTrackInfos.ALB_ART_NAME.trim().toLowerCase()) {
                originalTrackInfos.ALB_ART_NAME = 'Various Artists';
            }

            if (albumInfos.LABEL_NAME) {
                originalTrackInfos.ALB_LABEL = albumInfos.LABEL_NAME;
            }

            if (albumInfos.SONGS && albumInfos.SONGS.data.length) {
                originalTrackInfos.ALB_NUM_TRACKS = albumInfos.SONGS.data.length;
            }

            const downloadingMessage = trackInfos.ALB_ART_NAME + ' - ' + trackInfos.SNG_TITLE_VERSION;
            downloadStateInstance.update(originalTrackInfos.SNG_ID, downloadingMessage);

            if (0 === trackInfos.ALB_ID) {
                afterAlbumInfoOfficialApiFetching();
            } else {
                getAlbumInfosOfficialApi(trackInfos.ALB_ID).then((albumInfosResponse) => {
                    albumInfos.TYPE = albumInfosResponse.record_type;
                    albumInfos.GENRES = [];

                    albumInfosResponse.genres.data.forEach((albumGenre) => {
                        albumInfos.GENRES.push(albumGenre.name);
                    });

                    afterAlbumInfoOfficialApiFetching();
                }).catch(() => {
                    afterAlbumInfoOfficialApiFetching();
                });
            }
        }

        function afterAlbumInfoOfficialApiFetching() {
            originalTrackInfos.ALB_GENRES = albumInfos.GENRES;

            if (albumInfos.TYPE) {
                originalTrackInfos.ALB_RELEASE_TYPE = albumInfos.TYPE;
            }

            if (isAlternativeTrack) {
                trackInfos.DURATION = originalTrackInfos.DURATION;
                trackInfos.GAIN = originalTrackInfos.GAIN;
                trackInfos.LYRICS_ID = originalTrackInfos.LYRICS_ID;
                trackInfos.LYRICS = originalTrackInfos.LYRICS;
            } else {
                trackInfos = originalTrackInfos;
            }

            if (trackQuality) {
                let artistName = multipleWhitespacesToSingle(sanitizeFilename(trackInfos.ALB_ART_NAME));

                if ('' === artistName.trim()) {
                    artistName = 'Unknown artist';
                }

                let albumType = 'Album';

                if (albumInfos.TYPE) {
                    albumType = albumInfos.TYPE.toLowerCase();

                    if ('ep' === albumType) {
                        albumType = 'EP';
                    } else {
                        albumType = capitalizeFirstLetter(albumType);
                    }
                }

                let albumName = multipleWhitespacesToSingle(sanitizeFilename(trackInfos.ALB_TITLE));

                if ('' === albumName.trim()) {
                    albumName = 'Unknown album';
                }

                albumName += ' (' + albumType + ')';

                if (trackInfos.ALB_NUM_DISCS > 1) {
                    dirPath = nodePath.join(DOWNLOAD_DIR, artistName, albumName, 'Disc ' + toTwoDigits(trackInfos.DISK_NUMBER));
                } else {
                    dirPath = nodePath.join(DOWNLOAD_DIR, artistName, albumName);
                }

                if (musicQualities.FLAC.id === trackQuality.id) {
                    fileExtension = 'flac';
                }
                saveFilePath = dirPath + nodePath.sep;

                if (trackInfos.TRACK_NUMBER) {
                    saveFilePath += toTwoDigits(trackInfos.TRACK_NUMBER) + ' ';
                }

                saveFilePath += multipleWhitespacesToSingle(sanitizeFilename(trackInfos.SNG_TITLE_VERSION));

                saveFilePath += '.' + fileExtension;

                if (!fs.existsSync(saveFilePath) && !downloadStateInstance.isCurrentlyDownloadingPathUsed(saveFilePath)) {
                    downloadStateInstance.addCurrentlyDownloadingPath(saveFilePath);

                    return downloadTrack(originalTrackInfos, trackQuality.id, saveFilePath).then((decryptedTrackBuffer) => {
                        onTrackDownloadComplete(decryptedTrackBuffer);
                    }).catch((error) => {

                        if (originalTrackInfos.FALLBACK && originalTrackInfos.FALLBACK.SNG_ID && trackInfos.SNG_ID !== originalTrackInfos.FALLBACK.SNG_ID && originalTrackInfos.SNG_ID !== originalTrackInfos.FALLBACK.SNG_ID) {
                            downloadStateInstance.removeCurrentlyDownloadingPath(saveFilePath);
                            downloadStateInstance.remove(originalTrackInfos.SNG_ID);

                            downloadSingleTrack(originalTrackInfos.FALLBACK.SNG_ID, trackInfos, albumInfos, true).then(() => {
                                resolve();
                            });

                            const error = {
                                message: '-',
                                name:    'notAvailableButAlternative'
                            };

                            errorHandling(error);
                        } else {
                            getTrackAlternative(trackInfos).then((alternativeTrackInfos) => {
                                downloadStateInstance.removeCurrentlyDownloadingPath(saveFilePath);
                                downloadStateInstance.remove(originalTrackInfos.SNG_ID);

                                if (albumInfos.ALB_TITLE) {
                                    albumInfos = {};
                                }

                                downloadSingleTrack(alternativeTrackInfos.SNG_ID, trackInfos, albumInfos, true).then(() => {
                                    resolve();
                                });
                            }).catch(() => {
                                const errorMessage = trackInfos.ALB_ART_NAME + ' - ' + trackInfos.SNG_TITLE_VERSION + '\n  › Deezer doesn\'t provide the song anymore';

                                errorHandling(errorMessage);
                            });
                        }
                    });
                } else {
                    addTrackToPlaylist(saveFilePath, trackInfos);

                    const error = {
                        message: trackInfos.ALB_ART_NAME + ' - ' + trackInfos.SNG_TITLE_VERSION + ' \n  › Song already exists',
                        name:    'songAlreadyExists'
                    };

                    errorHandling(error);
                }
            } else {
                errorHandling(trackInfos.ALB_ART_NAME + ' - ' + trackInfos.SNG_TITLE_VERSION + '\n  › Deezer doesn\'t provide the song anymore');
            }
        }

        function onTrackDownloadComplete(decryptedTrackBuffer) {
            let downloadMessageAppend = '';

            if (isAlternativeTrack && originalTrackInfos.SNG_TITLE_VERSION.trim().toLowerCase() !== trackInfos.SNG_TITLE_VERSION.trim().toLowerCase()) {
                downloadMessageAppend = '\n  › Used "' + originalTrackInfos.ALB_ART_NAME + ' - ' + originalTrackInfos.SNG_TITLE_VERSION + '" as alternative';
            }

            if (trackQuality !== selectedMusicQuality) {
                let selectedMusicQualityName = musicQualities[Object.keys(musicQualities).find(key => musicQualities[key] === selectedMusicQuality)].name;
                let trackQualityName = musicQualities[Object.keys(musicQualities).find(key => musicQualities[key] === trackQuality)].name;

                downloadMessageAppend += '\n  › Used "' + trackQualityName + '" because "' + selectedMusicQualityName + '" wasn\'t available';
            }

            const successMessage = '' + trackInfos.ALB_ART_NAME + ' - ' + trackInfos.SNG_TITLE_VERSION + '' + downloadMessageAppend;

            addTrackTags(decryptedTrackBuffer, trackInfos, saveFilePath).then(() => {
                downloadStateInstance.success(originalTrackInfos.SNG_ID, successMessage);

                downloadStateInstance.removeCurrentlyDownloadingPath(saveFilePath);
                addTrackToPlaylist(saveFilePath, trackInfos);

                resolve();
            }).catch(() => {
                const warningMessage = successMessage + '\n  › Failed writing ID3 tags';
                downloadStateInstance.warn(originalTrackInfos.SNG_ID, warningMessage);

                downloadStateInstance.removeCurrentlyDownloadingPath(saveFilePath);
                addTrackToPlaylist(saveFilePath, trackInfos);

                resolve();
            });
        }

        function errorHandling(err) {
            if (404 === err.statusCode) {
                err = 'Track "' + id + '" not found';
            }

            if (err.name && err.message) {
                if ('-' !== err.message) {
                    if ('songAlreadyExists' === err.name) {
                        downloadStateInstance.success(originalTrackInfos.SNG_ID, err.message);
                    } else {
                        downloadStateInstance.fail(originalTrackInfos.SNG_ID, err.message);
                    }
                }
            } else {
                downloadStateInstance.fail(id, err);
            }

            if ('notAvailableButAlternative' !== err.name && 'invalidApiToken' !== err.name) {
                resolve();
            }
        }
    });
}

/**
 * Get track infos of a song by id.
 *
 * @param {Number} id
 */
function getTrackInfos(id) {
    return new Promise((resolve, reject) => {
        return requestWithCache({
            method: 'POST',
            url: unofficialApiUrl,
            qs: Object.assign(unofficialApiQueries, {
                method: 'deezer.pageTrack',
                cid: getApiCid()
            }),
            body: {
                sng_id: id
            },
            json: true,
            jar: true
        }).then((response) => {

            if (response && 0 === Object.keys(response.error).length && response.results && response.results.DATA) {
                let trackInfos = response.results.DATA;

                if (response.results.LYRICS) {
                    trackInfos.LYRICS = response.results.LYRICS;
                }

                resolve(trackInfos);
            } else if (response.error.VALID_TOKEN_REQUIRED) {
                initDeezerApi();

                setTimeout(() => {
                    getTrackInfos(id).then((trackInfos) => {
                        resolve(trackInfos);
                    }).catch((err) => {
                        reject(err);
                    });
                }, 1000);
            } else {
                reject({statusCode: 404});
            }
        }).catch(() => {
            reject({statusCode: 404});
        });
    });
}

/**
 * Get alternative track for a song by its track infos.
 *
 * @param {Object} trackInfos
 */
function getTrackAlternative(trackInfos) {
    return new Promise((resolve, reject) => {
        return requestWithCache({
            method: 'POST',
            url: unofficialApiUrl,
            qs: Object.assign(unofficialApiQueries, {
                method: 'search.music',
                cid: getApiCid()
            }),
            body: {
                QUERY: 'artist:\'' + trackInfos.ART_NAME + '\' track:\'' + trackInfos.SNG_TITLE + '\'',
                OUTPUT: 'TRACK',
                NB: 50,
                FILTER: 0
            },
            json: true,
            jar: true
        }).then((response) => {

            if (response && 0 === Object.keys(response.error).length && response.results && response.results.data && 0 > response.results.data.length) {
                const foundTracks = response.results.data;
                let matchingTracks = [];
                if (foundTracks.length > 0) {
                    foundTracks.forEach((foundTrack) => {
                        if (trackInfos.MD5_ORIGIN === foundTrack.MD5_ORIGIN && trackInfos.DURATION - 5 <= foundTrack.DURATION && trackInfos.DURATION + 10 >= foundTrack.DURATION) {
                            matchingTracks.push(foundTrack);
                        }
                    });

                    if (1 === matchingTracks.length) {
                        resolve(matchingTracks[0]);
                    } else {
                        let foundAlternativeTrack = false;

                        if (0 === matchingTracks.length) {
                            foundTracks.forEach((foundTrack) => {
                                if (trackInfos.MD5_ORIGIN === foundTrack.MD5_ORIGIN) {
                                    matchingTracks.push(foundTrack);
                                }
                            });
                        }

                        matchingTracks.forEach((foundTrack) => {
                            foundTrack.SNG_TITLE_VERSION = foundTrack.SNG_TITLE;

                            if (foundTrack.VERSION) {
                                foundTrack.SNG_TITLE_VERSION = (foundTrack.SNG_TITLE + ' ' + foundTrack.VERSION).trim();
                            }

                            if (removeWhitespacesAndSpecialChars(trackInfos.SNG_TITLE_VERSION).toLowerCase() === removeWhitespacesAndSpecialChars(foundTrack.SNG_TITLE_VERSION).toLowerCase()) {
                                foundAlternativeTrack = true;

                                resolve(foundTrack);
                            }
                        });

                        if (!foundAlternativeTrack) {
                            reject();
                        }
                    }
                } else {
                    reject();
                }
            } else if (response.error.VALID_TOKEN_REQUIRED) {
                initDeezerApi();

                setTimeout(() => {
                    getTrackAlternative(trackInfos).then((alternativeTrackInfos) => {
                        resolve(alternativeTrackInfos);
                    }).catch(() => {
                        reject();
                    });
                }, 1000);
            } else {
                reject();
            }
        }).catch(() => {
            reject();
        });
    });
}

/**
 * Remove whitespaces and special characters from the given string.
 *
 * @param {String} string
 */
function removeWhitespacesAndSpecialChars(string) {
    return string.replace(/[^A-Z0-9]/ig, '');
}

/**
 * Get infos of an album by id.
 *
 * @param {Number} id
 */
function getAlbumInfos(id) {
    return new Promise((resolve, reject) => {
        return requestWithCache({
            method: 'POST',
            url: unofficialApiUrl,
            qs: Object.assign(unofficialApiQueries, {
                method: 'deezer.pageAlbum',
                cid: getApiCid()
            }),
            body: {
                alb_id: id,
                lang: 'us',
                tab: 0
            },
            json: true,
            jar: true
        }).then((response) => {

            if (response && 0 === Object.keys(response.error).length && response.results && response.results.DATA && response.results.SONGS) {
                let albumInfos = response.results.DATA;
                albumInfos.SONGS = response.results.SONGS;

                resolve(albumInfos);
            } else if (response.error.VALID_TOKEN_REQUIRED) {
                initDeezerApi();

                setTimeout(() => {
                    getAlbumInfos(id).then((albumInfos) => {
                        resolve(albumInfos);
                    }).catch((err) => {
                        reject(err);
                    });
                }, 1000);
            } else {
                reject({statusCode: 404});
            }
        }).catch(() => {
            reject({statusCode: 404});
        });
    });
}

/**
 * Get infos of an album from the official api by id.
 *
 * @param {Number} id
 */
function getAlbumInfosOfficialApi(id) {
    return new Promise((resolve, reject) => {
        return requestWithCache({
            url: 'https://api.deezer.com/album/' + id,
            json: true
        }).then((albumInfos) => {

            if (albumInfos && !albumInfos.error) {
                resolve(albumInfos);
            } else {
                reject({statusCode: 404});
            }
        }).catch(() => {
            reject({statusCode: 404});
        });
    });
}

/**
 * Get lyrics of a track by id.
 *
 * @param {Number} id
 */
function getTrackLyrics(id) {
    return new Promise((resolve, reject) => {
        return requestWithCache({
            method: 'POST',
            url: unofficialApiUrl,
            qs: Object.assign(unofficialApiQueries, {
                method: 'song.getLyrics',
                cid: getApiCid()
            }),
            body: {
                sng_id: id
            },
            json: true,
            jar: true
        }).then((response) => {

            if (response && 0 === Object.keys(response.error).length && response.results && response.results.LYRICS_ID) {
                let trackLyrics = response.results;

                resolve(trackLyrics);
            } else if (response.error.VALID_TOKEN_REQUIRED) {
                initDeezerApi();

                setTimeout(() => {
                    getTrackLyrics(id).then((trackLyrics) => {
                        resolve(trackLyrics);
                    }).catch((err) => {
                        reject(err);
                    });
                }, 1000);
            } else {
                reject({statusCode: 404});
            }
        }).catch(() => {
            reject({statusCode: 404});
        });
    });
}

/**
 * Add a track to the playlist file content.
 *
 * @param {String} saveFilePath
 * @param {Object} trackInfos
 */
function addTrackToPlaylist(saveFilePath, trackInfos) {
    if (PLAYLIST_FILE_ITEMS != null) {
        let saveFilePathForPlaylist = saveFilePath.replace(/\\+/g, '/');

        if (!trackInfos.ALB_ART_NAME) {
            trackInfos.ALB_ART_NAME = trackInfos.ART_NAME;
        }

        let artistName = multipleWhitespacesToSingle(sanitizeFilename(trackInfos.ALB_ART_NAME));

        if ('' === artistName.trim()) {
            artistName = 'Unknown artist';
        }

        PLAYLIST_FILE_ITEMS[trackInfos.SNG_ID] = {
            trackTitle: trackInfos.SNG_TITLE_VERSION,
            trackArtist: artistName,
            trackDuration: trackInfos.DURATION,
            trackSavePath: saveFilePathForPlaylist
        };
    }
}

/**
 * Capitalizes the first letter of a string
 *
 * @param {String} string
 *
 * @returns {String}
 */
function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

/**
 * Adds a zero to the beginning if the number has only one digit.
 *
 * @param {Number} number
 * @returns {String}
 */
function toTwoDigits(number) {
    return (number < 10 ? '0' : '') + number;
}

/**
 * Replaces multiple whitespaces with a single one.
 *
 * @param {String} string
 * @returns {String}
 */
function multipleWhitespacesToSingle(string) {
    return string.replace(/[ _,]+/g, ' ');
}

/**
 * Replaces multiple whitespaces with a single one.
 *
 * @param {String} fileName
 * @returns {String}
 */
function sanitizeFilename(fileName) {
    fileName = fileName.replace('/', '-');

    return sanitize(fileName);
}

/**
 * Calculate the URL to download the track.
 *
 * @param {Object} trackInfos
 * @param {Number} trackQuality
 *
 * @returns {String}
 */
function getTrackDownloadUrl(trackInfos, trackQuality) {
    const cdn = trackInfos.MD5_ORIGIN[0];

    return 'https://e-cdns-proxy-' + cdn + '.dzcdn.net/mobile/1/' + encryptionService.getSongFileName(trackInfos, trackQuality);
}

/**
 * Get a downloadable track quality.
 *
 * FLAC -> 320kbps -> 128kbps
 * 320kbps -> FLAC -> 128kbps
 * 128kbps -> 320kbps -> FLAC
 *
 * @param {Object} trackInfos
 *
 * @returns {Object|Boolean}
 */
function getValidTrackQuality(trackInfos) {
    if (trackInfos.FILESIZE_MP3_MISC === 0) {
        return musicQualities.MP3_MISC;
    }

    if (musicQualities.FLAC === selectedMusicQuality) {
        if (trackInfos.FILESIZE_FLAC === 0) {
            if (trackInfos.FILESIZE_MP3_320 === 0) {
                if (trackInfos.FILESIZE_MP3_128 === 0) {
                    return false;
                }
                return musicQualities.MP3_128;
            }
            return musicQualities.MP3_320;
        }
        return musicQualities.FLAC;
    }

    if (musicQualities.MP3_320 === selectedMusicQuality) {
        if (trackInfos.FILESIZE_MP3_320 === 0) {
            if (trackInfos.FILESIZE_FLAC === 0 ) {
                if (trackInfos.FILESIZE_MP3_128 === 0) {
                    return false;
                }
                return musicQualities.MP3_128;
            }
            return musicQualities.FLAC;
        }
        return musicQualities.MP3_320;
    }

    if (musicQualities.MP3_128 === selectedMusicQuality) {
        if (trackInfos.FILESIZE_MP3_128 === 0) {
            if (trackInfos.FILESIZE_MP3_320 === 0) {
                if (trackInfos.FILESIZE_FLAC === 0) {
                    return false;
                }
                return musicQualities.FLAC;
            }
            return musicQualities.MP3_320;
        }
        return musicQualities.MP3_128;
    }

    return false;
}

/**
 * Download the track, decrypt it and write it to a file.
 *
 * @param {Object} trackInfos
 * @param {Number} trackQualityId
 * @param {String} saveFilePath
 * @param {Number} numberRetry
 */
function downloadTrack(trackInfos, trackQualityId, saveFilePath, numberRetry = 0) {
    return new Promise((resolve, reject) => {
        const trackDownloadUrl = getTrackDownloadUrl(trackInfos, trackQualityId);

        requestWithoutCache({
            url: trackDownloadUrl,
            headers: httpHeaders,
            jar: true,
            encoding: null
        }).then((response) => {

            const decryptedTrackBuffer = encryptionService.decryptTrack(response, trackInfos);

            resolve(decryptedTrackBuffer);
        }).catch((err) => {
            if (403 === err.statusCode) {
                let maxNumberRetry = 1;

                if ((trackInfos.RIGHTS && 0 !== Object.keys(trackInfos.RIGHTS).length) || (trackInfos.AVAILABLE_COUNTRIES && trackInfos.AVAILABLE_COUNTRIES.STREAM_ADS && 0 < trackInfos.AVAILABLE_COUNTRIES.STREAM_ADS.length)) {
                    maxNumberRetry = 2;
                }

                if (maxNumberRetry >= numberRetry) {
                    numberRetry += 1;

                    setTimeout(() => {
                        downloadTrack(trackInfos, trackQualityId, saveFilePath, numberRetry).then((decryptedTrackBuffer) => {
                            resolve(decryptedTrackBuffer);
                        }).catch((error) => {
                            reject(error);
                        });
                    }, 1000);
                } else {
                    reject(err);
                }
            } else {
                reject(err);
            }
        });
    });
}

/**
 * Download the album cover of a track.
 *
 * @param {Object} trackInfos
 * @param {String} saveFilePath
 * @param {Number} numberRetry
 */
function downloadAlbumCover(trackInfos, saveFilePath, numberRetry = 0) {

    const albumCoverUrl = 'https://e-cdns-images.dzcdn.net/images/cover/' + trackInfos.ALB_PICTURE + '/1400x1400-000000-94-0-0.jpg';
    const albumCoverSavePath = nodePath.dirname(saveFilePath) + '/cover.jpg';

    return new Promise((resolve, reject) => {
        // check to make sure there is a cover for this album
        if (!trackInfos.ALB_PICTURE) {
            reject();
        } else {
            if (!fs.existsSync(albumCoverSavePath)) {

                requestWithoutCache({
                    url: albumCoverUrl,
                    headers: httpHeaders,
                    jar: true,
                    encoding: null
                }).then((response) => {

                    ensureDir(albumCoverSavePath);
                    fs.writeFile(albumCoverSavePath, response, (err) => {
                        if (err) {
                            reject();
                        } else {
                            resolve(albumCoverSavePath);
                        }
                    });
                }).catch((err) => {
                    if (403 === err.statusCode) {
                        if (4 >= numberRetry) {
                            numberRetry += 1;

                            setTimeout(() => {
                                downloadAlbumCover(trackInfos, saveFilePath, numberRetry).then((albumCoverSavePath) => {
                                    resolve(albumCoverSavePath);
                                }).catch(() => {
                                    reject();
                                });
                            }, 500);
                        } else {
                            reject();
                        }
                    } else {
                        reject();
                    }
                });
            } else {
                resolve(albumCoverSavePath);
            }
        }
    });
}

/**
 * Add tags to the mp3/flac file.
 *
 * @param {Buffer} decryptedTrackBuffer
 * @param {Object} trackInfos
 * @param {String} saveFilePath
 * @param {Number} numberRetry
 */
function addTrackTags(decryptedTrackBuffer, trackInfos, saveFilePath, numberRetry = 0) {
    return new Promise((resolve, reject) => {

        downloadAlbumCover(trackInfos, saveFilePath).then((albumCoverSavePath) => {

            startTagging(albumCoverSavePath);
        }).catch(() => {
            startTagging();
        });

        function startTagging(albumCoverSavePath = null) {
            try {
                if (trackInfos.LYRICS || !trackInfos.LYRICS_ID || 0 === trackInfos.LYRICS_ID) {
                    afterLyricsFetching();
                } else {
                    getTrackLyrics(trackInfos.SNG_ID).then((trackLyrics) => {
                        trackInfos.LYRICS = trackLyrics;

                        afterLyricsFetching();
                    }).catch(() => {
                        afterLyricsFetching();
                    });
                }

                function afterLyricsFetching() {
                    let trackMetadata = {
                        title: '',
                        album: '',
                        releaseType: '',
                        genre: '',
                        artists: [],
                        albumArtist: '',
                        trackNumber: '',
                        trackNumberCombined: '',
                        partOfSet: '',
                        partOfSetCombined: '',
                        label: '',
                        copyright: '',
                        composer: [],
                        publisher: [],
                        producer: [],
                        engineer: [],
                        writer: [],
                        author: [],
                        mixer: [],
                        ISRC: '',
                        duration: '',
                        bpm: '',
                        upc: '',
                        explicit: '',
                        tracktotal: '',
                        disctotal: '',
                        compilation: '',
                        unsynchronisedLyrics: '',
                        synchronisedLyrics: '',
                        media: 'Digital Media',
                    };

                    if (trackInfos.SNG_TITLE_VERSION) {
                        trackMetadata.title = trackInfos.SNG_TITLE_VERSION;
                    }

                    if (trackInfos.ALB_TITLE) {
                        trackMetadata.album = trackInfos.ALB_TITLE;
                    }

                    if (trackInfos.ALB_ART_NAME) {
                        trackMetadata.albumArtist = trackInfos.ALB_ART_NAME;
                    }

                    if (trackInfos.DURATION) {
                        trackMetadata.duration = trackInfos.DURATION;
                    }

                    if (trackInfos.ALB_UPC) {
                        trackMetadata.upc = trackInfos.ALB_UPC;
                    }

                    if (trackInfos.ALB_RELEASE_TYPE) {
                        let releaseType = trackInfos.ALB_RELEASE_TYPE;

                        if ('ep' === releaseType) {
                            releaseType = 'EP';
                        } else {
                            releaseType = capitalizeFirstLetter(releaseType);
                        }

                        trackMetadata.releaseType = releaseType;
                    }

                    if (trackInfos.ALB_GENRES && trackInfos.ALB_GENRES[0]) {
                        trackMetadata.genre = trackInfos.ALB_GENRES[0];
                    }

                    if (trackInfos.TRACK_NUMBER) {
                        trackMetadata.trackNumber = trackInfos.TRACK_NUMBER;
                        trackMetadata.trackNumberCombined = trackInfos.TRACK_NUMBER;
                    }

                    if (trackInfos.ALB_NUM_TRACKS) {
                        trackMetadata.tracktotal = trackInfos.ALB_NUM_TRACKS;
                        trackMetadata.trackNumberCombined += '/' + trackInfos.ALB_NUM_TRACKS;
                    }

                    if (trackInfos.DISK_NUMBER) {
                        trackMetadata.partOfSet = trackInfos.DISK_NUMBER;
                        trackMetadata.partOfSetCombined = trackInfos.DISK_NUMBER;
                    }

                    if (trackInfos.ALB_NUM_DISCS) {
                        trackMetadata.disctotal = trackInfos.ALB_NUM_DISCS;
                        trackMetadata.partOfSetCombined += '/' + trackInfos.ALB_NUM_DISCS;
                    }

                    if (trackInfos.ALB_RELEASE_DATE || trackInfos.PHYSICAL_RELEASE_DATE) {
                        let releaseDate = trackInfos.ALB_RELEASE_DATE;

                        if (!trackInfos.ALB_RELEASE_DATE) {
                            releaseDate = trackInfos.PHYSICAL_RELEASE_DATE;
                        }

                        trackMetadata.releaseYear = releaseDate.slice(0, 4);
                        trackMetadata.releaseDate = releaseDate.slice(0, 10);
                    }

                    if (trackInfos.ALB_LABEL) {
                        trackMetadata.label = trackInfos.ALB_LABEL;
                    }

                    if (trackInfos.COPYRIGHT) {
                        trackMetadata.copyright = trackInfos.COPYRIGHT;
                    }

                    if (trackInfos.ISRC) {
                        trackMetadata.ISRC = trackInfos.ISRC;
                    }

                    if (trackInfos.BPM) {
                        trackMetadata.bpm = trackInfos.BPM;
                    }

                    if (trackInfos.EXPLICIT_LYRICS) {
                        trackMetadata.explicit = trackInfos.EXPLICIT_LYRICS;
                    }

                    if (trackInfos.ARTISTS) {
                        let trackArtists = [];

                        trackInfos.ARTISTS.forEach((trackArtist) => {
                            if (trackArtist.ART_NAME) {
                                trackArtist = trackArtist.ART_NAME.split(new RegExp(' featuring | feat. | Ft. | ft. | vs | vs. | x | - |, ', 'g'));
                                trackArtist = trackArtist.map(Function.prototype.call, String.prototype.trim);

                                trackArtists = trackArtists.concat(trackArtist);
                            }
                        });

                        trackArtists = [...new Set(trackArtists)];
                        trackMetadata.artists = trackArtists;
                    }

                    if (trackInfos.SNG_CONTRIBUTORS) {
                        if (trackInfos.SNG_CONTRIBUTORS.composer) {
                            trackMetadata.composer = trackInfos.SNG_CONTRIBUTORS.composer;
                        }

                        if (trackInfos.SNG_CONTRIBUTORS.musicpublisher) {
                            trackMetadata.publisher = trackInfos.SNG_CONTRIBUTORS.musicpublisher;
                        }

                        if (trackInfos.SNG_CONTRIBUTORS.producer) {
                            trackMetadata.producer = trackInfos.SNG_CONTRIBUTORS.producer;
                        }

                        if (trackInfos.SNG_CONTRIBUTORS.engineer) {
                            trackMetadata.engineer = trackInfos.SNG_CONTRIBUTORS.engineer;
                        }

                        if (trackInfos.SNG_CONTRIBUTORS.writer) {
                            trackMetadata.writer = trackInfos.SNG_CONTRIBUTORS.writer;
                        }

                        if (trackInfos.SNG_CONTRIBUTORS.author) {
                            trackMetadata.author = trackInfos.SNG_CONTRIBUTORS.author;
                        }

                        if (trackInfos.SNG_CONTRIBUTORS.mixer) {
                            trackMetadata.mixer = trackInfos.SNG_CONTRIBUTORS.mixer;
                        }
                    }

                    if ('Various Artists' === trackMetadata.performerInfo) {
                        trackMetadata.compilation = 1;
                    } else {
                        trackMetadata.compilation = 0;
                    }

                    if (trackInfos.LYRICS) {
                        if (trackInfos.LYRICS.LYRICS_TEXT) {
                            trackMetadata.unsynchronisedLyrics = trackInfos.LYRICS.LYRICS_TEXT;
                        }

                        if (trackInfos.LYRICS.LYRICS_SYNC_JSON) {
                            const syncedLyrics = trackInfos.LYRICS.LYRICS_SYNC_JSON;

                            for (let i = 0; i < syncedLyrics.length; i++) {
                                if (syncedLyrics[i].lrc_timestamp) {
                                    trackMetadata.synchronisedLyrics += syncedLyrics[i].lrc_timestamp + syncedLyrics[i].line + '\r\n';
                                } else if (i + 1 < syncedLyrics.length) {
                                    trackMetadata.synchronisedLyrics += syncedLyrics[i + 1].lrc_timestamp + syncedLyrics[i].line + '\r\n';
                                }
                            }
                        }
                    }

                    let saveFilePathExtension = nodePath.extname(saveFilePath);

                    if ('.mp3' === saveFilePathExtension) {
                        if ('' !== trackMetadata.synchronisedLyrics.trim()) {
                            const lyricsFile = saveFilePath.slice(0, -4) + '.lrc';

                            ensureDir(lyricsFile);
                            fs.writeFileSync(lyricsFile, trackMetadata.synchronisedLyrics);
                        }

                        const writer = new id3Writer(decryptedTrackBuffer);
                        let coverBuffer;

                        if (albumCoverSavePath && fs.existsSync(albumCoverSavePath)) {
                            coverBuffer = fs.readFileSync(albumCoverSavePath);
                        }

                        writer
                            .setFrame('TIT2', trackMetadata.title)
                            .setFrame('TALB', trackMetadata.album)
                            .setFrame('TCON', [trackMetadata.genre])
                            .setFrame('TPE2', trackMetadata.albumArtist)
                            .setFrame('TPE1', [trackMetadata.artists.join(', ')])
                            .setFrame('TRCK', trackMetadata.trackNumberCombined)
                            .setFrame('TPOS', trackMetadata.partOfSetCombined)
                            .setFrame('TCOP', trackMetadata.copyright)
                            .setFrame('TPUB', trackMetadata.publisher.join('/'))
                            .setFrame('TMED', trackMetadata.media)
                            .setFrame('TCOM', trackMetadata.composer)
                            .setFrame('TXXX', {
                                description: 'Artists',
                                value: trackMetadata.artists.join('/')
                            })
                            .setFrame('TXXX', {
                                description: 'RELEASETYPE',
                                value: trackMetadata.releaseType
                            })
                            .setFrame('TXXX', {
                                description: 'ISRC',
                                value: trackMetadata.ISRC
                            })
                            .setFrame('TXXX', {
                                description: 'BARCODE',
                                value: trackMetadata.upc
                            })
                            .setFrame('TXXX', {
                                description: 'LABEL',
                                value: trackMetadata.label
                            })
                            .setFrame('TXXX', {
                                description: 'LYRICIST',
                                value: trackMetadata.writer.join('/')
                            })
                            .setFrame('TXXX', {
                                description: 'MIXARTIST',
                                value: trackMetadata.mixer.join('/')
                            })
                            .setFrame('TXXX', {
                                description: 'INVOLVEDPEOPLE',
                                value: trackMetadata.producer.concat(trackMetadata.engineer).join('/')
                            })
                            .setFrame('TXXX', {
                                description: 'COMPILATION',
                                value: trackMetadata.compilation
                            })
                            .setFrame('TXXX', {
                                description: 'EXPLICIT',
                                value: trackMetadata.explicit
                            })
                            .setFrame('TXXX', {
                                description: 'SOURCE',
                                value: 'Deezer'
                            })
                            .setFrame('TXXX', {
                                description: 'SOURCEID',
                                value: trackInfos.SNG_ID
                            });

                        if ('' !== trackMetadata.unsynchronisedLyrics) {
                            writer.setFrame('USLT', {
                                description: '',
                                lyrics: trackMetadata.unsynchronisedLyrics
                            });
                        }

                        if (coverBuffer) {
                            writer.setFrame('APIC', {
                                type: 3,
                                data: coverBuffer,
                                description: ''
                            });
                        }

                        if (0 < parseInt(trackMetadata.releaseYear)) {
                            writer.setFrame('TYER', trackMetadata.releaseYear);
                        }

                        if (0 < parseInt(trackMetadata.releaseDate)) {
                            writer.setFrame('TDAT', trackMetadata.releaseDate);
                        }

                        if (0 < parseInt(trackMetadata.bpm)) {
                            writer.setFrame('TBPM', trackMetadata.bpm);
                        }

                        writer.addTag();

                        const taggedTrackBuffer = Buffer.from(writer.arrayBuffer);

                        ensureDir(saveFilePath);
                        fs.writeFileSync(saveFilePath, taggedTrackBuffer);

                        resolve();
                    } else if ('.flac' === saveFilePathExtension) {
                        if ('' !== trackMetadata.synchronisedLyrics.trim()) {
                            const lyricsFile = saveFilePath.slice(0, -5) + '.lrc';

                            ensureDir(lyricsFile);
                            fs.writeFileSync(lyricsFile, trackMetadata.synchronisedLyrics);
                        }

                        let flacComments = [
                            'SOURCE=Deezer',
                            'SOURCEID=' + trackInfos.SNG_ID
                        ];

                        if ('' !== trackMetadata.title) {
                            flacComments.push('TITLE=' + trackMetadata.title);
                        }

                        if ('' !== trackMetadata.album) {
                            flacComments.push('ALBUM=' + trackMetadata.album);
                        }

                        if ('' !== trackMetadata.genre) {
                            flacComments.push('GENRE=' + trackMetadata.genre);
                        }

                        if ('' !== trackMetadata.albumArtist) {
                            flacComments.push('ALBUMARTIST=' + trackMetadata.albumArtist);
                        }

                        if (0 < trackMetadata.artists.length) {
                            flacComments.push('ARTIST=' + trackMetadata.artists.join(', '));
                        }

                        if ('' !== trackMetadata.trackNumber) {
                            flacComments.push('TRACKNUMBER=' + trackMetadata.trackNumber);
                        }

                        if ('' !== trackMetadata.tracktotal) {
                            flacComments.push('TRACKTOTAL=' + trackMetadata.tracktotal);
                            flacComments.push('TOTALTRACKS=' + trackMetadata.tracktotal);
                        }

                        if ('' !== trackMetadata.partOfSet) {
                            flacComments.push('DISCNUMBER=' + trackMetadata.partOfSet);
                        }

                        if ('' !== trackMetadata.disctotal) {
                            flacComments.push('DISCTOTAL=' + trackMetadata.disctotal);
                            flacComments.push('TOTALDISCS=' + trackMetadata.disctotal);
                        }

                        if ('' !== trackMetadata.label) {
                            flacComments.push('LABEL=' + trackMetadata.label);
                        }

                        if ('' !== trackMetadata.copyright) {
                            flacComments.push('COPYRIGHT=' + trackMetadata.copyright);
                        }

                        if ('' !== trackMetadata.duration) {
                            flacComments.push('LENGTH=' + trackMetadata.duration);
                        }

                        if ('' !== trackMetadata.ISRC) {
                            flacComments.push('ISRC=' + trackMetadata.ISRC);
                        }

                        if ('' !== trackMetadata.upc) {
                            flacComments.push('BARCODE=' + trackMetadata.upc);
                        }

                        if ('' !== trackMetadata.media) {
                            flacComments.push('MEDIA=' + trackMetadata.media);
                        }

                        if ('' !== trackMetadata.compilation) {
                            flacComments.push('COMPILATION=' + trackMetadata.compilation);
                        }

                        if ('' !== trackMetadata.explicit) {
                            flacComments.push('EXPLICIT=' + trackMetadata.explicit);
                        }

                        if (trackMetadata.releaseType) {
                            flacComments.push('RELEASETYPE=' + trackMetadata.releaseType);
                        }

                        trackMetadata.artists.forEach((artist) => {
                            flacComments.push('ARTISTS=' + artist);
                        });

                        trackMetadata.composer.forEach((composer) => {
                            flacComments.push('COMPOSER=' + composer);
                        });

                        trackMetadata.publisher.forEach((publisher) => {
                            flacComments.push('ORGANIZATION=' + publisher);
                        });

                        trackMetadata.producer.forEach((producer) => {
                            flacComments.push('PRODUCER=' + producer);
                        });

                        trackMetadata.engineer.forEach((engineer) => {
                            flacComments.push('ENGINEER=' + engineer);
                        });

                        trackMetadata.writer.forEach((writer) => {
                            flacComments.push('WRITER=' + writer);
                        });

                        trackMetadata.author.forEach((author) => {
                            flacComments.push('AUTHOR=' + author);
                        });

                        trackMetadata.mixer.forEach((mixer) => {
                            flacComments.push('MIXER=' + mixer);
                        });

                        if (trackMetadata.unsynchronisedLyrics) {
                            flacComments.push('LYRICS=' + trackMetadata.unsynchronisedLyrics);
                        }

                        if (0 < parseInt(trackMetadata.releaseYear)) {
                            flacComments.push('YEAR=' + trackMetadata.releaseYear);
                        }

                        if (0 < parseInt(trackMetadata.releaseDate)) {
                            flacComments.push('DATE=' + trackMetadata.releaseDate);
                        }

                        if (0 < parseInt(trackMetadata.bpm)) {
                            flacComments.push('BPM=' + trackMetadata.bpm);
                        }

                        const reader = new stream.PassThrough();
                        reader.end(decryptedTrackBuffer);

                        ensureDir(saveFilePath);

                        const writer = fs.createWriteStream(saveFilePath);
                        let processor = new flacMetadata.Processor({parseMetaDataBlocks: true});
                        let vendor = 'reference libFLAC 1.2.1 20070917';
                        let coverBuffer;

                        if (albumCoverSavePath && fs.existsSync(albumCoverSavePath)) {
                            coverBuffer = fs.readFileSync(albumCoverSavePath);
                        }

                        let mdbVorbisComment;
                        let mdbVorbisPicture;

                        processor.on('preprocess', (mdb) => {
                            // Remove existing VORBIS_COMMENT and PICTURE blocks, if any.
                            if (flacMetadata.Processor.MDB_TYPE_VORBIS_COMMENT === mdb.type) {
                                mdb.remove();
                            } else if (coverBuffer && flacMetadata.Processor.MDB_TYPE_PICTURE === mdb.type) {
                                mdb.remove();
                            }

                            if (mdb.isLast) {
                                mdbVorbisComment = flacMetadata.data.MetaDataBlockVorbisComment.create(!coverBuffer, vendor, flacComments);

                                if (coverBuffer) {
                                    mdbVorbisPicture = flacMetadata.data.MetaDataBlockPicture.create(true, 3, 'image/jpeg', '', 1400, 1400, 24, 0, coverBuffer);
                                }

                                mdb.isLast = false;
                            }
                        });

                        processor.on('postprocess', (mdb) => {
                            if (flacMetadata.Processor.MDB_TYPE_VORBIS_COMMENT === mdb.type && null !== mdb.vendor) {
                                vendor = mdb.vendor;
                            }

                            if (mdbVorbisComment) {
                                processor.push(mdbVorbisComment.publish());
                            }

                            if (mdbVorbisPicture) {
                                processor.push(mdbVorbisPicture.publish());
                            }
                        });

                        reader.on('end', () => {
                            resolve();
                        });

                        reader.pipe(processor).pipe(writer);
                    }
                }
            } catch (err) {

                if (10 > numberRetry) {
                    numberRetry += 1;

                    setTimeout(() => {
                        addTrackTags(decryptedTrackBuffer, trackInfos, saveFilePath, numberRetry).then(() => {
                            resolve();
                        }).catch(() => {
                            reject();
                        });
                    }, 500);
                } else {
                    ensureDir(saveFilePath);
                    fs.writeFileSync(saveFilePath, decryptedTrackBuffer);

                    reject();
                }
            }
        }
    });
}