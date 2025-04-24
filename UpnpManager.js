// UpnpManager.js
class UpnpManager {
    constructor() {
        const natUpnp = require('nat-upnp');
        this.client = natUpnp.createClient();
    }

    openPort(port) {
        return new Promise((resolve, reject) => {
            this.client.portMapping({
                public: port,
                private: port,
                ttl: 0, // 0 means permanent mapping
                protocol: 'TCP',
                description: 'Game Server Port Mapping'
            }, (err) => {
                if (err) {
                    console.error(`Error opening port ${port}:`, err.message);
                    reject(err);
                } else {
                    console.log(`Port ${port} opened successfully.`);
                    resolve();
                }
            });
        });
    }

    closePort(port) {
        return new Promise((resolve, reject) => {
            this.client.portUnmapping({
                public: port,
                protocol: 'TCP'
            }, (err) => {
                if (err) {
                    console.error(`Error closing port ${port}:`, err.message);
                    reject(err);
                } else {
                    console.log(`Port ${port} closed successfully.`);
                    resolve();
                }
            });
        });
    }
}

module.exports = UpnpManager; // Ensure the class is correctly exported