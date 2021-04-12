const EventEmitter = require('eventemitter3');

class BaseConnection extends EventEmitter {
  _open = false;

  metadata;
  connectionId;

  peerConnection;

  get type() {};

  get open() {
    return this._open;
  }

  constructor(peer, provider, options) {
    super();

    this.peer = peer;
    this.provider = provider;
    this.options = options;
    this.metadata = options.metadata;
  }

  close() {};

  handleMessage(message) {};
}

module.exports = BaseConnection;
