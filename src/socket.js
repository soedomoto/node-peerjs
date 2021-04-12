const EventEmitter = require('eventemitter3');
const WebSocket = require('ws');

const sLogger = require('./logger');
const logger = sLogger.logger;

const enums = require('./enums');
const SocketEventType = enums.SocketEventType;
const ServerMessageType = enums.ServerMessageType;

/**
 * An abstraction on top of WebSockets to provide fastest
 * possible connection for peers.
 */
class Socket extends EventEmitter {
  _disconnected = true;
  _id;
  _messagesQueue = [];
  _socket;
  _wsPingTimer;
  _baseUrl;

  constructor(
    secure,
    host,
    port,
    path,
    key,
    pingInterval = 5000,
  ) {
    super();

    this.secure = secure;
    this.host = host;
    this.port = port;
    this.path = path;
    this.key = key;
    this.pingInterval = pingInterval;

    const wsProtocol = secure ? "wss://" : "ws://";

    this._baseUrl = wsProtocol + host + ":" + port + path + "peerjs?key=" + key;
  }

  start(id, token) {
    this._id = id;

    const wsUrl = `${this._baseUrl}&id=${id}&token=${token}`;

    if (!!this._socket || !this._disconnected) {
      return;
    }

    this._socket = new WebSocket(wsUrl);
    this._disconnected = false;

    this._socket.onmessage = (event) => {
      let data;

      try {
        data = JSON.parse(event.data);
        logger.log("Server message received:", data);
      } catch (e) {
        logger.log("Invalid server message", event.data);
        return;
      }

      this.emit(SocketEventType.Message, data);
    };

    this._socket.onclose = (event) => {
      if (this._disconnected) {
        return;
      }

      logger.log("Socket closed.", event);

      this._cleanup();
      this._disconnected = true;

      this.emit(SocketEventType.Disconnected);
    };

    // Take care of the queue of connections if necessary and make sure Peer knows
    // socket is open.
    this._socket.onopen = () => {
      if (this._disconnected) {
        return;
      }

      this._sendQueuedMessages();

      logger.log("Socket open");

      this._scheduleHeartbeat();
    };
  }

  _scheduleHeartbeat() {
    this._wsPingTimer = setTimeout(() => {
      this._sendHeartbeat();
    }, this.pingInterval);
  }

  _sendHeartbeat() {
    if (!this._wsOpen()) {
      logger.log(`Cannot send heartbeat, because socket closed`);
      return;
    }

    const message = JSON.stringify({ type: ServerMessageType.Heartbeat });

    if (this._socket) this._socket.send(message);

    this._scheduleHeartbeat();
  }

  /** Is the websocket currently open? */
  _wsOpen() {
    return !!this._socket && this._socket.readyState === 1;
  }

  /** Send queued messages. */
  _sendQueuedMessages() {
    //Create copy of queue and clear it,
    //because send method push the message back to queue if smth will go wrong
    const copiedQueue = [...this._messagesQueue];
    this._messagesQueue = [];

    for (const message of copiedQueue) {
      this.send(message);
    }
  }

  /** Exposed send for DC & Peer. */
  send(data) {
    if (this._disconnected) {
      return;
    }

    // If we didn't get an ID yet, we can't yet send anything so we should queue
    // up these messages.
    if (!this._id) {
      this._messagesQueue.push(data);
      return;
    }

    if (!data.type) {
      this.emit(SocketEventType.Error, "Invalid message");
      return;
    }

    if (!this._wsOpen()) {
      return;
    }

    const message = JSON.stringify(data);

    if (this._socket) this._socket.send(message);
  }

  close() {
    if (this._disconnected) {
      return;
    }

    this._cleanup();

    this._disconnected = true;
  }

  _cleanup() {
    if (this._socket) {
      this._socket.onopen = this._socket.onmessage = this._socket.onclose = null;
      this._socket.close();
      this._socket = undefined;
    }

    if (this._wsPingTimer) clearTimeout(this._wsPingTimer);
  }
}

module.exports = Socket;