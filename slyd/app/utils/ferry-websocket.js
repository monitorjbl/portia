import Ember from 'ember';
import config from '../config/environment';
import utils from '../utils/utils';
import NotificationManager from '../utils/notification-manager';

const APPLICATION_UNLOADING_CODE = 4001;
const DEFAULT_RECONNECT_TIMEOUT = 5000;
const DEFAULT_MAX_RECONNECT_TIMEOUT = 60000;

var defaultUrl = function() {
    var uri = URI.parse(config.SLYD_URL || window.location.protocol + '//' + window.location.host);
    if (!/wss?/.test(uri.protocol)) {
        uri.protocol = uri.protocol === 'https' ? 'wss' : 'ws';
    }
    uri.path = '/ws';
    return URI.build(uri);
};

export default Ember.Object.extend({

    closed: true,
    opened: Ember.computed.not('closed'),
    connecting: false,
    ws: null,
    heartbeat: null,
    nextConnect: null,
    reconnectTimeout: DEFAULT_RECONNECT_TIMEOUT,
    deferreds: {},
    commands: {},
    url: defaultUrl(),
    secondsUntilReconnect: 0,
    reconnectImminent: Ember.computed.lt('secondsUntilReconnect', 2),

    init: function(options) {
        if(options) { this.setProperties(options); }

        window.addEventListener('beforeunload', () => {
            if(this.get('opened')) {
                this.close(APPLICATION_UNLOADING_CODE);
            }
        });
    },

    connect: function() {
        if(this.get('closed')) {
            return this._createWebsocket();
        }
    },

    _updateCountdownTimer: function() {
        if(this.secondsUntilReconnect === 0 && this.get('countdownTid')) {
            clearInterval(this.get('countdownTid'));
            this.set('countdownTid', null);
        } else if (this.secondsUntilReconnect > 0 && !this.get('countdownTid')) {
            this.set('countdownTid', setInterval(() => {
                this.decrementProperty('secondsUntilReconnect');
            }, 1000));
        }
    }.observes('secondsUntilReconnect'),

    _onclose: function(e){
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
        }
        this.set('closed', true);
        this.set('connecting', false);
        Ember.Logger.log('<Closed Websocket>');

        let closeError = new Error('Socket disconnected');
        let deferreds = this.get('deferreds');
        for(var deferred of Object.keys(deferreds)) {
            deferreds[deferred].reject(closeError);
            delete deferreds[deferred];
        }

        if(e.code !== APPLICATION_UNLOADING_CODE && e.code !== 1000) {
            var timeout = this._connectTimeout();
            this.set('secondsUntilReconnect', Math.round(timeout/1000));
            var next = Ember.run.later(this, this.connect, timeout);
            this.set('reconnectTid', next);
        }
    },

    _createWebsocket: function() {
        if (this.get('reconnectTid')) {
            Ember.run.cancel(this.get('reconnectTid'));
            this.set('reconnectTid', null);
        }
        this.set('secondsUntilReconnect', 0);
        this.set('connecting', true);
        var ws;
        try {
            ws = new WebSocket(this.get('url'));
        } catch (err) {
            Ember.Logger.log('Error connecting to server: ' + err);
            this.set('connecting', false);
            return;
        }
        ws.onclose = this._onclose.bind(this);
        ws.onmessage = function(e) {
            var data;
            try {
                data = JSON.parse(e.data);
            } catch (err) {
                Ember.Logger.warn('Error parsing data returned by server: ' + err + '\n' + data);
                return;
            }
            var command = data._command;
            if (!command) {
                Ember.Logger.warn('Received response with no command: ' + e.data);
                return;
            }
            var deferred = data.id;
            if (deferred in this.get('deferreds')) {
                deferred = this.get('deferreds.' + deferred);
                delete this.get('deferreds')[data.id];
                if (data.error) {
                    var err = new Error(data.reason || data.error);
                    err.reason = {jqXHR: {responseText: data.reason || data.error}};
                    deferred.reject(err);
                } else {
                    deferred.resolve(data);
                }
            }
            if (data.error) {
                NotificationManager.showErrorNotification(data.reason || data.error);
                console.error(data.reason || data.error);
            }else if (command in this.get('commands')) {
                this.get('commands')[command](data);
            } else {
                Ember.Logger.warn('Received unknown command: ' + command);
            }
        }.bind(this);
        ws.onopen = function() {
            Ember.Logger.log('<Opened Websocket>');
            this.set('closed', false);
            this.set('connecting', false);
            this.set('reconnectTimeout', DEFAULT_RECONNECT_TIMEOUT);
            this.heartbeat = setInterval(function() {
                this.send({_command: 'heartbeat'});
            }.bind(this), 20000);
        }.bind(this);
        this.set('ws', ws);
    },

    _connectTimeout: function() {
        var timeout = Math.max(this.get('reconnectTimeout'), DEFAULT_RECONNECT_TIMEOUT);
        this.set('reconnectTimeout', Math.min(timeout*2, DEFAULT_MAX_RECONNECT_TIMEOUT));
        return this.get('reconnectTimeout');
    },

    addCommand: function(command, func) {
        this.get('commands')[command] = func;
    },

    close:function(code, reason) {
        code = code || 1000;
        reason = reason || 'application called close';
        return this.get('ws').close(code, reason);
    },

    send: function(data) {
        if (!this.get('closed') && data) {
            if (typeof data !== 'string') {
                try {
                    data = JSON.stringify(data);
                } catch (err) {
                    Ember.Logger.warn('Error sending data to server: ' +  err);
                    return;
                }
            }
            return this.get('ws').send(data);
        }
    },

    save: function(type, obj) {
        var data = {
            _meta: this._metadata(type),
            _command: 'saveChanges'
        };
        if (obj.serialize) {
            data[type] = obj.serialize();
        } else {
            data[type] = obj;
        }
        return this._sendPromise(data);
    },

    delete: function(type, name) {
        return this._sendPromise({
            _meta: this._metadata(type),
            _command: 'delete',
            name: name
        });
    },

    rename: function(type, from, to) {
        return this._sendPromise({
            _meta: this._metadata(type),
            _command: 'rename',
            old: from,
            new: to
        });
    },

    _sendPromise: function(data) {
        var deferred = new Ember.RSVP.defer();
        if(this.get('opened')) {
            this.set('deferreds.' + data._meta.id, deferred);
            this.send(data);
        } else {
            deferred.reject('Websocket is closed');
        }
        return deferred.promise;
    },

    _metadata: function(type) {
        return {
            spider: this.get('spider'),
            project: this.get('project'),
            type: type,
            id: utils.shortGuid()
        };
    }
});
