const WebSocket = require('ws'); // https://github.com/websockets/ws
const https = require('https');
const fs = require('fs');

class RemoteAPI {
    static get COMMANDS () {
        return {
            GET_SNAPSHOT: 'get-snapshot',
            GET_STATE: 'get-state',
            REGISTER_LISTENERS: 'register-listeners'
        }
    }
    static get MESSAGE_TYPES() {
        return {
            SNAPSHOT: 'snapshot',
            BALANCE_STATE: 'balance',
            CONSENSUS_STATE: 'consensus',
            BLOCKCHAIN_HEAD_STATE: 'blockchain-head',
            BLOCKCHAIN_STATE: 'blockchain',
            NETWORK_STATE: 'network',
            MEMPOOL_STATE: 'mempool',
            MINER_STATE: 'miner',
            ERROR: 'error'
        }
    }

    constructor($, port, sslKey, sslCert) {
        this.$ = $;
        const sslOptions = {
            key: fs.readFileSync(sslKey),
            cert: fs.readFileSync(sslCert)
        };
        const httpsServer = https.createServer(sslOptions, (req, res) => {
            res.writeHead(200);
            res.end('Nimiq NodeJS Remote API\n');
        }).listen(port);
        // websocket server
        this._wss = new WebSocket.Server({server: httpsServer});
        this._wss.on('connection', (ws, message) => this._onConnection(ws, message)); // TODO authentication
        console.log('Remote API listening on port', port);

        // listeners:
        this._listeners = {};
        $.accounts.on($.wallet.address, account => this._broadcast(RemoteAPI.MESSAGE_TYPES.BALANCE_STATE, this._getBalanceInfo(account.balance)));
        $.blockchain.on('head-changed', async head => this._broadcast(RemoteAPI.MESSAGE_TYPES.BLOCKCHAIN_HEAD_STATE, await this._getBlockInfo(head)));
        $.network.on('peers-changed', () => this._broadcast(RemoteAPI.MESSAGE_TYPES.NETWORK_STATE, this._getNetworkState()));
        $.mempool.on('*', () => this._broadcast(RemoteAPI.MESSAGE_TYPES.MEMPOOL_STATE, this._getMempoolState()));
        $.miner.on('*', () => this._broadcast(RemoteAPI.MESSAGE_TYPES.MINER_STATE, this._getMinerState()));
        $.consensus.on('*', () => this._broadcast(RemoteAPI.MESSAGE_TYPES.CONSENSUS_STATE, this._getConsensusState()))
    }

    _onConnection(ws) {
        // handle websocket connection
        this._getSnapShot().then(snapshot => this._send(ws, RemoteAPI.MESSAGE_TYPES.SNAPSHOT, snapshot));

        ws.on('message', message => this._onMessage(ws, message));

        console.log('Remote API established connection.');
    }

    _onMessage(ws, message) {
        try {
            message = JSON.parse(message);
        } catch(e) {
            this._sendError(ws, message, 'Couldn\'t parse command');
            return;
        }
        if (message.command === RemoteAPI.COMMANDS.REGISTER_LISTENERS) {
            this._registerListeners(ws, message.types);
        } else if (message.command === RemoteAPI.COMMANDS.GET_SNAPSHOT) {
            this._getSnapShot().then(snapshot => this._send(ws, RemoteAPI.MESSAGE_TYPES.SNAPSHOT, snapshot));
        } else if (message.command === RemoteAPI.COMMANDS.GET_STATE) {
            this._sendState(ws, message.type);
        } else {
            this._sendError(ws, message.command, 'Unsupported command.');
        }
    }

    _registerListener(ws, type) {
        const VALID_LISTENER_TYPES = [RemoteAPI.MESSAGE_TYPES.BALANCE_STATE, RemoteAPI.MESSAGE_TYPES.CONSENSUS_STATE,
            RemoteAPI.MESSAGE_TYPES.BLOCKCHAIN_HEAD_STATE, RemoteAPI.MESSAGE_TYPES.NETWORK_STATE, RemoteAPI.MESSAGE_TYPES.MEMPOOL_STATE,
            RemoteAPI.MESSAGE_TYPES.MINER_STATE];
        if (VALID_LISTENER_TYPES.indexOf(type) === -1) {
            this._sendError(ws, RemoteAPI.COMMANDS.REGISTER_LISTENERS, type + ' is not a valid type.');
            return;
        }
        if (!this._listeners[type]) {
            this._listeners[type] = new Set();
        }
        this._listeners[type].add(ws);
    }

    _unregisterListener(ws, type) {
        this._listeners[type].delete(ws);
    }

    _registerListeners(ws, types) {
        this._unregisterListeners(ws);
        if (!types || !Array.isArray(types)) {
            this._sendError(ws, RemoteAPI.COMMANDS.REGISTER_LISTENERS, 'Illegal listeners list');
            return;
        }
        for (const type of types) {
            this._registerListener(ws, type);
        }
    }

    _unregisterListeners(ws) {
        for (const type in this._listeners) {
            this._unregisterListener(ws, type);
        }
    }

    _send(ws, type, data) {
        if (ws.readyState === WebSocket.OPEN) {
            // if the connection is (still) open, send the snapshot
            ws.send(JSON.stringify({
                type: type,
                data: data
            }));
        }
    }

    _broadcast(type, data) {
        if (!this._listeners[type]) return;
        let message = JSON.stringify({
            type: type,
            data: data
        });
        for (let ws of this._listeners[type]) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        }
    }

    _sendError(ws, command, errorMessage) {
        errorMessage = 'Error' + (command? ' executing '+command : '') + ': ' +errorMessage;
        this._send(ws, RemoteAPI.MESSAGE_TYPES.ERROR, errorMessage);
    }

    _sendState(ws, type) {
        if (type === RemoteAPI.MESSAGE_TYPES.BALANCE_STATE) {
            this.$.accounts.getBalance(this.$.wallet.address).then(balance => this._send(ws, type, this._getBalanceInfo(balance)));
        } else if (type === RemoteAPI.MESSAGE_TYPES.CONSENSUS_STATE) {
            this._send(ws, type, this._getConsensusState());
        } else if (type === RemoteAPI.MESSAGE_TYPES.BLOCKCHAIN_STATE) {
            this._getBlockchainState().then(blockchainState => this._send(ws, type, blockchainState));
        } else if (type === RemoteAPI.MESSAGE_TYPES.NETWORK_STATE) {
            this._send(ws, type, this._getNetworkState());
        } else if (type === RemoteAPI.MESSAGE_TYPES.MEMPOOL_STATE) {
            this._send(ws, type, this._getMempoolState());
        } else if (type === RemoteAPI.MESSAGE_TYPES.MINER_STATE) {
            this._send(ws, type, this._getMinerState());
        } else {
            this._sendError(ws, RemoteAPI.COMMANDS.GET_STATE, type + ' is not a valid type.');
        }
    }

    async _getSnapShot() {
        return await Promise.all([
            this.$.accounts.hash(),
            this.$.accounts.getBalance(this.$.wallet.address),
            this._getBlockchainState()
        ]).then(promiseResults => {
            let [accountsHash, balance, blockchainState] = promiseResults;
            return {
                accounts: {
                    hash: accountsHash.toBase64()
                },
                blockchain: blockchainState,
                consensus: this._getConsensusState(),
                mempool: this._getMempoolState(),
                miner: this._getMinerState(),
                network: this._getNetworkState(),
                wallet: {
                    address: this.$.wallet.address.toHex(),
                    publicKey: this.$.wallet.publicKey.toBase64(),
                    balance: this._getBalanceInfo(balance)
                }
            };
        });
    }

    _getBalanceInfo(balance) {
        return {
            value: balance.value,
            nonce: balance.nonce
        };
    }

    _getConsensusState() {
        return {
            established: this.$.consensus.established
        };
    }

    async _getBlockInfo(block) {
        return {
            header: {
                difficulty: block.header.difficulty,
                height: block.header.height,
                nBits: block.header.nBits,
                nonce: block.header.nonce,
                prevHash: block.header.prevHash.toBase64(),
                serializedSize: block.header.serializedSize,
                target: block.header.target,
                timestamp: block.header.timestamp
            },
            body: {
                hash: (await block.body.hash()).toBase64(),
                minerAddr: block.body.minerAddr.toHex(),
                serializedSize: block.body.serializedSize,
                transactionCount: block.body.transactionCount
            },
            serializedSize: block.serializedSize
        }
    }

    async _getBlockchainState() {
        return Promise.all([
            this.$.blockchain.getNextCompactTarget(),
            this._getBlockInfo(this.$.blockchain.head)
        ]).then(promiseResults => {
            const [nextCompactTarget, headInfo] = promiseResults;
            return {
                busy: this.$.blockchain.busy,
                checkpointLoaded: this.$.blockchain.checkpointLoaded,
                nextCompactTarget: nextCompactTarget,
                height: this.$.blockchain.height,
                head: headInfo,
                totalWork: this.$.blockchain.totalWork
            };
        });
    }

    _getNetworkState() {
        return {
            bytesReceived: this.$.network.bytesReceived,
            bytesSent: this.$.network.bytesSent,
            peerCount: this.$.network.peerCount,
            peerCountDumb: this.$.network.peerCountDumb,
            peerCountWebRtc: this.$.network.peerCountWebRtc,
            peerCountWebSocket: this.$.network.peerCountWebSocket
        };
    }

    _getMempoolState() {
        return {
            transactions: this.$.mempool.getTransactions().map(transaction => {
                return {
                    fee: transaction.fee,
                    nonce: transaction.nonce,
                    recipientAddr: transaction.recipientAddr.toHex(),
                    senderPubKey: transaction.senderPubKey.toBase64(),
                    serializedContentSize: transaction.serializedContentSize,
                    serializedSize: transaction.serializedSize,
                    signature: transaction.signature.toBase64(),
                    value: transaction.value
                }
            })
        };
    }

    _getMinerState() {
        return {
            hashrate: this.$.miner.hashrate,
            working: this.$.miner.working
        };
    }
}

module.exports = RemoteAPI;