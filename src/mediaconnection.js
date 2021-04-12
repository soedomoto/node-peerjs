const util = require('./util');
const BaseConnection = require('./baseconnection');
const Negotiator = require('./negotiator');

const sLogger = require('./logger');
const logger = sLogger.logger;

const enums = require('./enums');
const ConnectionType = enums.ConnectionType;
const ConnectionEventType = enums.ConnectionEventType;
const ServerMessageType = enums.ServerMessageType;


/**
 * Wraps the streaming interface between two Peers.
 */
class MediaConnection extends BaseConnection {
  static ID_PREFIX = "mc_";

  _negotiator;
  _localStream;
  _remoteStream;

  get type() {
    return ConnectionType.Media;
  }

  get localStream() { return this._localStream; }
  get remoteStream() { return this._remoteStream; }

  constructor(peerId, provider, options) {
    super(peerId, provider, options);

    this._localStream = this.options._stream;
    this.connectionId =
      this.options.connectionId ||
      MediaConnection.ID_PREFIX + util.randomToken();

    this._negotiator = new Negotiator(this);

    if (this._localStream) {
      this._negotiator.startConnection({
        _stream: this._localStream,
        originator: true
      });
    }
  }

  addStream(remoteStream) {
    logger.log("Receiving stream", remoteStream);

    this._remoteStream = remoteStream;
    super.emit(ConnectionEventType.Stream, remoteStream); // Should we call this `open`?
  }

  handleMessage(message) {
    const type = message.type;
    const payload = message.payload;

    switch (message.type) {
      case ServerMessageType.Answer:
        // Forward to negotiator
        this._negotiator.handleSDP(type, payload.sdp);
        this._open = true;
        break;
      case ServerMessageType.Candidate:
        this._negotiator.handleCandidate(payload.candidate);
        break;
      default:
        logger.warn(`Unrecognized message type:${type} from peer:${this.peer}`);
        break;
    }
  }

  answer(stream, options = {}) {
    if (this._localStream) {
      logger.warn(
        "Local stream already exists on this MediaConnection. Are you answering a call twice?"
      );
      return;
    }

    this._localStream = stream;

    if (options && options.sdpTransform) {
      this.options.sdpTransform = options.sdpTransform;
    }

    this._negotiator.startConnection({ ...this.options._payload, _stream: stream });
    // Retrieve lost messages stored because PeerConnection not set up.
    const messages = this.provider._getMessages(this.connectionId);

    for (let message of messages) {
      this.handleMessage(message);
    }

    this._open = true;
  }

  /**
   * Exposed functionality for users.
   */

  /** Allows user to close connection. */
  close() {
    if (this._negotiator) {
      this._negotiator.cleanup();
      this._negotiator = null;
    }

    this._localStream = null;
    this._remoteStream = null;

    if (this.provider) {
      this.provider._removeConnection(this);

      this.provider = null;
    }

    if (this.options && this.options._stream) {
      this.options._stream = null;
    }

    if (!this.open) {
      return;
    }

    this._open = false;

    super.emit(ConnectionEventType.Close);
  }
}

module.exports = MediaConnection