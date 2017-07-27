const RemoteApiComponent = require('./RemoteApiComponent.js');

class RemoteNetworkAPI extends RemoteApiComponent {
    constructor($) {
        super($);
        $.network.on('peers-changed', () => this._broadcast(RemoteNetworkAPI.MessageTypes.NETWORK_PEERS_CHANGED, this._getNetworkState()));
        $.network.on('peer-joined', () => this._broadcast(RemoteNetworkAPI.MessageTypes.NETWORK_PEER_JOINED));
        $.network.on('peer-left', () => this._broadcast(RemoteNetworkAPI.MessageTypes.NETWORK_PEER_LEFT));
    }

    /** @overwrites */
    _isValidListenerType(type) {
        const VALID_LISTENER_TYPES = [RemoteNetworkAPI.MessageTypes.NETWORK_PEERS_CHANGED, RemoteNetworkAPI.MessageTypes.NETWORK_PEER_JOINED,
            RemoteNetworkAPI.MessageTypes.NETWORK_PEER_LEFT];
        return VALID_LISTENER_TYPES.indexOf(type) !== -1;
    }

    /** @overwrites */
    getState() {
        return {
            bytesReceived: this.$.network.bytesReceived,
            bytesSent: this.$.network.bytesSent,
            peerCount: this.$.network.peerCount,
            peerCountDumb: this.$.network.peerCountDumb,
            peerCountWebRtc: this.$.network.peerCountWebRtc,
            peerCountWebSocket: this.$.network.peerCountWebSocket
        };
    }
}
RemoteNetworkAPI.MessageTypes = {
    NETWORK_STATE: 'network',
    NETWORK_PEERS_CHANGED: 'network-peers-changed',
    NETWORK_PEER_JOINED: 'network-peer-joined',
    NETWORK_PEER_LEFT: 'network-peer-left',
};

module.exports = RemoteNetworkAPI;