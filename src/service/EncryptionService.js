const crypto = require('crypto');

module.exports = class EncryptionService {

    getSongFileName(trackInfos, trackQuality) {
        const step1 = [trackInfos.MD5_ORIGIN, trackQuality, trackInfos.SNG_ID, trackInfos.MEDIA_VERSION].join('¤');

        let step2 = crypto.createHash('md5').update(step1, 'ascii').digest('hex') + '¤' + step1 + '¤';
        while (step2.length % 16 > 0) step2 += ' ';

        return crypto.createCipheriv('aes-128-ecb', 'jo6aey6haid2Teih', '').update(step2, 'ascii', 'hex');
    }


    /**
     * Calculate the blowfish key to decrypt the track
     *
     * @param {Object} trackInfos
     */
    getBlowfishKey(trackInfos) {
        const SECRET = 'g4el58wc0zvf9na1';

        const idMd5 = crypto.createHash('md5').update(trackInfos.SNG_ID.toString(), 'ascii').digest('hex');
        let bfKey = '';

        for (let i = 0; i < 16; i++) {
            bfKey += String.fromCharCode(idMd5.charCodeAt(i) ^ idMd5.charCodeAt(i + 16) ^ SECRET.charCodeAt(i));
        }

        return bfKey;
    }

    /**
     * Decrypt a deezer track.
     *
     * @param {Buffer} trackBuffer
     * @param {Object} trackInfos
     *
     * @return {Buffer}
     */
    decryptTrack(trackBuffer, trackInfos) {
        const blowFishKey = this.getBlowfishKey(trackInfos);

        let decryptedBuffer = Buffer.alloc(trackBuffer.length);
        let chunkSize = 2048;
        let progress = 0;

        while (progress < trackBuffer.length) {
            if ((trackBuffer.length - progress) < 2048) {
                chunkSize = trackBuffer.length - progress;
            }

            let encryptedChunk = trackBuffer.slice(progress, progress + chunkSize);

            // Only decrypt every third chunk and only if not at the end
            if (progress % (chunkSize * 3) === 0 && chunkSize === 2048) {
                let cipher = crypto.createDecipheriv('bf-cbc', blowFishKey, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
                cipher.setAutoPadding(false);

                encryptedChunk = Buffer.concat([cipher.update(encryptedChunk), cipher.final()]);
            }

            decryptedBuffer.write(encryptedChunk.toString('binary'), progress, encryptedChunk.length, 'binary');

            progress += chunkSize;
        }

        return decryptedBuffer;
    }
};