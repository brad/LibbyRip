// ==UserScript==
// @name          LibreGRAB
// @namespace     http://tampermonkey.net/
// @version       2026-09-09
// @description   Download all the booty! - ID3 tagging enabled, no FFmpeg, streaming MP3
// @author        PsychedelicPalimpsest
// @license       MIT
// @supportURL    https://github.com/PsychedelicPalimpsest/LibbyRip/issues
// @match         *://libbyapp.com/*
// @match         *://*.libbyapp.com/*
// @match         *://overdrive.com/*
// @match         *://*.overdrive.com/*
// @match         *://*.listen.libbyapp.com/*
// @match         *://*.listen.overdrive.com/*
// @match         *://*.read.libbyapp.com/?*
// @match         *://*.read.overdrive.com/?*
// @connect       images.findawayworld.com
// @connect       unpkg.com
// @grant         GM.xmlHttpRequest
// @grant         GM_xmlhttpRequest
// @run-at        document-start
// @icon          https://www.google.com/s2/favicons?sz=64&domain=libbyapp.com
// @downloadURL https://update.greasyfork.org/scripts/498782/LibreGRAB.user.js
// @updateURL https://update.greasyfork.org/scripts/498782/LibreGRAB.meta.js
// ==/UserScript==

// Chrome (Tampermonkey/MV3) runs userscripts in an isolated JS world, meaning
// overrides to JSON.parse and Function.prototype.bind never reach the page's
// own execution context. The fix is to inject the main script body into the
// real page world.

(function () {
    const clientZipReadyCode = `
window.__libregrabClientZipReady = new Promise((resolve, reject) => {
    window.__libregrabResolveClientZip = resolve;
    window.__libregrabRejectClientZip = reject;
});
`;
    function mainCode() {

    const LIBREGRAB_SAVE_REQUEST = 'LIBREGRAB_SAVE_REQUEST';
    const LIBREGRAB_SAVE_RESULT = 'LIBREGRAB_SAVE_RESULT';
    const isTopFrame = window.top === window.self;

    function isLibbyFamilyOrigin(origin) {
        try {
            const host = new URL(origin).hostname;
            return host === 'libbyapp.com' || host.endsWith('.libbyapp.com')
                || host === 'overdrive.com' || host.endsWith('.overdrive.com');
        } catch (e) {
            return false;
        }
    }

    function isPlayerOrigin(origin) {
        try {
            const host = new URL(origin).hostname;
            return host === 'listen.libbyapp.com' || host.endsWith('.listen.libbyapp.com')
                || host === 'listen.overdrive.com' || host.endsWith('.listen.overdrive.com');
        } catch (e) {
            return false;
        }
    }

    function saveBlobFromTopFrame(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.style.display = 'none';
        document.documentElement.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    if (isTopFrame) {
        window.addEventListener('message', event => {
            const data = event.data;
            if (!isPlayerOrigin(event.origin)) return;
            if (!data || data.type !== LIBREGRAB_SAVE_REQUEST) return;
            if (!(data.arrayBuffer instanceof ArrayBuffer)) return;
            const filename = String(data.filename || 'audiobook.mp3')
                .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_')
                .slice(0, 180) || 'audiobook.mp3';
            saveBlobFromTopFrame(new Blob([data.arrayBuffer], { type: data.mimeType || 'application/octet-stream' }), filename);
            event.source.postMessage({
                type: LIBREGRAB_SAVE_RESULT,
                requestId: data.requestId,
                ok: true,
            }, event.origin);
        });
    }

    async function requestSaveFromTopFrame(blob, filename, mimeType) {
        if (isTopFrame) {
            saveBlobFromTopFrame(blob, filename);
            return;
        }
        const parentOrigin = document.referrer ? new URL(document.referrer).origin : '';
        if (!isLibbyFamilyOrigin(parentOrigin)) {
            throw new Error('Unrecognized top-level Libby/OverDrive origin: ' + parentOrigin);
        }
        const arrayBuffer = await blob.arrayBuffer();
        window.top.postMessage({
            type: LIBREGRAB_SAVE_REQUEST,
            requestId: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()),
            filename,
            mimeType: mimeType || blob.type || 'application/octet-stream',
            arrayBuffer,
        }, parentOrigin, [arrayBuffer]);
    }

    function pageWindow() {
        return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    }
    function gmXhr(details) {
        const fn = (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function')
        ? GM.xmlHttpRequest
        : (typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null);
        if (!fn) return Promise.reject(new Error('GM.xmlHttpRequest is not available'));
        return new Promise((resolve, reject) => {
        fn(Object.assign({}, details, {
            onload: resolve,
            onerror: (e) => reject(e && e.error ? new Error(e.error) : new Error('GM.xmlHttpRequest network error')),
            ontimeout: () => reject(new Error('GM.xmlHttpRequest timed out'))
        }));
        });
    }

    async function gmFetchBlob(url) {
        const res = await gmXhr({
        method: 'GET',
        url,
        responseType: 'blob',
        anonymous: true
        });
        if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status);
        if (!res.response) throw new Error('empty GM.xmlHttpRequest body');
        return res.response;
    }

    // Isolated-world window.showSaveFilePicker is a bound-less wrapper; calling
    // it as a free function throws Illegal invocation. Call it on the page window.
    const LIBREGRAB_PICK_REQUEST = 'LIBREGRAB_PICK_REQUEST';
    const LIBREGRAB_PICK_RESULT = 'LIBREGRAB_PICK_RESULT';
    const LIBREGRAB_WRITE_CHUNK = 'LIBREGRAB_WRITE_CHUNK';
    const LIBREGRAB_WRITE_ACK = 'LIBREGRAB_WRITE_ACK';
    const LIBREGRAB_WRITE_CLOSE = 'LIBREGRAB_WRITE_CLOSE';
    const LIBREGRAB_WRITE_CLOSE_ACK = 'LIBREGRAB_WRITE_CLOSE_ACK';
    const pendingIframePicks = new Map();
    const pendingIframeWrites = new Map();
    const topPickSessions = new Map();

    function libregrabRequestId() {
        return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
    }

    function iframeParentOrigin() {
        try {
            if (document.referrer) return new URL(document.referrer).origin;
        } catch (e) {}
        try {
            if (location.ancestorOrigins && location.ancestorOrigins.length) {
                return location.ancestorOrigins[0];
            }
        } catch (e) {}
        try {
            return window.top.location.origin;
        } catch (e) {}
        return '';
    }

    function toArrayBuffer(data) {
        if (data instanceof ArrayBuffer) return data;
        if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        if (data instanceof Blob) return data.arrayBuffer();
        return new Blob([data]).arrayBuffer();
    }

    function showTopFramePickButton(session) {
        if (session.button && session.button.isConnected) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'LibreGRAB: Choose save location — ' + session.filename;
        button.title = 'Click to open the system file picker';
        button.style.cssText = [
            'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
            'max-width:min(90vw, 560px)', 'padding:12px 16px', 'border:1px solid #333',
            'border-radius:8px', 'background:#fff', 'color:#111', 'font:14px/1.3 sans-serif',
            'box-shadow:0 2px 12px rgba(0,0,0,.35)', 'cursor:pointer'
        ].join(';');
        button.addEventListener('click', async () => {
            button.disabled = true;
            button.textContent = 'LibreGRAB: Opening file picker…';
            try {
                const w = pageWindow();
                const picker = w.showSaveFilePicker;
                if (typeof picker !== 'function') throw new Error('File System Access API is not available on the top-level page');
                const fileHandle = await picker.call(w, {
                    suggestedName: session.filename,
                    types: session.types && session.types.length ? session.types : [{
                        description: 'MP3 audio',
                        accept: { 'audio/mpeg': ['.mp3'] }
                    }]
                });
                session.fileHandle = fileHandle;
                session.writable = await fileHandle.createWritable();
                button.remove();
                session.source.postMessage({
                    type: LIBREGRAB_PICK_RESULT,
                    requestId: session.requestId,
                    ok: true,
                    name: fileHandle.name || session.filename
                }, session.origin);
            } catch (error) {
                button.remove();
                topPickSessions.delete(session.requestId);
                session.source.postMessage({
                    type: LIBREGRAB_PICK_RESULT,
                    requestId: session.requestId,
                    ok: false,
                    cancelled: !!(error && error.name === 'AbortError'),
                    error: { name: error && error.name, message: error && error.message }
                }, session.origin);
            }
        }, { once: true });
        (document.body || document.documentElement).appendChild(button);
        session.button = button;
    }

    async function handleTopPickMessage(event) {
        const data = event.data;
        if (!isPlayerOrigin(event.origin) || !data) return;

        if (data.type === LIBREGRAB_PICK_REQUEST) {
            if (typeof data.requestId !== 'string' || topPickSessions.has(data.requestId)) return;
            const session = {
                requestId: data.requestId,
                source: event.source,
                origin: event.origin,
                filename: String(data.filename || 'audiobook.mp3').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_').slice(0, 180) || 'audiobook.mp3',
                types: Array.isArray(data.types) ? data.types : null,
                fileHandle: null,
                writable: null,
                button: null
            };
            topPickSessions.set(session.requestId, session);
            showTopFramePickButton(session);
            return;
        }

        const session = topPickSessions.get(data.requestId);
        if (!session || event.source !== session.source) return;

        if (data.type === LIBREGRAB_WRITE_CHUNK) {
            try {
                if (!session.writable) throw new Error('Save file was not chosen yet');
                if (!(data.arrayBuffer instanceof ArrayBuffer)) throw new Error('Missing file chunk');
                await session.writable.write(new Uint8Array(data.arrayBuffer));
                session.source.postMessage({
                    type: LIBREGRAB_WRITE_ACK,
                    requestId: session.requestId,
                    seq: data.seq,
                    ok: true
                }, session.origin);
            } catch (error) {
                session.source.postMessage({
                    type: LIBREGRAB_WRITE_ACK,
                    requestId: session.requestId,
                    seq: data.seq,
                    ok: false,
                    error: { name: error && error.name, message: error && error.message }
                }, session.origin);
            }
            return;
        }

        if (data.type === LIBREGRAB_WRITE_CLOSE) {
            try {
                if (session.writable) await session.writable.close();
                session.source.postMessage({
                    type: LIBREGRAB_WRITE_CLOSE_ACK,
                    requestId: session.requestId,
                    ok: true,
                    name: (session.fileHandle && session.fileHandle.name) || session.filename
                }, session.origin);
            } catch (error) {
                session.source.postMessage({
                    type: LIBREGRAB_WRITE_CLOSE_ACK,
                    requestId: session.requestId,
                    ok: false,
                    error: { name: error && error.name, message: error && error.message }
                }, session.origin);
            } finally {
                if (session.button) session.button.remove();
                topPickSessions.delete(session.requestId);
            }
        }
    }

    function handleIframePickMessage(event) {
        const data = event.data;
        if (!data || event.source !== window.top) return;

        if (data.type === LIBREGRAB_PICK_RESULT) {
            const pending = pendingIframePicks.get(data.requestId);
            if (!pending) return;
            clearTimeout(pending.timeoutId);
            pendingIframePicks.delete(data.requestId);
            if (data.ok) pending.resolve({ name: data.name || 'audiobook.mp3', parentOrigin: event.origin });
            else if (data.cancelled) pending.reject(new DOMException('Save cancelled by user.', 'AbortError'));
            else pending.reject(new Error((data.error && data.error.message) || 'Top-level file picker failed'));
            return;
        }

        if (data.type === LIBREGRAB_WRITE_ACK) {
            const pending = pendingIframeWrites.get(data.requestId + ':' + data.seq);
            if (!pending) return;
            pendingIframeWrites.delete(data.requestId + ':' + data.seq);
            if (data.ok) pending.resolve();
            else pending.reject(new Error((data.error && data.error.message) || 'Top-level write failed'));
            return;
        }

        if (data.type === LIBREGRAB_WRITE_CLOSE_ACK) {
            const pending = pendingIframeWrites.get(data.requestId + ':close');
            if (!pending) return;
            pendingIframeWrites.delete(data.requestId + ':close');
            if (data.ok) pending.resolve(data.name);
            else pending.reject(new Error((data.error && data.error.message) || 'Top-level close failed'));
        }
    }

    window.addEventListener('message', event => {
        if (isTopFrame) handleTopPickMessage(event).catch(err => console.error('LibreGRAB top-frame picker failed', err));
        else handleIframePickMessage(event);
    });

    async function createProxySaveHandle(suggestedName, types) {
        let origin = iframeParentOrigin();
        const targetOrigin = (origin && isLibbyFamilyOrigin(origin)) ? origin : '*';
        if (typeof downloadElem !== 'undefined' && downloadElem) {
            downloadElem.innerHTML += 'Click <b>LibreGRAB: Choose save location</b> on the main Libby page to open the file picker.<br>';
            downloadElem.scrollTo(0, downloadElem.scrollHeight);
        }
        const requestId = libregrabRequestId();
        const picked = await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                pendingIframePicks.delete(requestId);
                reject(new Error('Timed out waiting for the top-level file picker'));
            }, 10 * 60 * 1000);
            pendingIframePicks.set(requestId, { resolve, reject, timeoutId });
            window.top.postMessage({
                type: LIBREGRAB_PICK_REQUEST,
                requestId,
                filename: suggestedName,
                types
            }, targetOrigin);
        });
        const name = picked.name;
        origin = picked.parentOrigin || origin;
        if (!origin || !isLibbyFamilyOrigin(origin)) {
            throw new Error('Unrecognized top-level Libby/OverDrive origin: ' + origin);
        }

        let seq = 0;
        return {
            name,
            async createWritable() {
                return {
                    async write(data) {
                        const arrayBuffer = await toArrayBuffer(data);
                        const thisSeq = ++seq;
                        await new Promise((resolve, reject) => {
                            pendingIframeWrites.set(requestId + ':' + thisSeq, { resolve, reject });
                            window.top.postMessage({
                                type: LIBREGRAB_WRITE_CHUNK,
                                requestId,
                                seq: thisSeq,
                                arrayBuffer
                            }, origin, [arrayBuffer]);
                        });
                    },
                    async close() {
                        await new Promise((resolve, reject) => {
                            pendingIframeWrites.set(requestId + ':close', { resolve, reject });
                            window.top.postMessage({
                                type: LIBREGRAB_WRITE_CLOSE,
                                requestId
                            }, origin);
                        });
                    },
                    abort() {
                        return this.close();
                    }
                };
            },
            async createSyncAccessHandle() {
                throw new Error('createSyncAccessHandle is not available across frames');
            }
        };
    }

    async function pickSaveFile(suggestedName, types) {
        if (window.top !== window.self) {
            return await createProxySaveHandle(suggestedName, types);
        }
        const w = pageWindow();
        const picker = w.showSaveFilePicker;
        if (typeof picker !== 'function') {
            throw new Error('File System Access API is not available on this window');
        }
        return picker.call(w, { suggestedName, types });
    }

    /* =========================================
       ID3v2.3 + raw MP3 frame helpers (adapted from NookRip)
       ========================================= */

    function concatBytes(parts) {
        const arrays = parts.map(p => {
            if (p instanceof Uint8Array) return p;
            if (p instanceof ArrayBuffer) return new Uint8Array(p);
            return new Uint8Array(p);
        });
        let total = 0;
        for (const a of arrays) total += a.length;
        const out = new Uint8Array(total);
        let o = 0;
        for (const a of arrays) { out.set(a, o); o += a.length; }
        return out;
    }

    function u32be(n) {
        n = n >>> 0;
        return new Uint8Array([(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]);
    }

    function writeU32be(u8, offset, n) {
        n = n >>> 0;
        u8[offset] = (n >>> 24) & 0xFF;
        u8[offset + 1] = (n >>> 16) & 0xFF;
        u8[offset + 2] = (n >>> 8) & 0xFF;
        u8[offset + 3] = n & 0xFF;
    }

    function synchsafe(n) {
        n = n >>> 0;
        return new Uint8Array([(n >>> 21) & 0x7F, (n >>> 14) & 0x7F, (n >>> 7) & 0x7F, n & 0x7F]);
    }

    function latin1(str) {
        const s = String(str ?? '');
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
        return out;
    }

    function utf16beBom(str) {
        const s = String(str ?? '');
        const out = new Uint8Array(2 + s.length * 2 + 2);
        out[0] = 0xFE;
        out[1] = 0xFF;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            out[2 + i * 2] = (c >> 8) & 0xFF;
            out[3 + i * 2] = c & 0xFF;
        }
        return out;
    }

    function id3Frame(id, payload) {
        return concatBytes([latin1(id), u32be(payload.length), new Uint8Array([0, 0]), payload]);
    }

    function textFrame(id, text) {
        return id3Frame(id, concatBytes([new Uint8Array([1]), utf16beBom(text)]));
    }

    function commFrame(text, language = 'eng') {
        return id3Frame('COMM', concatBytes([
            new Uint8Array([1]),
            latin1(language.slice(0, 3).padEnd(3, ' ')),
            utf16beBom(''),
            utf16beBom(String(text ?? ''))
        ]));
    }

    function apicFrame(coverBytes, mime) {
        return id3Frame('APIC', concatBytes([
            new Uint8Array([1]),
            latin1(mime || 'image/jpeg'),
            new Uint8Array([0, 3]),
            utf16beBom('Cover'),
            coverBytes
        ]));
    }

    function chapFrame(id, startMs, endMs, title) {
        return id3Frame('CHAP', concatBytes([
            latin1(id),
            new Uint8Array([0]),
            u32be(startMs),
            u32be(endMs),
            new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
            textFrame('TIT2', title)
        ]));
    }

    function ctocFrame(id, childIds, description) {
        const kids = [];
        for (const cid of childIds) {
            kids.push(latin1(cid));
            kids.push(new Uint8Array([0]));
        }
        return id3Frame('CTOC', concatBytes([
            latin1(id),
            new Uint8Array([0, 0x03, childIds.length & 0xFF]),
            concatBytes(kids),
            textFrame('TIT2', description)
        ]));
    }

    function buildId3Tag(frames) {
        const body = concatBytes(frames);
        return concatBytes([latin1('ID3'), new Uint8Array([0x03, 0x00, 0x00]), synchsafe(body.length), body]);
    }

    function stripId3(buf) {
        let u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        if (u8.length >= 10 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
            const size = ((u8[6] & 0x7F) << 21) | ((u8[7] & 0x7F) << 14) | ((u8[8] & 0x7F) << 7) | (u8[9] & 0x7F);
            const footer = (u8[5] & 0x10) ? 10 : 0;
            const start = 10 + size + footer;
            if (start > 0 && start < u8.length) u8 = u8.subarray(start);
        }
        if (u8.length >= 128 &&
            u8[u8.length - 128] === 0x54 &&
            u8[u8.length - 127] === 0x41 &&
            u8[u8.length - 126] === 0x47) {
            u8 = u8.subarray(0, u8.length - 128);
        }
        for (let i = 0; i < u8.length - 1; i++) {
            if (u8[i] === 0xFF && (u8[i + 1] & 0xE0) === 0xE0) {
                return i === 0 ? u8 : u8.subarray(i);
            }
        }
        return u8;
    }

    function writeId3(mp3Buffer, frames) {
        return concatBytes([buildId3Tag(frames), stripId3(mp3Buffer)]);
    }

    const BITRATE_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    const BITRATE_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
    const SR_MPEG1 = [44100, 48000, 32000];
    const SR_MPEG2 = [22050, 24000, 16000];
    const SR_MPEG25 = [11025, 12000, 8000];

    function asciiAt(u8, offset, n) {
        if (offset + n > u8.length) return '';
        let s = '';
        for (let i = 0; i < n; i++) s += String.fromCharCode(u8[offset + i]);
        return s;
    }

    function parseMpegHeader(u8, offset) {
        if (offset + 4 > u8.length) return null;
        if (u8[offset] !== 0xFF || (u8[offset + 1] & 0xE0) !== 0xE0) return null;
        const b1 = u8[offset + 1];
        const b2 = u8[offset + 2];
        const b3 = u8[offset + 3];
        const ver = (b1 >> 3) & 3;
        const layer = (b1 >> 1) & 3;
        const prot = b1 & 1;
        const brIdx = (b2 >> 4) & 0xF;
        const srIdx = (b2 >> 2) & 3;
        const padding = (b2 >> 1) & 1;
        const chMode = (b3 >> 6) & 3;
        if (ver === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
        const isMpeg1 = ver === 3;
        const isMpeg25 = ver === 0;
        const bitrate = (isMpeg1 ? BITRATE_MPEG1_L3 : BITRATE_MPEG2_L3)[brIdx] * 1000;
        const sampleRate = isMpeg1 ? SR_MPEG1[srIdx] : (isMpeg25 ? SR_MPEG25[srIdx] : SR_MPEG2[srIdx]);
        if (!bitrate || !sampleRate) return null;
        const coeff = isMpeg1 ? 144 : 72;
        const frameLen = Math.floor((coeff * bitrate) / sampleRate) + padding;
        if (frameLen < 4) return null;
        const channels = chMode === 3 ? 1 : 2;
        const sideInfo = isMpeg1 ? (channels === 1 ? 17 : 32) : (channels === 1 ? 9 : 17);
        const crc = prot === 0 ? 2 : 0;
        return {
            frameLen, sampleRate, bitrate, channels, isMpeg1, sideInfo, crc,
            headerBytes: u8.subarray(offset, offset + 4)
        };
    }

    function countMpegFrames(u8) {
        let i = 0;
        let count = 0;
        while (i + 4 <= u8.length) {
            const h = parseMpegHeader(u8, i);
            if (!h || i + h.frameLen > u8.length) {
                i++;
                continue;
            }
            count++;
            i += h.frameLen;
        }
        return count;
    }

    function xingPayloadOffset(header) {
        return 4 + header.crc + header.sideInfo;
    }

    function leadingSpecialFrameLen(u8) {
        const h = parseMpegHeader(u8, 0);
        if (!h || h.frameLen > u8.length) return 0;
        const xoff = xingPayloadOffset(h);
        const xtag = asciiAt(u8, xoff, 4);
        if (xtag === 'Xing' || xtag === 'Info') return h.frameLen;
        if (asciiAt(u8, 36, 4) === 'VBRI') return h.frameLen;
        return 0;
    }

    function stripXingFrame(u8) {
        const n = leadingSpecialFrameLen(u8);
        return n ? u8.subarray(n) : u8;
    }

    function makeXingFrame(proto, frames, bytes) {
        const frame = new Uint8Array(proto.frameLen);
        frame.set(proto.headerBytes, 0);
        const off = xingPayloadOffset(proto);
        if (off + 16 + 100 > frame.length) {
            throw new Error('MPEG frame too small to hold a Xing header (need ' + (off + 116) + ', have ' + frame.length + ')');
        }
        frame[off] = 0x58;
        frame[off + 1] = 0x69;
        frame[off + 2] = 0x6E;
        frame[off + 3] = 0x67;
        writeU32be(frame, off + 4, 0x00000007);
        writeU32be(frame, off + 8, frames >>> 0);
        writeU32be(frame, off + 12, bytes >>> 0);
        for (let i = 0; i < 100; i++) {
            frame[off + 16 + i] = Math.min(255, Math.round((i / 99) * 255));
        }
        return frame;
    }

    function chapterTitleFor(chapterNumber, displayTitle) {
        return chapterNumber === 0 ? `${displayTitle} - Opening Credits` : `Chapter ${chapterNumber}`;
    }

    function buildBookId3Tag({ book, displayTitle, author, narrator, seriesName, seriesIndex, chapters, durationByChapter, coverBytes, coverMime }) {
        let cursor = 0;
        const chapFrames = [];
        const childIds = [];
        chapters.forEach((ch, i) => {
            const dur = Number(durationByChapter[ch.chapter_number]) || 0;
            const start = cursor;
            const end = cursor + dur;
            const cid = i === chapters.length - 1 ? 'last' : ('ch' + (i + 1));
            childIds.push(cid);
            chapFrames.push(chapFrame(cid, start, end, chapterTitleFor(ch.chapter_number, displayTitle)));
            cursor = end;
        });

        const frames = [
            textFrame('TIT2', displayTitle),
            textFrame('TALB', displayTitle),
            textFrame('TPE1', author),
            textFrame('TRCK', '1/1'),
            textFrame('TCON', 'Audiobook'),
            textFrame('TSSE', 'LibreGRAB')
        ];
        if (narrator) {
            frames.push(textFrame('TPE2', narrator));
            frames.push(textFrame('TCOM', narrator));
        }
        if (seriesIndex) frames.push(textFrame('TPOS', String(seriesIndex)));
        if (seriesName) frames.push(textFrame('TXXX', { description: 'Series', value: seriesName }));
        if (book.street_date) {
            const yearMatch = String(book.street_date).match(/^(\d{4})/);
            if (yearMatch) frames.push(textFrame('TYER', yearMatch[1]));
        }
        if (cursor) frames.push(textFrame('TLEN', String(Math.round(cursor))));
        if (book.description) frames.push(commFrame(book.description));
        frames.push(commFrame('Audiobook exported by LibreGRAB from Libby.', 'eng'));
        if (coverBytes && coverBytes.length) frames.push(apicFrame(coverBytes, coverMime));
        if (childIds.length) {
            frames.push(ctocFrame('toc', childIds, 'Table of Contents'));
            frames.push.apply(frames, chapFrames);
        }
        return { tag: buildId3Tag(frames), totalDurationMs: cursor };
    }

    /* =========================================
       LIBBY-SPECIFIC LOGIC
       ========================================= */

    let downloadElem;
    let BIF;
    async function getDownloadZip() {
        const page = pageWindow();
        if (page.downloadZip) return page.downloadZip;
        if (window.__libregrabClientZipReady) return window.__libregrabClientZipReady;
        await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://unpkg.com/client-zip@2.5.0/worker.js';
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
        return page.downloadZip;
    }

    // Libby, somewhere, gets the crypto stuff we need for mp3 urls, then removes it before adding it to the BIF.
    // here, we simply hook json parse to get it for us!
    const old_parse = JSON.parse;
    let odreadCmptParams = null;
    JSON.parse = function(...args){
        let ret = old_parse(...args);
        if (typeof(ret) == "object" && ret["b"] != undefined && ret["b"]["-odread-cmpt-params"] != undefined){
            odreadCmptParams = Array.from(ret["b"]["-odread-cmpt-params"]);
        }
        return ret;
    }

    const audioBookNav = `
        <a class="pLink" id="chap"> <h1> View chapters </h1> </a>
        <a class="pLink" id="down"> <h1> Export as MP3 </h1> </a>
        <a class="pLink" id="exp"> <h1> Export audiobook </h1> </a>
    `;
    const chaptersMenu = `
        <h2>This book contains {CHAPTERS} chapters.</h2>
        <button class="shibui-button" style="background-color: white" id="dumpAll"> Download all </button><br>
    `;
    let chapterMenuElem;

    function buildPirateUi(){
        // Create the nav
        let nav = document.createElement("div");
        nav.innerHTML = audioBookNav;
        nav.querySelector("#chap").onclick = viewChapters;
        nav.querySelector("#down").onclick = exportMP3;
        nav.querySelector("#exp").onclick = exportChapters;
        nav.classList.add("pNav");
        let pbar = document.querySelector(".nav-progress-bar");
        pbar.insertBefore(nav, pbar.children[1]);

        // Create the chapters menu
        chapterMenuElem = document.createElement("div");
        chapterMenuElem.classList.add("foldMenu");
        chapterMenuElem.setAttribute("tabindex", "-1"); // Don't mess with tab key
        const urls = getUrls();

        chapterMenuElem.innerHTML = chaptersMenu.replace("{CHAPTERS}", urls.length);
        document.body.appendChild(chapterMenuElem);

        downloadElem = document.createElement("div");
        downloadElem.classList.add("foldMenu");
        downloadElem.setAttribute("tabindex", "-1"); // Don't mess with tab key
        document.body.appendChild(downloadElem);
    }
    function getUrls(){
        let ret = [];
        for (let spine of BIF.objects.spool.components){
            let data = {
                url: location.origin + "/" + spine.meta.path + "?" + odreadCmptParams[spine.spinePosition],
                index : spine.meta["-odread-spine-position"],
                duration: spine.meta["audio-duration"],
                size: spine.meta["-odread-file-bytes"],
                type: spine.meta["media-type"]
            };
            ret.push(data);
        }
        return ret;
    }
    function paddy(num, padlen, padchar) {
        var pad_char = typeof padchar !== 'undefined' ? padchar : '0';
        var pad = new Array(1 + padlen).join(pad_char);
        return (pad + num).slice(-pad.length);
    }
    let firstChapClick = true;
    function viewChapters(){
        // Populate chapters ONLY after first viewing
        if (firstChapClick){
            firstChapClick = false;
            for (let url of getUrls()){
                let span = document.createElement("span");
                span.classList.add("pChapLabel")
                span.textContent = "#" + (1 + url.index);

                let audio = document.createElement("audio");
                audio.setAttribute("controls", "");
                let source = document.createElement("source");
                source.setAttribute("src", url.url);
                source.setAttribute("type", url.type);
                audio.appendChild(source);

                chapterMenuElem.appendChild(span);
                chapterMenuElem.appendChild(document.createElement("br"));
                chapterMenuElem.appendChild(audio);
                chapterMenuElem.appendChild(document.createElement("br"));
            }
        }
        if (chapterMenuElem.classList.contains("active"))
            chapterMenuElem.classList.remove("active");
        else
            chapterMenuElem.classList.add("active");
        chapterMenuElem.querySelector("#dumpAll").onclick = async function(){
            chapterMenuElem.querySelector("#dumpAll").style.display = "none";
            await Promise.all(getUrls().map(async function(url){
                const res = await fetch(url.url);
                const blob = await res.blob();
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = `${getAuthorString()} - ${BIF.map.title.main}.${url.index}.mp3`;
                link.click();
                URL.revokeObjectURL(link.href);
            }));
            chapterMenuElem.querySelector("#dumpAll").style.display = "";
        };
    }
    function getAuthorString(){
        return BIF.map.creator.filter(creator => creator.role === 'author').map(creator => creator.name).join(", ");
    }
    function getNarratorString(){
        return BIF.map.creator.filter(creator => creator.role === 'narrator').map(creator => creator.name).join(", ");
    }
    function getMetadata(){
        let spineToIndex = BIF.map.spine.map((x)=>x["-odread-original-path"]);
        let metadata = {
            title: BIF.map.title.main,
            description: BIF.map.description,
            coverUrl: BIF.root.querySelector("image").getAttribute("href"),
            creator: BIF.map.creator,
            spine: BIF.map.spine.map((x)=>{return {
                duration: x["audio-duration"],
                type: x["media-type"],
                bitrate: x["audio-bitrate"],
            }})
        };
        if (BIF.map.nav.toc != undefined){
            metadata.chapters = BIF.map.nav.toc.map((rChap)=>{
                return {
                    title: rChap.title,
                    spine: spineToIndex.indexOf(rChap.path.split("#")[0]),
                    offset: 1*(rChap.path.split("#")[1] | 0)
                };
            });
        }
        return metadata;
    }

    async function createMetadata(){
        let metadata = getMetadata();
        const response = await fetch(metadata.coverUrl);
        const blob = await response.blob();
        const csplit = metadata.coverUrl.split(".");
        return [
            {
                name: "metadata/cover." + csplit[csplit.length-1],
                input: blob
            },
            {
                name: "metadata/metadata.json",
                input: JSON.stringify(metadata, null, 2)
            }
        ];
    }

    function tagChapterMp3(arrayBuffer, { book, displayTitle, author, narrator, seriesName, seriesIndex, chapterNumber, totalChapters, durationMs, coverBytes, coverMime, progress }) {
        try {
            const frames = [
                textFrame('TIT2', chapterTitleFor(chapterNumber, displayTitle)),
                textFrame('TALB', displayTitle),
                textFrame('TPE1', author),
                textFrame('TRCK', totalChapters ? (chapterNumber + '/' + totalChapters) : String(chapterNumber)),
                textFrame('TCON', 'Audiobook'),
                textFrame('TSSE', 'LibreGRAB')
            ];
            if (narrator) {
                frames.push(textFrame('TPE2', narrator));
                frames.push(textFrame('TCOM', narrator));
            }
            if (seriesIndex) frames.push(textFrame('TPOS', String(seriesIndex)));
            if (seriesName) frames.push(textFrame('TXXX', { description: 'Series', value: seriesName }));
            if (book.street_date) {
                const yearMatch = String(book.street_date).match(/^(\d{4})/);
                if (yearMatch) frames.push(textFrame('TYER', yearMatch[1]));
            }
            if (durationMs) frames.push(textFrame('TLEN', String(Math.round(durationMs))));
            if (coverBytes && coverBytes.length) frames.push(apicFrame(coverBytes, coverMime));
            return new Blob([writeId3(arrayBuffer, frames)], { type: 'audio/mpeg' });
        } catch (e) {
            if (progress) progress(`  NOTE: ID3 tagging failed for chapter ${chapterNumber} (file kept untagged): ${e.message}`);
            return new Blob([arrayBuffer], { type: 'audio/mpeg' });
        }
    }

    // Main streaming function: writes chapters sequentially to a single file
    // Only ONE chapter held in RAM at a time.
    async function buildAudiobookSingleMp3(urls, metadata, coverBytes, coverMime, fileHandle) {
        const totalChapters = metadata.chapters ? metadata.chapters.length : urls.length;
        const displayTitle = BIF.map.title.main;
        const author = getAuthorString();
        const narrator = getNarratorString();

        downloadElem.innerHTML = "<b>Streaming single MP3...</b><br>";
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const { tag, totalDurationMs } = buildBookId3Tag({
            book: BIF.map,
            displayTitle,
            author,
            narrator,
            seriesName: (BIF.map.series && BIF.map.series[0]) || null,
            seriesIndex: null,
            chapters: metadata.chapters || [],
            durationByChapter: Object.fromEntries(urls.map(u => [u.index, u.duration * 1000])),
            coverBytes,
            coverMime
        });
        downloadElem.innerHTML += `Wrote ID3v2 tag (${tag.length} bytes) with ${totalChapters} CHAP frames, duration ${(totalDurationMs / 3600000).toFixed(2)} h.<br>`;

        async function fetchChapterAudio(url) {
            const label = `chapter ${url.index}`;
            const res = await fetchWithRetry(url.url, { method: 'GET' }, label, (msg) => downloadElem.innerHTML += msg + "<br>");
            return stripId3(await res.arrayBuffer());
        }

        const firstRaw = await fetchChapterAudio(urls[0]);
        const proto = parseMpegHeader(firstRaw, 0);
        if (!proto) throw new Error('chapter ' + urls[0].index + ' did not start with a valid MPEG frame');

        const placeholderXing = makeXingFrame(proto, 0, 0);
        const writable = await fileHandle.createWritable();
        let audioBytes = 0;
        let audioFrames = 0;

        try {
            await writable.write(tag);
            await writable.write(placeholderXing);

            let pending = Promise.resolve(firstRaw);
            for (let i = 0; i < urls.length; i++) {
                const raw = await pending;
                if (i + 1 < urls.length) pending = fetchChapterAudio(urls[i + 1]);
                const audio = stripXingFrame(raw);
                if (!audio.length) throw new Error(`chapter ${urls[i].index} had no MPEG frames after header strip`);
                const frames = countMpegFrames(audio);
                audioFrames += frames;
                audioBytes += audio.length;
                await writable.write(audio);
                downloadElem.innerHTML += `Appended ${i + 1}/${urls.length} (chapter ${urls[i].index}, ${frames} frames, ${(audioBytes / 1e6).toFixed(1)} MB audio)<br>`;
                downloadElem.scrollTo(0, downloadElem.scrollHeight);
            }

            const totalFrames = audioFrames + 1;
            const totalBytes = audioBytes + placeholderXing.length;
            const finalXing = makeXingFrame(proto, totalFrames, totalBytes);
            if (finalXing.length !== placeholderXing.length) {
                throw new Error('Xing frame length changed between placeholder and final write');
            }
            await writable.seek(tag.length);
            await writable.write(finalXing);
            downloadElem.innerHTML += `Patched Xing header: ${totalFrames} frames, ${totalBytes} bytes (seek table rebuilt).<br>`;
        } catch (e) {
            try { await writable.close(); } catch (closeErr) { /* ignore */ }
            throw new Error(
                `Aborted single-MP3 after ${(audioBytes / 1e6).toFixed(1)} MB. ` +
                `A partial file may remain. ${e.message}`
            );
        }

        await writable.close();
        downloadElem.innerHTML += `<b>Done! Single MP3 on disk (${(audioBytes / 1e6).toFixed(1)} MB audio + ${tag.length} byte ID3 + Xing). Duration should match TLEN/CHAP without bitrate guessing.</b><br>`;
        downloadElem.scrollTo(0, downloadElem.scrollHeight);
        return true;
    }

    async function fetchWithRetry(url, fetchOpts, label, progress, maxAttempts = 3) {
        let lastErr;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const res = await fetch(url, fetchOpts);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res;
            } catch (e) {
                lastErr = e;
                if (progress) progress(` retry ${attempt}/${maxAttempts} failed for ${label}: ${e.message}`);
                if (attempt < maxAttempts) {
                    await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
                }
            }
        }
        throw lastErr;
    }

    async function fetchCover(coverUrl, progress) {
        try {
            const blob = await gmFetchBlob(coverUrl);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const mime = blob.type || 'image/jpeg';
            progress(`Cover image fetched (${blob.size} bytes) via GM.xmlHttpRequest.`);
            return { blob, bytes, mime };
        } catch (e) {
            progress(`NOTE: GM cover fetch failed (${e.message}); trying page fetch.`);
            try {
                const coverRes = await fetchWithRetry(coverUrl, {}, 'cover image', progress);
                const blob = await coverRes.blob();
                const bytes = new Uint8Array(await blob.arrayBuffer());
                progress(`Cover image fetched (${blob.size} bytes) via page fetch.`);
                return { blob, bytes, mime: blob.type || 'image/jpeg' };
            } catch (e2) {
                progress(`NOTE: cover image unavailable: ${e.message}`);
                return { blob: null, bytes: null, mime: null };
            }
        }
    }

    function safeFilename(title) {
        return String(title || '').trim().replace(/[\\/:*?"<>|]/g, '_');
    }

    let downloadState = -1;
    async function createAndDownloadMp3(urls){
        let metadata = getMetadata();
        let coverBytes = null;
        let coverMime = null;

        if (metadata.coverUrl) {
            const cover = await fetchCover(metadata.coverUrl, (msg) => downloadElem.innerHTML += msg + "<br>");
            coverBytes = cover.bytes;
            coverMime = cover.mime;
            downloadElem.innerHTML += "Cover downloaded <br>";
        }

        const filename = getAuthorString() + ' - ' + BIF.map.title.main + '.mp3';

        // Try streaming via File System Access API
        const w = pageWindow();
        if (typeof w.showSaveFilePicker === 'function') {
            try {
                const handle = await pickSaveFile(filename, [{
                    description: 'MP3 Audio',
                    accept: {'audio/mpeg': ['.mp3']},
                }]);
                await buildAudiobookSingleMp3(urls, metadata, coverBytes, coverMime, handle);
                downloadState = -1;
                downloadElem.innerHTML = "";
                downloadElem.classList.remove("active");
                return;
            } catch (err) {
                if (err.name === 'AbortError') {
                    downloadElem.innerHTML += "Download cancelled by user.<br>";
                    downloadState = -1;
                    return;
                }
                if (err && err.name === "LibreGrabSkipPicker") {
                // Expected: cross-origin player iframes cannot open a file picker.
            } else {
                console.error("Streaming download failed:", err);
            }
                downloadElem.innerHTML += "Streaming failed, using fallback...<br>";
            }
        }

        // Fallback: download individual tagged chapters as ZIP
        downloadElem.innerHTML += "Downloading and tagging chapters for ZIP...<br>";
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const totalLogicalChapters = metadata.chapters ? metadata.chapters.length : urls.length;
        const results = new Array(urls.length);
        let idx = 0;
        const CONCURRENCY = 6;
        const totalBytes = { done: 0 };

        async function worker() {
            while (true) {
                const i = idx++;
                if (i >= urls.length) break;
                const url = urls[i];
                const label = `chapter ${url.index}`;
                try {
                    const res = await fetchWithRetry(url.url, { method: 'GET' }, label, (msg) => downloadElem.innerHTML += msg + "<br>");
                    const arrayBuffer = await res.arrayBuffer();
                    totalBytes.done += arrayBuffer.byteLength;

                    const taggedBlob = tagChapterMp3(arrayBuffer, {
                        book: BIF.map,
                        displayTitle: BIF.map.title.main,
                        author: getAuthorString(),
                        narrator: getNarratorString(),
                        seriesName: (BIF.map.series && BIF.map.series[0]) || null,
                        seriesIndex: null,
                        chapterNumber: url.index,
                        totalChapters: totalLogicalChapters,
                        durationMs: url.duration * 1000,
                        coverBytes,
                        coverMime,
                        progress: (msg) => downloadElem.innerHTML += msg + "<br>"
                    });

                    const num = String(url.index).padStart(2, '0');
                    results[i] = { ok: true, chapterNumber: url.index, filename: `${num} - Chapter ${url.index}.mp3`, blob: taggedBlob };
                    downloadElem.innerHTML += `Fetched + tagged ${i + 1}/${urls.length} (${label}, ${(totalBytes.done / 1e6).toFixed(1)} MB so far)<br>`;
                    downloadElem.scrollTo(0, downloadElem.scrollHeight);
                } catch (e) {
                    results[i] = { ok: false, chapterNumber: url.index, error: e.message };
                    downloadElem.innerHTML += `FAILED: ${label} - ${e.message}<br>`;
                    downloadElem.scrollTo(0, downloadElem.scrollHeight);
                }
            }
        }

        await Promise.all(Array.from({ length: CONCURRENCY }, worker));

        const failed = results.filter(r => !r.ok);
        if (failed.length) {
            const failedList = failed.map(f => `chapter ${f.chapterNumber} (${f.error})`).join(', ');
            downloadElem.innerHTML += `<b>Aborted: ${failed.length}/${urls.length} chapter(s) failed: ${failedList}</b><br>`;
            downloadState = -1;
            downloadElem.classList.remove("active");
            return;
        }

        downloadElem.innerHTML += `All ${urls.length} chapters downloaded successfully (${(totalBytes.done / 1e6).toFixed(1)} MB total).<br>`;
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        // Build ZIP with metadata, cover, and tagged chapters
        downloadElem.innerHTML += "Assembling zip...<br>";
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const makeZip = await getDownloadZip();
        if (typeof makeZip !== 'function') throw new Error('client-zip failed to load.');

        const files = [];
        if (coverBytes) {
            files.push({ name: 'cover.jpg', input: coverBytes });
        }
        results.forEach(r => files.push({ name: r.filename, input: r.blob }));

        downloadElem.innerHTML += `Zipping ${files.length} files...<br>`;
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const zipBlob = await makeZip(files).blob();
        const outputFilename = safeFilename(getAuthorString() + ' - ' + BIF.map.title.main) + '.zip';

        downloadElem.innerHTML += "Sending ZIP to the top-level download handler…<br>";
        try {
            await requestSaveFromTopFrame(zipBlob, outputFilename, "application/zip");
            downloadElem.innerHTML += "<b>Download complete!</b><br>";
        } catch (error) {
            if (error && error.name === "AbortError") {
                downloadElem.innerHTML += "Download cancelled by user.<br>";
            } else {
                console.error("Top-level save failed", error);
                downloadElem.innerHTML += "<b>Save failed:</b> " + String(error && error.message ? error.message : error) + "<br>";
            }
        }

        downloadState = -1;
        downloadElem.innerHTML = "";
        downloadElem.classList.remove("active");
    }

    function exportMP3(){
        if (downloadState != -1)
            return;

        downloadState = 0;
        downloadElem.classList.add("active");
        downloadElem.innerHTML = "<b>Starting MP3</b><br>";
        createAndDownloadMp3(getUrls()).then((p)=>{});
    }

    async function exportChapters(){
        if (downloadState != -1) return;
        downloadState = 1;
        downloadElem.classList.add("active");
        downloadElem.innerHTML = "<b>Starting ZIP export</b><br>";

        const metadata = getMetadata();
        let coverBytes = null;
        if (metadata.coverUrl) {
            const cover = await fetchCover(metadata.coverUrl, (msg) => downloadElem.innerHTML += msg + "<br>");
            coverBytes = cover.bytes;
        }

        const urls = getUrls();
        const totalLogicalChapters = metadata.chapters ? metadata.chapters.length : urls.length;
        const results = new Array(urls.length);
        let idx = 0;
        const CONCURRENCY = 6;
        const totalBytes = { done: 0 };

        async function worker() {
            while (true) {
                const i = idx++;
                if (i >= urls.length) break;
                const url = urls[i];
                const label = `chapter ${url.index}`;
                try {
                    const res = await fetchWithRetry(url.url, { method: 'GET' }, label, (msg) => downloadElem.innerHTML += msg + "<br>");
                    const arrayBuffer = await res.arrayBuffer();
                    totalBytes.done += arrayBuffer.byteLength;

                    const taggedBlob = tagChapterMp3(arrayBuffer, {
                        book: BIF.map,
                        displayTitle: BIF.map.title.main,
                        author: getAuthorString(),
                        narrator: getNarratorString(),
                        seriesName: (BIF.map.series && BIF.map.series[0]) || null,
                        seriesIndex: null,
                        chapterNumber: url.index,
                        totalChapters: totalLogicalChapters,
                        durationMs: url.duration * 1000,
                        coverBytes,
                        coverMime: coverBytes ? 'image/jpeg' : null,
                        progress: (msg) => downloadElem.innerHTML += msg + "<br>"
                    });

                    const num = String(url.index).padStart(2, '0');
                    results[i] = { ok: true, chapterNumber: url.index, filename: `${num} - Chapter ${url.index}.mp3`, blob: taggedBlob };
                    downloadElem.innerHTML += `Fetched + tagged ${i + 1}/${urls.length} (${label}, ${(totalBytes.done / 1e6).toFixed(1)} MB so far)<br>`;
                    downloadElem.scrollTo(0, downloadElem.scrollHeight);
                } catch (e) {
                    results[i] = { ok: false, chapterNumber: url.index, error: e.message };
                    downloadElem.innerHTML += `FAILED: ${label} - ${e.message}<br>`;
                    downloadElem.scrollTo(0, downloadElem.scrollHeight);
                }
            }
        }

        await Promise.all(Array.from({ length: CONCURRENCY }, worker));

        const failed = results.filter(r => !r.ok);
        if (failed.length) {
            const failedList = failed.map(f => `chapter ${f.chapterNumber} (${f.error})`).join(', ');
            downloadElem.innerHTML += `<b>Aborted: ${failed.length}/${urls.length} chapter(s) failed: ${failedList}</b><br>`;
            downloadState = -1;
            downloadElem.classList.remove("active");
            return;
        }

        downloadElem.innerHTML += `All ${urls.length} chapters downloaded successfully (${(totalBytes.done / 1e6).toFixed(1)} MB total).<br>`;
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        // Build ZIP
        downloadElem.innerHTML += "Assembling zip...<br>";
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const makeZip = await getDownloadZip();
        if (typeof makeZip !== 'function') throw new Error('client-zip failed to load.');

        const files = [];
        if (coverBytes) {
            files.push({ name: 'cover.jpg', input: coverBytes });
        }
        results.forEach(r => files.push({ name: r.filename, input: r.blob }));

        downloadElem.innerHTML += `Zipping ${files.length} files...<br>`;
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const zipBlob = await makeZip(files).blob();
        const outputFilename = safeFilename(getAuthorString() + ' - ' + BIF.map.title.main) + '.zip';

        downloadElem.innerHTML += "Sending ZIP to the top-level download handler…<br>";
        try {
            await requestSaveFromTopFrame(zipBlob, outputFilename, "application/zip");
            downloadElem.innerHTML += "<b>Download complete!</b><br>";
        } catch (error) {
            if (error && error.name === "AbortError") {
                downloadElem.innerHTML += "Download cancelled by user.<br>";
            } else {
                console.error("Top-level save failed", error);
                downloadElem.innerHTML += "<b>Save failed:</b> " + String(error && error.message ? error.message : error) + "<br>";
            }
        }

        downloadState = -1;
        downloadElem.innerHTML = "";
        downloadElem.classList.remove("active");
    }

    // Helper function for fallback blob download (older browsers)
    async function fallbackBlobDownload(files, filename) {
        downloadElem.innerHTML += "Using fallback download method...<br>";
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const zipBlob = await (await getDownloadZip())(files).blob();

        downloadElem.innerHTML += "Generated zip file! <br>";
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const downloadUrl = URL.createObjectURL(zipBlob);

        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => URL.revokeObjectURL(downloadUrl), 100);
    }

    async function createAndDownloadZip(urls, addMeta) {
        const files = [];

        let coverBlob = null;
        if (BIF.map.title && BIF.map.title.main) {
            const metadata = getMetadata();
            if (metadata.coverUrl) {
                const response = await fetch(metadata.coverUrl);
                coverBlob = await response.blob();
            }
        }

        // Fetch all files and add them to the files array
        const fetchPromises = urls.map(async (url) => {
            const response = await fetch(url.url);
            const arrayBuffer = await response.arrayBuffer();
            const blob = new Blob([arrayBuffer], { type: url.type });
            files.push({
                name: `${getAuthorString()} - ${BIF.map.title.main}.${url.index}.mp3`,
                input: blob
            });
        });

        await Promise.all(fetchPromises);

        if (addMeta) {
            const meta = await createMetadata();
            files.push(...meta);
        }

        const zipBlob = await (await getDownloadZip())(files).blob();

        const downloadUrl = URL.createObjectURL(zipBlob);

        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = `${getAuthorString()} - ${BIF.map.title.main}.zip`;
        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(() => URL.revokeObjectURL(downloadUrl), 100);
    }

    if (typeof BIF !== 'undefined' && BIF && BIF.map) {
        buildPirateUi();
    } else {
        console.log('BIF not ready, waiting...');
        const checkBIF = setInterval(() => {
            if (typeof BIF !== 'undefined' && BIF && BIF.map) {
                clearInterval(checkBIF);
                buildPirateUi();
            }
        }, 500);
    }

    } // end mainCode

    // Inject into page context
    const script = document.createElement('script');
    script.textContent = '(' + mainCode.toString() + ')();';
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();

    // Load client-zip in extension context (for fallback)
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/client-zip@2.5.0/worker.js';
    s.onload = () => {
        window.__libregrabResolveClientZip?.(window.downloadZip);
    };
    s.onerror = () => {
        window.__libregrabRejectClientZip?.(new Error('client-zip failed to load'));
    };
    document.head.appendChild(s);
})();