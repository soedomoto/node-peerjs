let wrtc = null;
try {
    wrtc = require('get-browser-rtc')() || require('wrtc');
} catch (err) { }

module.exports = wrtc;