const WebSocket = require('ws'); // https://github.com/websockets/ws
const https = require('https');
const fs = require('fs');

class RemoteAPI {
    static get SNAPSHOT() { return 'snapshot'; }
    static get BALANCE() { return 'balance'; }
    static get BLOCKCHAIN_HEAD() { return 'blockchain-head'; }
    static get NETWORK() { return 'network'; }
    static get ERROR() { return 'error'; }

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
        this._wss.on('connection', ws => this._onConnection(ws)); // TODO authentication
        console.log('Remote API listening on port', port);

        // observers:
        $.accounts.on($.wallet.address, account => this._onBalanceChanged(account.balance));
        $.blockchain.on('head-changed', async head => this._broadcast(RemoteAPI.BLOCKCHAIN_HEAD, await this._getBlockInfo(head)));
        $.network.on('peers-changed', () => this._broadcast(RemoteAPI.NETWORK, this._getNetworkInfo()));
    }

    _onConnection(ws) {
        // handle websocket connection
        this._getSnapShot().then(snapshot => this._send(ws, RemoteAPI.SNAPSHOT, snapshot));

        ws.on('message', message => this._onMessage(ws, message));

        console.log('Remote API established connection.');
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
        let message = JSON.stringify({
            type: type,
            data: data
        });
        this._wss.clients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        });
    }

    _onMessage(ws, message) {
        if (message === RemoteAPI.SNAPSHOT) {
            this._getSnapShot().then(snapshot => this._send(ws, RemoteAPI.SNAPSHOT, snapshot));
        } else {
            this._send(ws, RemoteAPI.ERROR, 'Unsupported command: '+message);
        }
    }

    _onBalanceChanged(balance) {
        this._broadcast(RemoteAPI.BALANCE, {
            value: balance.value,
            nonce: balance.nonce
        });
    }

    async _getSnapShot() {
        return await Promise.all([
            this.$.accounts.hash(),
            this.$.blockchain.getNextCompactTarget(),
            this._getBlockInfo(this.$.blockchain.head),
            this.$.accounts.getBalance(this.$.wallet.address)
        ]).then(promiseResults => {
            let [accountsHash, nextCompactTarget, headInfo, balance] = promiseResults;
            return {
                accounts: {
                    hash: accountsHash.toBase64()
                },
                blockchain: {
                    busy: this.$.blockchain.busy,
                    checkpointLoaded: this.$.blockchain.checkpointLoaded,
                    nextCompactTarget: nextCompactTarget,
                    height: this.$.blockchain.height,
                    head: headInfo,
                    totalWork: this.$.blockchain.totalWork
                },
                consensus: {
                    established: this.$.consensus.established
                },
                mempool: {
                    transactions: this.$.mempool.getTransactions().map(this._getTransactionInfo)
                },
                miner: {
                    hashrate: this.$.miner.hashrate,
                    working: this.$.miner.working
                },
                network: this._getNetworkInfo(),
                wallet: {
                    address: this.$.wallet.address.toHex(),
                    publicKey: this.$.wallet.publicKey.toBase64(),
                    balance: {
                        value: balance.value,
                        nonce: balance.nonce
                    }
                }
            };
        });
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

    _getNetworkInfo() {
        return {
            bytesReceived: this.$.network.bytesReceived,
            bytesSent: this.$.network.bytesSent,
            peerCount: this.$.network.peerCount,
            peerCountDumb: this.$.network.peerCountDumb,
            peerCountWebRtc: this.$.network.peerCountWebRtc,
            peerCountWebSocket: this.$.network.peerCountWebSocket
        };
    }

    _getTransactionInfo(transaction) {
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
    }
}

module.exports = RemoteAPI;