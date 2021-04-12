const Blob = require('cross-blob');

const enums = require('./enums');
const ConnectionType = enums.ConnectionType;
const ConnectionEventType = enums.ConnectionEventType;
const SerializationType = enums.SerializationType;
const ServerMessageType = enums.ServerMessageType;

const sLogger = require('./logger');
const logger = sLogger.logger;

const util = require('./util');
const BaseConnection = require('./baseconnection');
const EncodingQueue = require('./encodingQueue');
const Negotiator = require('./negotiator');

/**
 * Wraps a DataChannel between two Peers.
 */
class DataConnection extends BaseConnection {
  static ID_PREFIX = "dc_";
  static MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;

  _negotiator;
  label;
  serialization;
  reliable;
  stringify = JSON.stringify;
  parse = JSON.parse;

  get type() {
    return ConnectionType.Data;
  }

  _buffer = [];
  _bufferSize = 0;
  _buffering = false;
  _chunkedData = {};

  _dc;
  _encodingQueue = new EncodingQueue();

  get dataChannel() {
    return this._dc;
  }

  get bufferSize() { return this._bufferSize; }

  constructor(peerId, provider, options) {
    super(peerId, provider, options);

    this.connectionId =
      this.options.connectionId || DataConnection.ID_PREFIX + util.randomToken();

    this.label = this.options.label || this.connectionId;
    this.serialization = this.options.serialization || SerializationType.Binary;
    this.reliable = !!this.options.reliable;

    this._encodingQueue.on('done', (ab) => {
      this._bufferedSend(ab);
    });

    this._encodingQueue.on('error', () => {
      logger.error(`DC#${this.connectionId}: Error occured in encoding from blob to arraybuffer, close DC`);
      this.close();
    });

    this._negotiator = new Negotiator(this);

    this._negotiator.startConnection(
      this.options._payload || {
        originator: true
      }
    );
  }

  /** Called by the Negotiator when the DataChannel is ready. */
  initialize(dc) {
    this._dc = dc;
    this._configureDataChannel();
  }

  _configureDataChannel() {
    if (!util.supports.binaryBlob || util.supports.reliable) {
      this.dataChannel.binaryType = "arraybuffer";
    }

    this.dataChannel.onopen = () => {
      logger.log(`DC#${this.connectionId} dc connection success`);
      this._open = true;
      this.emit(ConnectionEventType.Open);
    };

    this.dataChannel.onmessage = (e) => {
      logger.log(`DC#${this.connectionId} dc onmessage:`, e.data);
      this._handleDataMessage(e);
    };

    this.dataChannel.onclose = () => {
      logger.log(`DC#${this.connectionId} dc closed for:`, this.peer);
      this.close();
    };
  }

  // Handles a DataChannel message.
  _handleDataMessage({ data }) {
    const datatype = data.constructor;

    const isBinarySerialization = this.serialization === SerializationType.Binary ||
      this.serialization === SerializationType.BinaryUTF8;

    let deserializedData = data;

    if (isBinarySerialization) {
      if (datatype === Blob) {
        // Datatype should never be blob
        util.blobToArrayBuffer(data, (ab) => {
          const unpackedData = util.unpack(ab);
          this.emit(ConnectionEventType.Data, unpackedData);
        });
        return;
      } else if (datatype === ArrayBuffer) {
        deserializedData = util.unpack(data);
      } else if (datatype === String) {
        // String fallback for binary data for browsers that don't support binary yet
        const ab = util.binaryStringToArrayBuffer(data);
        deserializedData = util.unpack(ab);
      }
    } else if (this.serialization === SerializationType.JSON) {
      deserializedData = this.parse(data);
    }

    // Check if we've chunked--if so, piece things back together.
    // We're guaranteed that this isn't 0.
    if (deserializedData.__peerData) {
      this._handleChunk(deserializedData);
      return;
    }

    super.emit(ConnectionEventType.Data, deserializedData);
  }

  _handleChunk(data) {
    const id = data.__peerData;
    const chunkInfo = this._chunkedData[id] || {
      data: [],
      count: 0,
      total: data.total
    };

    chunkInfo.data[data.n] = data.data;
    chunkInfo.count++;
    this._chunkedData[id] = chunkInfo;

    if (chunkInfo.total === chunkInfo.count) {
      // Clean up before making the recursive call to `_handleDataMessage`.
      delete this._chunkedData[id];

      // We've received all the chunks--time to construct the complete data.
      const data = new Blob(chunkInfo.data);
      this._handleDataMessage({ data });
    }
  }

  /**
   * Exposed functionality for users.
   */

  /** Allows user to close connection. */
  close() {
    this._buffer = [];
    this._bufferSize = 0;
    this._chunkedData = {};

    if (this._negotiator) {
      this._negotiator.cleanup();
      this._negotiator = null;
    }

    if (this.provider) {
      this.provider._removeConnection(this);

      this.provider = null;
    }

    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.onclose = null;
      this._dc = null;
    }

    if (this._encodingQueue) {
      this._encodingQueue.destroy();
      this._encodingQueue.removeAllListeners();
      this._encodingQueue = null;
    }

    if (!this.open) {
      return;
    }

    this._open = false;

    super.emit(ConnectionEventType.Close);
  }

  /** Allows user to send data. */
  send(data, chunked = false) {
    if (!this.open) {
      super.emit(
        ConnectionEventType.Error,
        new Error(
          "Connection is not open. You should listen for the `open` event before sending messages."
        )
      );
      return;
    }

    if (this.serialization === SerializationType.JSON) {
      this._bufferedSend(this.stringify(data));
    } else if (
      this.serialization === SerializationType.Binary ||
      this.serialization === SerializationType.BinaryUTF8
    ) {
      const blob = util.pack(data);

      if (!chunked && blob.size > util.chunkedMTU) {
        this._sendChunks(blob);
        return;
      }

      if (!util.supports.binaryBlob) {
        // We only do this if we really need to (e.g. blobs are not supported),
        // because this conversion is costly.
        this._encodingQueue.enque(blob);
      } else {
        this._bufferedSend(blob);
      }
    } else {
      this._bufferedSend(data);
    }
  }

  _bufferedSend(msg) {
    if (this._buffering || !this._trySend(msg)) {
      this._buffer.push(msg);
      this._bufferSize = this._buffer.length;
    }
  }

  // Returns true if the send succeeds.
  _trySend(msg) {
    if (!this.open) {
      return false;
    }

    if (this.dataChannel.bufferedAmount > DataConnection.MAX_BUFFERED_AMOUNT) {
      this._buffering = true;
      setTimeout(() => {
        this._buffering = false;
        this._tryBuffer();
      }, 50);

      return false;
    }

    try {
      this.dataChannel.send(msg);
    } catch (e) {
      logger.error(`DC#:${this.connectionId} Error when sending:`, e);
      this._buffering = true;

      this.close();

      return false;
    }

    return true;
  }

  // Try to send the first message in the buffer.
  _tryBuffer() {
    if (!this.open) {
      return;
    }

    if (this._buffer.length === 0) {
      return;
    }

    const msg = this._buffer[0];

    if (this._trySend(msg)) {
      this._buffer.shift();
      this._bufferSize = this._buffer.length;
      this._tryBuffer();
    }
  }

  _sendChunks(blob) {
    const blobs = util.chunk(blob);
    logger.log(`DC#${this.connectionId} Try to send ${blobs.length} chunks...`);

    for (let blob of blobs) {
      this.send(blob, true);
    }
  }

  handleMessage(message) {
    const payload = message.payload;

    switch (message.type) {
      case ServerMessageType.Answer:
        this._negotiator.handleSDP(message.type, payload.sdp);
        break;
      case ServerMessageType.Candidate:
        this._negotiator.handleCandidate(payload.candidate);
        break;
      default:
        logger.warn(
          "Unrecognized message type:",
          message.type,
          "from peer:",
          this.peer
        );
        break;
    }
  }
}

module.exports = DataConnection;