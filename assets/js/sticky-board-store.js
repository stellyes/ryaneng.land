(() => {
    'use strict';

    const KEY = 'sticky-board:cloud-identity';

    class CloudBoardStore {
        constructor(config) {
            this.config = config;
            this.isDemo = false;
            this.listeners = new Set();
            this.identity = null;
            this.month = null;
            this.revision = -1;
            this.pending = new Map();
            this.assets = new Map();
            this.socket = null;
            this.reconnectTimer = 0;
            this.retryDelay = 1000;
            this.connecting = false;
            this.closed = false;
            this.ready = this.authenticate();
            this.ready.catch((error) => console.error('Sticky board authentication failed:', error));
        }

        async request(path, body, method = 'POST', authenticated = true) {
            if (!this.config.apiUrl) throw new Error('The shared board has not been configured yet.');
            const headers = { 'Content-Type': 'application/json' };
            if (authenticated) {
                try {
                    await this.ready;
                } catch (error) {
                    console.error('Retrying sticky board authentication:', error);
                    this.ready = this.authenticate();
                    await this.ready;
                }
                headers.Authorization = `Bearer ${this.identity.credential}`;
            }
            const response = await fetch(`${this.config.apiUrl}${path}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(20000),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || result.error || `Board request failed (${response.status}).`);
            return result;
        }

        async authenticate() {
            if (navigator.locks) {
                return navigator.locks.request(KEY, () => this.loadIdentity());
            }
            return this.loadIdentity();
        }

        async loadIdentity() {
            const saved = localStorage.getItem(KEY);
            if (saved) {
                this.identity = JSON.parse(saved);
                if (!this.identity.credential || !this.identity.deviceId) {
                    throw new Error('Your saved board identity is invalid. Do not clear it if you need to recover your note.');
                }
            } else {
                this.identity = await this.request('/devices', {}, 'POST', false);
                localStorage.setItem(KEY, JSON.stringify(this.identity));
            }
        }

        async list() {
            const snapshot = await this.request('/board', undefined, 'GET');
            if (this.month && this.month !== snapshot.month) {
                this.assets.clear();
                this.pending.clear();
            }
            this.month = snapshot.month;
            this.revision = snapshot.revision;
            this.hasPosted = snapshot.hasPosted === true;
            this.clockOffset = typeof snapshot.serverNow === 'number' ? snapshot.serverNow - Date.now() : 0;
            clearTimeout(this.resetTimer);
            if (typeof snapshot.resetAt === 'number') {
                this.resetTimer = setTimeout(() => this.notify(), Math.min(2147483647, Math.max(100, snapshot.resetAt - Date.now() - this.clockOffset + 100)));
            }
            return snapshot.notes;
        }

        async mutate(path, data, method = 'POST') {
            const signature = `${method}:${path}:${JSON.stringify(data)}`;
            const requestId = this.pending.get(signature) || crypto.randomUUID();
            this.pending.set(signature, requestId);
            const result = await this.request(path, { ...data, requestId }, method);
            this.pending.delete(signature);
            return result.note || result;
        }

        async upload(content) {
            if (this.assets.has(content)) return this.assets.get(content);
            const blob = await (await fetch(content)).blob();
            const upload = await this.request('/uploads', {});
            const form = new FormData();
            for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
            form.append('file', blob, 'note.webp');
            const response = await fetch(upload.url, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error('Image upload failed. Please try again.');
            const asset = await this.request(`/uploads/${upload.assetId}/finalize`, {});
            this.assets.set(content, asset.assetId);
            return asset.assetId;
        }

        async create(month, data) {
            const { type, content, paper, x, y, rot } = data;
            const payload = { month, type, paper, x, y, rot };
            if (type === 'text') payload.content = content;
            else payload.assetId = await this.upload(content);
            return this.mutate('/notes', payload);
        }

        async update(month, id, deviceId, patch) {
            return this.mutate(`/notes/${id}`, { month, ...patch }, 'PATCH');
        }

        async bump(month, id, deviceId, version) {
            return this.mutate(`/notes/${id}/bump`, { month, version });
        }

        notify() {
            this.listeners.forEach((listener) => listener());
        }

        subscribe(listener) {
            this.listeners.add(listener);
            if (this.listeners.size !== 1) return;
            this.connect();
            this.interval = setInterval(() => this.checkRevision(), 10000);
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) {
                    this.lastCheck = 0;
                    this.checkRevision();
                    this.connect();
                }
            });
            window.addEventListener('online', () => {
                this.lastCheck = 0;
                this.checkRevision();
                this.connect();
            });
            window.addEventListener('pagehide', () => {
                this.closed = true;
                clearInterval(this.interval);
                clearTimeout(this.reconnectTimer);
                clearTimeout(this.resetTimer);
                if (this.socket) this.socket.close();
            });
            window.addEventListener('pageshow', (event) => {
                if (event.persisted) {
                    this.closed = false;
                    this.lastCheck = 0;
                    this.interval = setInterval(() => this.checkRevision(), 10000);
                    this.connect();
                    this.checkRevision();
                }
            });
        }

        async checkRevision() {
            if (document.hidden || this.checking || this.closed) return;
            const live = this.socket && this.socket.readyState === WebSocket.OPEN;
            if (live && this.lastCheck && Date.now() - this.lastCheck < 30000) return;
            this.lastCheck = Date.now();
            this.checking = true;
            try {
                const current = await this.request('/revision', undefined, 'GET');
                this.syncFailed = false;
                if (current.month !== this.month || current.revision !== this.revision) this.notify();
                if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ action: 'heartbeat' }));
            } catch (error) {
                console.error('Sticky board synchronization failed:', error);
                this.reportSyncError(error);
            } finally {
                this.checking = false;
            }
        }

        async connect() {
            if (this.closed || this.connecting || (this.socket && this.socket.readyState <= WebSocket.OPEN)) return;
            this.connecting = true;
            try {
                const ticket = await this.request('/connections/ticket', {});
                const socket = new WebSocket(`${ticket.url || this.config.websocketUrl}?ticket=${encodeURIComponent(ticket.ticket)}`);
                this.socket = socket;
                socket.addEventListener('open', () => {
                    this.retryDelay = 1000;
                    this.lastCheck = 0;
                    this.checkRevision();
                });
                socket.addEventListener('message', (event) => {
                    try {
                        const change = JSON.parse(event.data);
                        if (change.month && (change.month !== this.month || change.revision > this.revision)) this.notify();
                    } catch (error) {
                        console.error('Invalid sticky board event:', error);
                    }
                });
                socket.addEventListener('close', () => this.scheduleReconnect());
                socket.addEventListener('error', () => socket.close());
            } catch (error) {
                console.error('Sticky board live connection failed:', error);
                this.reportSyncError(error);
                this.scheduleReconnect();
            } finally {
                this.connecting = false;
            }
        }

        scheduleReconnect() {
            if (this.closed) return;
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => {
                this.checkRevision();
                this.connect();
            }, this.retryDelay + Math.random() * 1000);
            this.retryDelay = Math.min(this.retryDelay * 2, 10000);
        }

        reportSyncError(error) {
            if (this.syncFailed) return;
            this.syncFailed = true;
            window.dispatchEvent(new CustomEvent('sticky-board-sync-error', { detail: error.message }));
        }
    }

    window.CloudBoardStore = CloudBoardStore;
})();
