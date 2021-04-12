const EventEmitter = require('eventemitter3');

const util = require('./src/util');
const Socket = require('./src/socket');
const API = require('./src/api');
const DataConnection = require('./src/dataconnection');
const MediaConnection = require('./src/mediaconnection');

const sLogger = require('./src/logger');
const logger = sLogger.logger;

const eNums = require('./src/enums');
const ConnectionType = eNums.ConnectionType;
const SocketEventType = eNums.SocketEventType;
const ServerMessageType = eNums.ServerMessageType;
const PeerEventType = eNums.PeerEventType;
const PeerErrorType = eNums.PeerErrorType;

class Peer extends EventEmitter {
    static DEFAULT_KEY = "peerjs";

    _options;
    _api;
    _socket;

    _id;
    _lastServerId;

    // States.
    _destroyed = false; // Connections have been killed
    _disconnected = false; // Connection to PeerServer killed but P2P connections still active
    _open = false; // Sockets and such are not yet open.
    _connections = new Map(); // All connections for this peer.
    _lostMessages = new Map(); // src => [list of messages]

    get id() {
        return this._id;
    }

    get options() {
        return this._options;
    }

    get open() {
        return this._open;
    }

    get socket() {
        return this._socket;
    }

    /**
     * @deprecated 
     * Return type will change from Object to Map<string,[]> 
     */
    get connections() {
        const plainConnections = Object.create(null);

        this._connections.forEach((v, k) => {
            plainConnections[k] = v;
        });

        for (let [k, v] of this._connections) {
            plainConnections[k] = v;
        }

        return plainConnections;
    }

    get destroyed() {
        return this._destroyed;
    }
    get disconnected() {
        return this._disconnected;
    }

    constructor(id, options) {
        super();

        let userId;

        // Deal with overloading
        if (id && id.constructor == Object) {
            options = id;
        } else if (id) {
            userId = id.toString();
        }

        options = {
            debug: 0, // 1: Errors, 2: Warnings, 3: All logs
            host: util.CLOUD_HOST,
            port: util.CLOUD_PORT,
            path: "/",
            secure: true,
            key: Peer.DEFAULT_KEY,
            token: util.randomToken(),
            config: util.defaultConfig,
            ...options
        };
        this._options = options;

        this._api = new API(options);
        this._socket = this._createServerConnection();

        // Sanity checks
        // Ensure WebRTC supported
        if (!util.supports.audioVideo && !util.supports.data) {
            this._delayedAbort(
                PeerErrorType.BrowserIncompatible,
                "The current browser does not support WebRTC"
            );
            return;
        }

        // Ensure alphanumeric id
        if (!!userId && !util.validateId(userId)) {
            this._delayedAbort(PeerErrorType.InvalidID, `ID "${userId}" is invalid`);
            return;
        }

        if (userId) {
            this._initialize(userId);
        } else {
            this._api.retrieveId()
                .then(id => this._initialize(id))
                .catch(error => this._abort(PeerErrorType.ServerError, error));
        }
    }

    _createServerConnection() {
        const socket = new Socket(
            this._options.secure,
            this._options.host,
            this._options.port,
            this._options.path,
            this._options.key,
            this._options.pingInterval
        );

        socket.on(SocketEventType.Message, (data) => {
            this._handleMessage(data);
        });

        socket.on(SocketEventType.Error, (error) => {
            this._abort(PeerErrorType.SocketError, error);
        });

        socket.on(SocketEventType.Disconnected, () => {
            if (this.disconnected) {
                return;
            }

            this.emitError(PeerErrorType.Network, "Lost connection to server.");
            this.disconnect();
        });

        socket.on(SocketEventType.Close, () => {
            if (this.disconnected) {
                return;
            }

            this._abort(PeerErrorType.SocketClosed, "Underlying socket is already closed.");
        });

        return socket;
    }

    _initialize(id) {
        this._id = id;
        this.socket.start(id, this._options.token);
    }

    _handleMessage(message) {
        const type = message.type;
        const payload = message.payload;
        const peerId = message.src;

        switch (type) {
            case ServerMessageType.Open: // The connection to the server is open.
                this._lastServerId = this.id;
                this._open = true;
                this.emit(PeerEventType.Open, this.id);
                break;
            case ServerMessageType.Error: // Server error.
                this._abort(PeerErrorType.ServerError, payload.msg);
                break;
            case ServerMessageType.IdTaken: // The selected ID is taken.
                this._abort(PeerErrorType.UnavailableID, `ID "${this.id}" is taken`);
                break;
            case ServerMessageType.InvalidKey: // The given API key cannot be found.
                this._abort(PeerErrorType.InvalidKey, `API KEY "${this._options.key}" is invalid`);
                break;
            case ServerMessageType.Leave: // Another peer has closed its connection to this peer.
                logger.log(`Received leave message from ${peerId}`);
                this._cleanupPeer(peerId);
                this._connections.delete(peerId);
                break;
            case ServerMessageType.Expire: // The offer sent to a peer has expired without response.
                this.emitError(PeerErrorType.PeerUnavailable, `Could not connect to peer ${peerId}`);
                break;
            case ServerMessageType.Offer: {
                // we should consider switching this to CALL/CONNECT, but this is the least breaking option.
                const connectionId = payload.connectionId;
                let connection = this.getConnection(peerId, connectionId);

                if (connection) {
                    connection.close();
                    logger.warn(`Offer received for existing Connection ID:${connectionId}`);
                }

                // Create a new connection.
                if (payload.type === ConnectionType.Media) {
                    connection = new MediaConnection(peerId, this, {
                        connectionId: connectionId,
                        _payload: payload,
                        metadata: payload.metadata
                    });
                    this._addConnection(peerId, connection);
                    this.emit(PeerEventType.Call, connection);
                } else if (payload.type === ConnectionType.Data) {
                    connection = new DataConnection(peerId, this, {
                        connectionId: connectionId,
                        _payload: payload,
                        metadata: payload.metadata,
                        label: payload.label,
                        serialization: payload.serialization,
                        reliable: payload.reliable
                    });
                    this._addConnection(peerId, connection);
                    this.emit(PeerEventType.Connection, connection);
                } else {
                    logger.warn(`Received malformed connection type:${payload.type}`);
                    return;
                }

                // Find messages.
                const messages = this._getMessages(connectionId);
                for (let message of messages) {
                    connection.handleMessage(message);
                }

                break;
            }
            default: {
                if (!payload) {
                    logger.warn(`You received a malformed message from ${peerId} of type ${type}`);
                    return;
                }

                const connectionId = payload.connectionId;
                const connection = this.getConnection(peerId, connectionId);

                if (connection && connection.peerConnection) {
                    // Pass it on.
                    connection.handleMessage(message);
                } else if (connectionId) {
                    // Store for possible later use
                    this._storeMessage(connectionId, message);
                } else {
                    logger.warn("You received an unrecognized message:", message);
                }
                break;
            }
        }
    }

    _storeMessage(connectionId, message) {
        if (!this._lostMessages.has(connectionId)) {
            this._lostMessages.set(connectionId, []);
        }

        this._lostMessages.get(connectionId).push(message);
    }

    _getMessages(connectionId) {
        const messages = this._lostMessages.get(connectionId);

        if (messages) {
            this._lostMessages.delete(connectionId);
            return messages;
        }

        return [];
    }

    connect(peer, options = {}) {
        if (this.disconnected) {
            logger.warn(
                "You cannot connect to a new Peer because you called " +
                ".disconnect() on this Peer and ended your connection with the " +
                "server. You can create a new Peer to reconnect, or call reconnect " +
                "on this peer if you believe its ID to still be available."
            );
            this.emitError(
                PeerErrorType.Disconnected,
                "Cannot connect to new Peer after disconnecting from server."
            );
            return;
        }

        const dataConnection = new DataConnection(peer, this, options);
        this._addConnection(peer, dataConnection);
        return dataConnection;
    }

    call(peer, stream, options) {
        if (this.disconnected) {
            logger.warn(
                "You cannot connect to a new Peer because you called " +
                ".disconnect() on this Peer and ended your connection with the " +
                "server. You can create a new Peer to reconnect."
            );
            this.emitError(
                PeerErrorType.Disconnected,
                "Cannot connect to new Peer after disconnecting from server."
            );
            return;
        }

        if (!stream) {
            logger.error(
                "To call a peer, you must provide a stream from your browser's `getUserMedia`."
            );
            return;
        }

        options._stream = stream;

        const mediaConnection = new MediaConnection(peer, this, options);
        this._addConnection(peer, mediaConnection);
        return mediaConnection;
    }

    _addConnection(peerId, connection) {
        logger.log(`add connection ${connection.type}:${connection.connectionId} to peerId:${peerId}`);

        if (!this._connections.has(peerId)) {
            this._connections.set(peerId, []);
        }
        this._connections.get(peerId).push(connection);
    }

    _removeConnection(connection) {
        const connections = this._connections.get(connection.peer);

        if (connections) {
            const index = connections.indexOf(connection);

            if (index !== -1) {
                connections.splice(index, 1);
            }
        }

        //remove from lost messages
        this._lostMessages.delete(connection.connectionId);
    }

    getConnection(peerId, connectionId) {
        const connections = this._connections.get(peerId);
        if (!connections) {
            return null;
        }

        connections.forEach(connection => {
            if (connection.connectionId === connectionId) {
                return connection;
            }
        });

        return null;
    }

    _delayedAbort(type, message) {
        setTimeout(() => {
            this._abort(type, message);
        }, 0);
    }

    _abort(type, message) {
        logger.error("Aborting!");

        this.emitError(type, message);

        if (!this._lastServerId) {
            this.destroy();
        } else {
            this.disconnect();
        }
    }

    emitError(type, err) {
        logger.error("Error:", err);

        let error;

        if (typeof err === "string") {
            error = new Error(err);
        } else {
            error = err;
        }

        error.type = type;

        this.emit(PeerEventType.Error, error);
    }

    destroy() {
        if (this.destroyed) {
            return;
        }

        logger.log(`Destroy peer with ID:${this.id}`);

        this.disconnect();
        this._cleanup();

        this._destroyed = true;

        this.emit(PeerEventType.Close);
    }

    _cleanup() {
        Object.keys(this._connections).forEach(peerId => {
            this._cleanupPeer(peerId);
            this._connections.delete(peerId);
        });

        this.socket.removeAllListeners();
    }

    _cleanupPeer(peerId) {
        const connections = this._connections.get(peerId);

        if (!connections) return;

        connections.forEach(connection => {
            connection.close();
        });
    }

    disconnect() {
        if (this.disconnected) {
            return;
        }

        const currentId = this.id;

        logger.log(`Disconnect peer with ID:${currentId}`);

        this._disconnected = true;
        this._open = false;

        this.socket.close();

        this._lastServerId = currentId;
        this._id = null;

        this.emit(PeerEventType.Disconnected, currentId);
    }
}

module.exports = Peer