const sLogger = require('../src/logger');
const LogLevel = sLogger.LogLevel;
const logger = sLogger.logger;

logger.logLevel = LogLevel.All;
logger.setLogFunction = (...c) => console.log(c)

const Peer = require('../src/peer');
var peer = new Peer();

peer.on('open', function (id) {
  console.log('My peer ID is: ' + id);

  var conn = peer.connect('c895df8e-1705-4a68-81e7-efaa4d55c180');
  // on open will be launch when you successfully connect to PeerServer
  conn.on('open', function () {
    // here you have conn.id
    conn.send('hi!');
  });

  conn.on('data', function (data) {
    // Will print 'hi!'
    console.log(data);
  });
});