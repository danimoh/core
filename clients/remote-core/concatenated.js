// TODO wildcard support

class Observable {
    constructor(validEvents) {
        if (Array.isArray(validEvents)) {
            this._validEvents = validEvents;
        } else if (validEvents) {
            this._validEvents = Object.values(validEvents);
        }
        this._listeners = {};
    }

    on(type, callback) {
        if (!this._isValidEvent(type)) {
            throw Error('Unsupported Event Type '+type);
        }
        if (!(type in this._listeners)) {
            this._listeners[type] = [];
        }
        this._listeners[type].push(callback);
    }


    off(type, callback) {
        if (!(type in this._listeners)) {
            return;
        }
        let index = this._listeners[type].indexOf(callback);
        if (index === -1) {
            return;
        }
        this._listeners[type].splice(index, 1);
    }


    once(type, callback) {
        const onceCallback = () => {
            callback();
            this.off(type, onceCallback);
        };
        this.on(type, onceCallback);
    }



    fire(type, arg) {
        if (!(type in this._listeners)) {
            return;
        }
        this._listeners[type].forEach(callback => callback(arg));
    }


    _isValidEvent(type) {
        return !this._validEvents || this._validEvents.indexOf(type) !== -1;
    }
}

/** 
 * A wrapper around WebSocket that supports connection reestablishment
 */
class RemoteConnection extends Observable {
    static get EVENTS() {
        return {
            CONNECTION_ESTABLISHED: 'connection-established',
            CONNECTION_LOST: 'connection-lost',
            CONNECTION_ERROR: 'connection-error',
            MESSAGE: 'message'
        };
    }

    /**
     * Construct a new remote connection.
     * @param url - A websocket URL (protocol ws: or wss: for secure connections) */
    constructor(url) {
        super(RemoteConnection.EVENTS);
        this._url = url;
        this._ws = null;
        this._sendQueue = [];
        this._persistentMessages = []; // messages that should be resend when a new web socket gets opened
        window.addEventListener('online', () => this._setupWebSocket());
        if (navigator.onLine) {
            this._setupWebSocket();
        }
    }

    _setupWebSocket() {
        if (this._ws) return;
        this._ws = new WebSocket(this._url);
        this._ws.onopen = () => {
            // note that the messages do not neccessarily need to arrive in the same order at the server
            this._persistentMessages.forEach(message => this._ws.send(message));
            this._sendQueue.forEach(message => this._ws.send(message));
            this._sendQueue = [];
            this.fire(RemoteConnection.EVENTS.CONNECTION_ESTABLISHED);
        };
        this._ws.onclose = () => {
            // note that onclose also gets called in case that a connection couldn't be established
            this._ws = null;
            this.fire(RemoteConnection.EVENTS.CONNECTION_LOST);
            setTimeout(() => this._setupWebSocket(), 5000); // try to reconnect
        }
        this._ws.onerror = () => {
            // note that in the case of error the onclose also gets triggered
            this._ws = null;
            this.fire(RemoteConnection.EVENTS.CONNECTION_ERROR);
        };
        this._ws.onmessage = event => {
            this.fire(RemoteConnection.EVENTS.MESSAGE, JSON.parse(event.data));
        };
    }

    isConnected() {
        return this._ws && this._ws.readyState === WebSocket.OPEN;
    }

    send(message, persistent) {
        message = JSON.stringify(message);
        if (persistent) {
            this._persistentMessages.push(message);
        }
        if (this.isConnected()) {
            this._ws.send(message);
        } else if (!persistent) {
            // add it to the queue if it isn't persistent anyways
            this._sendQueue.push(message);
        }
    }

    /**
     * Request a data set (e.g. via get-state or accounts-get-balance) and resolve with the data when
     * the server send us he expected message.
     * @param request - A request message that will be send to the server
     * @param expectedMessage - either a string corresponding to the expected message type or a function that checks whether it accepts a message
     */
    request(request, expectedMessage) {
        return new Promise((resolve, reject) => {
            this.send(request);
            const callback = message => {
                if ((typeof(expectedMessage)==='string' && message.type === expectedMessage)
                    || (typeof(expectedMessage)==='function' && expectedMessage(message))) {
                    this.off(RemoteConnection.EVENTS.MESSAGE, callback);
                    resolve(message.data);
                }
            };
            this.on(RemoteConnection.EVENTS.MESSAGE, callback);
        });
    }
}

class RemoteClass extends Observable {
    constructor(identifier, attributes, eventMap, remoteConnection) {
        super(eventMap);
        this._identifier = identifier;
        this._attributes = attributes;
        this._eventMap = eventMap || {};
        this._inverseEventMap = {};
        for (let key in this._eventMap) {
            this._inverseEventMap[this._eventMap[key]] = key;
        }
        this._registeredServerEvents = new Set();
        this._remoteConnection = remoteConnection;
        this._remoteConnection.on('message', message => this._handleEvents(message));
        if (this._remoteConnection.isConnected()) {
            this._updateState();
        }
        // request the current state whenever the connection is (re)established
        this._remoteConnection.on(RemoteConnection.EVENTS.CONNECTION_ESTABLISHED, () => this._updateState());
    }

    _updateState() {
        return this._remoteConnection.request({
            command: 'get-state',
            type: this._identifier
        }, this._identifier)
        .then(data => {
            this._attributes.forEach(attribute => this[attribute] = data[attribute]);
            return data;
        })
    }

    _handleEvents(message) {
        if (message.type in this._eventMap) {
            this.fire(this._eventMap[message.type], message.data);
        }
    }

    on(type, callback, lazyRegister) {
        super.on(type, callback);
        const serverEvent = this._inverseEventMap[type] || type;
        if (!lazyRegister && !this._registeredServerEvents.has(serverEvent)) {
            this._registeredServerEvents.add(serverEvent);
            this._remoteConnection.send({
                command: 'register-listener',
                type: serverEvent
            }, true);
        }
    }

    off(type, callback) {
        super.off(type, callback);
        const serverEvent = this._inverseEventMap[type] || type;
        if ((type in this._listeners) && this._listeners[type].length === 0 && this._registeredServerEvents.has(serverEvent)) {
            this._registeredServerEvents.delete(serverEvent);
            this._remoteConnection.send({
                command: 'unregister-listener',
                type: serverEvent
            }, true);
        }
    }
}

class RemoteAccounts extends RemoteClass {
    static get IDENTIFIER() { return 'accounts'; }
    static get ATTRIBUTES() { return []; }
    static get EVENTS() {
        return {
            POPULATED: 'populated'
        };
    }
    static get COMMANDS() {
        return {
            GET_BALANCE: 'accounts-get-balance',
            GET_HASH: 'accounts-get-hash'
        };
    }
    static get MESSAGE_TYPES() {
        return {
            ACCOUNTS_BALANCE: 'accounts-balance',
            ACCOUNTS_HASH: 'accounts-hash',
            ACCOUNTS_ACCOUNT_CHANGED: 'accounts-account-changed', // this is one is actually a prefix
            ACCOUNTS_POPULATED: 'accounts-populated'
        };
    }
    static get EVENT_MAP() {
        let map = {};
        map[RemoteAccounts.MESSAGE_TYPES.ACCOUNTS_POPULATED] = RemoteAccounts.EVENTS.POPULATED;
        return map;
    }
    

    /**
     * @param remoteConnection - a remote connection to the server
     */
    constructor(remoteConnection) {
        super(RemoteAccounts.IDENTIFIER, RemoteAccounts.ATTRIBUTES, RemoteAccounts.EVENT_MAP, remoteConnection);
        this._registeredAccountListeners = new Set();
    }

    async hash() {
        return this._remoteConnection.request({
            command: RemoteAccounts.COMMANDS.GET_HASH
        }, RemoteAccounts.MESSAGE_TYPES.ACCOUNTS_HASH);
    }

    async getBalance(addressString) {
        addressString = addressString.toLowerCase();
        return this._remoteConnection.request({
            command: RemoteAccounts.COMMANDS.GET_BALANCE,
            address: addressString
        }, message => message.type === RemoteAccounts.MESSAGE_TYPES.ACCOUNTS_BALANCE && message.data.address.toLowerCase() === addressString);
    }

    _updateState() {
        // accounts have no state as they have no member variables
        return;
    }

    _isHex(str) {
        return !(/[^0-9a-f]/.test(str));
    }

    _isValidEvent(type) {
        type = type.toLowerCase();
        if (this._isHex(type)) {
            // a hex address
            return true;
        } else {
            // no hex address, just a normal event
            return super._isValidEvent(type);
        }
    }

    /**
     * @overwrites _handleEvents in RemoteClass
     */
    _handleEvents(message) {
        if (message.type.startsWith(RemoteAccounts.MESSAGE_TYPES.ACCOUNTS_ACCOUNT_CHANGED)) {
            this.fire(message.data.address, {
                balance: {
                    value: message.data.value,
                    nonce: message.data.nonce
                }
            });
        } else {
            super._handleEvents(message);
        }
    }

    /**
     * @overwrites on in RemoteClass
     */
    on(type, callback, lazyRegister) {
        type = type.toLowerCase();
        if (this._isHex(type)) {
            // a hex address
            Observable.prototype.on.call(this, type, callback); /* register the callback in Observer */
            if (!lazyRegister && !this._registeredAccountListeners.has(type)) {
                this._registeredAccountListeners.add(type);
                this._remoteConnection.send({
                    command: 'register-listener',
                    type: RemoteAccounts.MESSAGE_TYPES.ACCOUNTS_ACCOUNT_CHANGED,
                    address: type
                }, true);
            }
        } else {
            // a normal event type
            super.on(type, callback, lazyRegister);
        }
    }

    /**
     * @overwrites off in RemoteClass
     */
    off(type, callback) {
        type = type.toLowerCase();
        if (this._isHex(type)) {
            // a hex address
            Observable.prototype.off.call(this, type, callback); /* remove the callback in Observer */
            if ((type in this._listeners) && this._listeners[type].length === 0 && this._registeredAccountListeners.has(type)) {
                this._registeredAccountListeners.delete(type);
                this._remoteConnection.send({
                    command: 'unregister-listener',
                    type: RemoteAccounts.MESSAGE_TYPES.ACCOUNTS_ACCOUNT_CHANGED,
                    address: type
                }, true);
            }
        } else {
            // a normal event type
            super.off(type, callback);
        }
    }
}

class RemoteBlockchain extends RemoteClass {
    static get IDENTIFIER() { return 'blockchain'; }
    static get ATTRIBUTES() { return ['busy', 'checkpointLoaded', 'head', 'headHash', 'height', 'totalWork']; }
    static get EVENTS() {
        return {
            HEAD_CHANGED: 'head-changed',
            READY: 'ready'
        };
    }
    static get COMMANDS() {
        return {
            BLOCKCHAIN_GET_BLOCK: 'get-block',
            BLOCKCHAIN_GET_NEXT_COMPACT_TARGET: 'blockchain-get-next-compact-target'
        };
    }
    static get MESSAGE_TYPES() {
        return {
            BLOCKCHAIN_HEAD_CHANGED: 'blockchain-head-changed',
            BLOCKCHAIN_READY: 'blockchain-ready',
            BLOCKCHAIN_BLOCK: 'blockchain-block',
            BLOCKCHAIN_NEXT_COMPACT_TARGET: 'blockchain-next-compact-target'
        };
    }
    static get EVENT_MAP() {
        let map = {};
        map[RemoteBlockchain.MESSAGE_TYPES.BLOCKCHAIN_HEAD_CHANGED] = RemoteBlockchain.EVENTS.HEAD_CHANGED;
        map[RemoteBlockchain.MESSAGE_TYPES.BLOCKCHAIN_READY] = RemoteBlockchain.EVENTS.READY;
        return map;
    }

    /**
     * Construct a remote blockchain connected over a remote connection.
     * @param remoteConnection - a remote connection to the server
     * @param accounts - $.accounts, to compute accountsHash
     * @param live - if true, the blockchain auto updates and requests an event listener itself
     */
    constructor(remoteConnection, accounts, live) {
        super(RemoteBlockchain.IDENTIFIER, RemoteBlockchain.ATTRIBUTES, RemoteBlockchain.EVENT_MAP, remoteConnection);
        this.on(RemoteBlockchain.EVENTS.HEAD_CHANGED, head => {
            this.head = head;
            this.headHash = head.hash;
            this.height += 1;
            this.totalWork += head.difficulty;
            if (this.height % 20 === 0) {
                // every couple blocks request a full update as the blockchain might have forked
                this._updateState();
            }
        }, !live);
        this._accounts = accounts;
    }


    async accountsHash() {
        return this._accounts.hash();
    }


    async getNextCompactTarget() {
        return this._remoteConnection.request({
            command: RemoteBlockchain.COMMANDS.BLOCKCHAIN_GET_NEXT_COMPACT_TARGET
        }, RemoteBlockchain.MESSAGE_TYPES.BLOCKCHAIN_NEXT_COMPACT_TARGET);
    }


    async getBlock(hashString) {
        return this._remoteConnection.request({
            command: RemoteBlockchain.COMMANDS.BLOCKCHAIN_GET_BLOCK,
            hash: hashString
        }, message => message.type === RemoteBlockchain.MESSAGE_TYPES.BLOCKCHAIN_BLOCK && message.data.hash === hashString);
    }
}

class RemoteConsensus extends RemoteClass {
    static get IDENTIFIER() { return 'consensus'; }
    static get ATTRIBUTES() { return ['established']; }
    static get EVENTS() {
        return {
            ESTABLISHED: 'established',
            LOST: 'lost',
            SYNCING: 'syncing'
        };
    }
    static get MESSAGE_TYPES() {
        return {
            CONSENSUS_ESTABLISHED: 'consensus-established',
            CONSENSUS_LOST: 'consensus-lost',
            CONSENSUS_SYNCING: 'consensus-syncing'
        };
    }
    static get EVENT_MAP() {
        let map = {};
        map[RemoteConsensus.MESSAGE_TYPES.CONSENSUS_ESTABLISHED] = RemoteConsensus.EVENTS.ESTABLISHED;
        map[RemoteConsensus.MESSAGE_TYPES.CONSENSUS_LOST] = RemoteConsensus.EVENTS.LOST;
        map[RemoteConsensus.MESSAGE_TYPES.CONSENSUS_SYNCING] = RemoteConsensus.EVENTS.SYNCING;
        return map;
    }

    /**
     * Construct a remote consensus connected over a remote connection.
     * @param remoteConnection - a remote connection to the server
     * @param live - if true, the consensus auto updates and requests an event listener itself
     */
    constructor(remoteConnection, live) {
        super(RemoteConsensus.IDENTIFIER, RemoteConsensus.ATTRIBUTES, RemoteConsensus.EVENT_MAP, remoteConnection);
        this.on(RemoteConsensus.EVENTS.ESTABLISHED, () => this.established = true, !live);
        this.on(RemoteConsensus.EVENTS.LOST, () => this.established = false, !live);
        this._remoteConnection.on(RemoteConnection.EVENTS.CONNECTION_LOST, () => {
            this.established = false;
            this.fire(RemoteConsensus.EVENTS.LOST);
        });
        this._remoteConnection.on(RemoteConnection.EVENTS.CONNECTION_ESTABLISHED, async () => {
            await this._updateState();
            if (this.established) {
                this.fire(RemoteConsensus.EVENTS.ESTABLISHED);
            }
        });
    }
}

class RemoteMempool extends RemoteClass {
    static get IDENTIFIER() { return 'mempool'; }
    static get ATTRIBUTES() { return []; }
    static get EVENTS() {
        return {
            TRANSACTION_ADDED: 'transaction-added',
            TRANSACTIONS_READY: 'transactions-ready'
        };
    }
    static get COMMANDS() {
        return {
            MEMPOOL_GET_TRANSACTIONS: 'mempool-get-transactions'
        };
    }
    static get MESSAGE_TYPES() {
        return {
            MEMPOOL_TRANSACTION_ADDED: 'mempool-transaction-added',
            MEMPOOL_TRANSACTIONS_READY: 'mempool-transactions-ready',
            MEMPOOL_TRANSACTIONS: 'mempool-transactions'
        };
    }
    static get EVENT_MAP() {
        let map = {};
        map[RemoteMempool.MESSAGE_TYPES.MEMPOOL_TRANSACTION_ADDED] = RemoteMempool.EVENTS.TRANSACTION_ADDED;
        map[RemoteMempool.MESSAGE_TYPES.MEMPOOL_TRANSACTIONS_READY] = RemoteMempool.EVENTS.TRANSACTIONS_READY;
        return map;
    }

    /**
     * Construct a remote mempool connected over a remote connection.
     * @param remoteConnection - a remote connection to the server
     */
    constructor(remoteConnection, live) {
        super(RemoteMempool.IDENTIFIER, RemoteMempool.ATTRIBUTES, RemoteMempool.EVENT_MAP, remoteConnection);
        this._transactions = {}; // the getTransaction and getTransactions methods are not async, therefore we can't
        // request the transaction from the server on the go but have to mirror them.
        this.on(RemoteMempool.EVENTS.TRANSACTION_ADDED, transaction => this._transactions[transaction.hash] = transaction, !live); // TODO actual hash computation
        this.on(RemoteMempool.EVENTS.TRANSACTIONS_READY, () => this._updateState(), !live); // complete update as we
        // don't know which transactions have been evicted
    }


    /**
     * @overwrites _updateState in RemoteClass
     */ 
    _updateState() {
        // mempool does not have public member variables but we want to update the mirrored transactions
        this._remoteConnection.request({
            command: RemoteMempool.COMMANDS.MEMPOOL_GET_TRANSACTIONS
        }, RemoteMempool.MESSAGE_TYPES.MEMPOOL_TRANSACTIONS)
        .then(transactions => {
            this._transactions = {};
            transactions.forEach(transaction => this._transactions[transaction.hash]=transaction) // TODO actual hash computation
        });
    }


    getTransaction(hash) {
        return this._transactions[hash];
    }


    getTransactions(maxCount = 5000) {
        const transactions = [];
        for (const hash in this._transactions) {
            if (transactions.length >= maxCount) break;
            transactions.push(this._transactions[hash]);
        }
        return transactions;
    }
}

class RemoteMiner extends RemoteClass {
    static get IDENTIFIER() { return 'miner'; }
    static get ATTRIBUTES() { return ['address', 'hashrate', 'working']; }
    static get EVENTS() {
        return {
            STARTED: 'start',
            STOPPED: 'stop',
            HASHRATE_CHANGED: 'hashrate-changed',
            BLOCK_MINED: 'block-mined'
        };
    }
    static get MESSAGE_TYPES() {
        return {
            MINER_STARTED: 'miner-started',
            MINER_STOPPED: 'miner-stopped',
            MINER_HASHRATE_CHANGED: 'miner-hashrate-changed',
            MINER_BLOCK_MINED: 'miner-block-mined'
        };
    }
    static get EVENT_MAP() {
        let map = {};
        map[RemoteMiner.MESSAGE_TYPES.MINER_STARTED] = RemoteMiner.EVENTS.STARTED;
        map[RemoteMiner.MESSAGE_TYPES.MINER_STOPPED] = RemoteMiner.EVENTS.STOPPED;
        map[RemoteMiner.MESSAGE_TYPES.MINER_HASHRATE_CHANGED] = RemoteMiner.EVENTS.HASHRATE_CHANGED;
        map[RemoteMiner.MESSAGE_TYPES.MINER_BLOCK_MINED] = RemoteMiner.EVENTS.BLOCK_MINED;
        return map;
    }

    /**
     * Construct a remote miner connected over a remote connection.
     * @param remoteConnection - a remote connection to the server
     * @param live - if true, the miner auto updates and requests an event listener itself
     */
    constructor(remoteConnection, live) {
        super(RemoteMiner.IDENTIFIER, RemoteMiner.ATTRIBUTES, RemoteMiner.EVENT_MAP, remoteConnection);
        this.on(RemoteMiner.EVENTS.HASHRATE_CHANGED, hashrate => this.hashrate = hashrate, !live);
    }
}

class RemoteNetwork extends RemoteClass {
    static get IDENTIFIER() { return 'network'; }
    static get ATTRIBUTES() { return ['peerCount', 'peerCountWebSocket', 'peerCountWebRtc', 'peerCountDumb', 'bytesSent', 'bytesReceived']; }
    static get EVENTS() {
        return {
            PEERS_CHANGED: 'peers-changed',
            PEER_JOINED: 'peer-joined',
            PEER_LEFT: 'peer-left'
        };
    }
    static get MESSAGE_TYPES() {
        return {
            NETWORK_PEERS_CHANGED: 'network-peers-changed',
            NETWORK_PEER_JOINED: 'network-peer-joined',
            NETWORK_PEER_LEFT: 'network-peer-left'
        };
    }
    static get EVENT_MAP() {
        let map = {};
        map[RemoteNetwork.MESSAGE_TYPES.NETWORK_PEERS_CHANGED] = RemoteNetwork.EVENTS.PEERS_CHANGED;
        map[RemoteNetwork.MESSAGE_TYPES.NETWORK_PEER_LEFT] = RemoteNetwork.EVENTS.PEER_LEFT;
        map[RemoteNetwork.MESSAGE_TYPES.NETWORK_PEER_JOINED] = RemoteNetwork.EVENTS.PEER_JOINED;
        return map;
    }

    /**
     * Construct a remote network handler connected over a remote connection.
     * @param remoteConnection - a remote connection to the server
     * @param live - if true, the network auto updates and requests an event listener itself
     */
    constructor(remoteConnection, live) {
        super(RemoteNetwork.IDENTIFIER, RemoteNetwork.ATTRIBUTES, RemoteNetwork.EVENT_MAP, remoteConnection);
        this.on(RemoteNetwork.EVENTS.PEERS_CHANGED, () => this._updateState(), !live);
    }


    isOnline() {
        return (window.navigator.onLine === undefined || window.navigator.onLine) && this._remoteConnection.isConnected();
    }
}

class RemoteWallet extends RemoteClass {
    static get IDENTIFIER() { return 'wallet'; }
    static get ATTRIBUTES() { return ['address', 'publicKey']; }

    /**
     * Construct a remote wallet handler connected over a remote connection.
     * @param remoteConnection - a remote connection to the server
     */
    constructor(remoteConnection) {
        super(RemoteWallet.IDENTIFIER, RemoteWallet.ATTRIBUTES, {}, remoteConnection);
    }
}

class RemoteCore {
    /**
     * Construct a new remote core.
     * @param url - A websocket URL (protocol ws: or wss: for secure connections) pointing to a node running the RemoteAPI.
     */
    constructor(url, liveUpdates) {
        const shouldLiveUpdate = component => liveUpdates === 'all' || (Array.isArray(liveUpdates) && liveUpdates.indexOf(component)!==-1);
        this._remoteConnection = new RemoteConnection(url);
        this.accounts = new RemoteAccounts(this._remoteConnection);
        this.blockchain = new RemoteBlockchain(this._remoteConnection, this.accounts, shouldLiveUpdate('blockchain'));
        this.consensus = new RemoteConsensus(this._remoteConnection, shouldLiveUpdate('consensus'));
        this.mempool = new RemoteMempool(this._remoteConnection, shouldLiveUpdate('mempool'));
        this.miner = new RemoteMiner(this._remoteConnection, shouldLiveUpdate('miner'));
        this.network = new RemoteNetwork(this._remoteConnection, shouldLiveUpdate('network'));
        this.wallet = new RemoteWallet(this._remoteConnection);

        this._remoteConnection.on(RemoteConnection.EVENTS.CONNECTION_ERROR, () => console.error('Error connecting to '+url));
        this._remoteConnection.on(RemoteConnection.EVENTS.MESSAGE, message => {
            if (message.type === 'error') {
                console.error(message.data);
            }
        });
    }
}