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