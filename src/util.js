const wrtc = require('./wrtc');

var isBrowser = new Function("try {return this===window;}catch(e){ return false;}");

// let BinaryPack = null;
// if (! isBrowser()) {
//     BinaryPack = require('ns-binarypack');
// } else {
//     BinaryPack = require('peerjs-js-binarypack');
// }

BinaryPack = require('./binarypack');

const DEFAULT_CONFIG = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "turn:0.peerjs.com:3478", username: "peerjs", credential: "peerjsp" }
    ],
    sdpSemantics: "unified-plan"
};

module.exports = new class {
    CLOUD_HOST = "0.peerjs.com";
    CLOUD_PORT = 443;

    defaultConfig = DEFAULT_CONFIG;

    noop() { }

    randomToken() {
        return Math.random()
            .toString(36)
            .substr(2);
    }

    supports = (function () {
        const supported = {
            browser: true,
            webRTC: true,
            audioVideo: false,
            data: false,
            binaryBlob: false,
            reliable: false,
        };

        if (!supported.webRTC) return supported;

        let pc;

        try {
            pc = new wrtc.RTCPeerConnection(DEFAULT_CONFIG);

            supported.audioVideo = true;

            let dc;

            try {
                dc = pc.createDataChannel("_PEERJSTEST", { ordered: true });
                supported.data = true;
                supported.reliable = !!dc.ordered;

                // Binary test
                try {
                    dc.binaryType = "blob";
                    supported.binaryBlob = true;
                } catch (e) {
                }
            } catch (e) {
            } finally {
                if (dc) {
                    dc.close();
                }
            }
        } catch (e) {
        } finally {
            if (pc) {
                pc.close();
            }
        }

        return supported;
    })();

    validateId(id) {
        // Allow empty ids
        return !id || /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/.test(id);
    }

    pack = BinaryPack.pack;
    unpack = BinaryPack.unpack;
}