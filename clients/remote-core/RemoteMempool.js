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