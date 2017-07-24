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

    hash() {
        return this._remoteConnection.request({
            command: RemoteAccounts.COMMANDS.GET_HASH
        }, RemoteAccounts.MESSAGE_TYPES.ACCOUNTS_HASH)
        .then(hashBase64 => Nimiq.Hash.unserialize(Nimiq.BufferUtils.fromBase64(hashBase64)));
    }

    getBalance(address) {
        const addressString = address.toHex().toLowerCase();
        return this._remoteConnection.request({
            command: RemoteAccounts.COMMANDS.GET_BALANCE,
            address: addressString
        }, message => message.type === RemoteAccounts.MESSAGE_TYPES.ACCOUNTS_BALANCE && message.data.address.toLowerCase() === addressString)
        .then(data => Nimiq.Balance.unserialize(Nimiq.BufferUtils.fromBase64(data.balance)))
    }

    _updateState() {
        // accounts have no state as they have no member variables
        return;
    }

    _isValidEvent(type) {
        if (type instanceof Nimiq.Address) {
            return true;
        } else {
            // just a normal event
            return super._isValidEvent(type);
        }
    }

    /**
     * @overwrites _handleEvents in RemoteClass
     */
    _handleEvents(message) {
        if (message.type.startsWith(RemoteAccounts.MESSAGE_TYPES.ACCOUNTS_ACCOUNT_CHANGED)) {
            this.fire(message.data.address.toLowerCase(), Nimiq.Account.unserialize(BufferUtils.fromBase64(message.data.account)));
        } else {
            super._handleEvents(message);
        }
    }

    /**
     * @overwrites on in RemoteClass
     */
    on(type, callback, lazyRegister) {
        if (type instanceof Nimiq.Address) {
            type = type.toHex().toLowerCase();
            RemoteObservable.prototype.on.call(this, type, callback); /* register the callback in Observer */
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
        if (type instanceof Nimiq.Address) {
            type = type.toHex().toLowerCase();
            RemoteObservable.prototype.off.call(this, type, callback); /* remove the callback in Observer */
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
Class.register(RemoteAccounts);