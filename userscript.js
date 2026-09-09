// ==UserScript==
// @name          LibreGRAB
// @namespace     http://tampermonkey.net/
// @version       2026-06-01
// @description   Download all the booty! - ID3 tagging enabled
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
// @run-at        document-start
// @icon          https://www.google.com/s2/favicons?sz=64&domain=libbyapp.com
// @grant GM.xmlHttpRequest
// @grant GM_xmlhttpRequest
// @downloadURL https://update.greasyfork.org/scripts/498782/LibreGRAB.user.js
// @updateURL https://update.greasyfork.org/scripts/498782/LibreGRAB.meta.js
// ==/UserScript==

// Chrome (Tampermonkey/MV3) runs userscripts in an isolated JS world, meaning
// overrides to JSON.parse and Function.prototype.bind never reach the page's
// own execution context. The fix is to inject the main script body into the
// real page world. client-zip is fetched here (where CSP does not apply to the
// extension context) and injected into the page once it is ready.

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
    // Since the ffmpeg.js file is 50mb, it slows the page down too much
    // to be in a "require" attribute, so we load it in async
    function addFFmpegJs(){
        let scriptTag = document.createElement("script");
        scriptTag.setAttribute("type", "text/javascript");
        scriptTag.setAttribute("src", "https://github.com/PsychedelicPalimpsest/FFmpeg-js/releases/download/14/0.12.5.bundle.js");
        document.body.appendChild(scriptTag);

        return new Promise(accept =>{
            let i = setInterval(()=>{
                if (window.createFFmpeg){
                    clearInterval(i);
                    accept(window.createFFmpeg);
                }
            }, 50)
            });
    }

    let downloadElem;
    let BIF;
    async function getDownloadZip() {
        if (window.downloadZip) return window.downloadZip;
        if (window.__libregrabClientZipReady) return window.__libregrabClientZipReady;
        throw new Error("client-zip did not load");
    }
    let _ID3WriterPromise = null;
    function loadID3Writer() {
        if (!_ID3WriterPromise) {
            _ID3WriterPromise = import('https://cdn.jsdelivr.net/npm/browser-id3-writer@6/+esm')
                .then(mod => {
                    const Writer = mod.ID3Writer;
                    if (typeof Writer !== 'function') throw new Error('ID3Writer named export not found on module');
                    return Writer;
                });
        }
        return _ID3WriterPromise;
    }

    function logLine(html) {
        downloadElem.innerHTML += html;
        downloadElem.scrollTo(0, downloadElem.scrollHeight);
    }
    const CSS = `
    .pNav{
        background-color: red;
        width: 100%;
        display: flex;
        justify-content: space-between;
    }
    .pLink{
        color: blue;
        text-decoration-line: underline;
        padding: .25em;
        font-size: 1em;
    }
    .foldMenu{
        position: absolute;
        width: 100%;
        height: 0%;
        z-index: 1000;

        background-color: grey;
        color: white;

        overflow-x: hidden;
        overflow-y: scroll;

        transition: height 0.3s
    }
    .active{
        height: 40%;
        border: double;
    }
    .pChapLabel{
        font-size: 2em;
    }`;
    /* =========================================
              BEGIN AUDIOBOOK SECTION!
       =========================================
    */


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
    function generateTOCFFmpeg(metadata){
        if (!metadata.chapters) return null;
        let lastTitle = null;

        const duration = Math.round(BIF.map.spine.map((x)=>x["audio-duration"]).reduce((acc, val) => acc + val)) * 1000000000;

        let toc = ";FFMETADATA1\n\n";

        // Get the offset for each spine element
        let temp = 0;
        const spineSpecificOffset = BIF.map.spine.map((x)=>{
            let old = temp;
            temp += x["audio-duration"]*1;
            return old;
        });

        // Libby chapter split over many mp3s have duplicate chapters, so we must filter them
        // then convert them to be in [title, start_in_nanosecs]
        let chapters = metadata.chapters.filter((x)=>{
            let ret = x.title !== lastTitle;
            lastTitle = x.title;
            return ret;
        }).map((x)=>[
            // Escape the title
            x.title.replaceAll("\\", "\\\\").replaceAll("#", "\\#").replaceAll(";", "\\;").replaceAll("=", "\\=").replaceAll("\n", ""),
            // Calculate absolute offset in nanoseconds
            Math.round(spineSpecificOffset[x.spine] + x.offset) * 1000000000
        ]);

        // Transform chapter to be [title, start_in_nanosecs, end_in_nanosecounds]
        let last = duration;
        for (let i = chapters.length - 1; -1 != i; i--){
            chapters[i].push(last);
            last = chapters[i][1];
        }

        chapters.forEach((x)=>{
            toc += "[CHAPTER]\n";
            toc += `START=${x[1]}\n`;
            toc += `END=${x[2]}\n`;
            toc += `title=${x[0]}\n`;
        });

        return toc;
    }

    async function tagChapterMp3(arrayBuffer, { book, displayTitle, author, narrator, seriesName, seriesIndex, chapterNumber, totalChapters, durationMs, coverBlob, progress }) {
        try {
            const ID3Writer = await loadID3Writer();
            const writer = new ID3Writer(arrayBuffer);

            const chapterTitle = chapterNumber === 0 ? `${displayTitle} - Opening Credits` : `Chapter ${chapterNumber}`;
            writer.setFrame('TIT2', chapterTitle);
            writer.setFrame('TALB', displayTitle);
            writer.setFrame('TPE1', [author]);
            writer.setFrame('TPE2', narrator);
            writer.setFrame('TCOM', [narrator]);
            writer.setFrame('TRCK', totalChapters ? `${chapterNumber}/${totalChapters}` : String(chapterNumber));
            if (seriesIndex) writer.setFrame('TPOS', String(seriesIndex));
            if (book.street_date) {
                const yearMatch = String(book.street_date).match(/^(\d{4})/);
                if (yearMatch) writer.setFrame('TYER', yearMatch[1]);
            }
            if (durationMs) writer.setFrame('TLEN', String(Math.round(durationMs)));
            if (coverBlob) {
                const coverArrayBuffer = await coverBlob.arrayBuffer();
                writer.setFrame('APIC', { type: 3, data: coverArrayBuffer, description: 'Cover' });
            }

            writer.addTag();
            return new Blob([writer.arrayBuffer], { type: 'audio/mpeg' });
        } catch (e) {
            if (progress) progress(`  NOTE: ID3 tagging failed for chapter ${chapterNumber} (file kept untagged): ${e.message}`);
            return new Blob([arrayBuffer], { type: 'audio/mpeg' });
        }
    }

    // Parse an MPEG audio frame header and return frame metadata
    function parseMpegFrameHeader(bytes, offset) {
        if (offset + 4 > bytes.length) return null;
        const frameSync = (bytes[offset] << 4) | (bytes[offset + 1] >> 4);
        if (frameSync !== 0xFFF) return null;

        const version = (bytes[offset + 1] >> 3) & 0x03; // 0=MPEG2.5, 1=reserved, 2=MPEG2, 3=MPEG1
        const layer = (bytes[offset + 1] >> 1) & 0x03; // 0=reserved, 1=Layer3, 2=Layer2, 3=Layer1
        if (version === 1 || layer === 0) return null;

        const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0F;
        const samplingRateIndex = (bytes[offset + 2] >> 2) & 0x03;
        const channelMode = (bytes[offset + 3] >> 6) & 0x03;
        const isMpeg1 = version === 3 || version === 2; // MPEG-1 or MPEG-2
        const isLayer3 = layer === 1;

        const bitrateTable = isMpeg1 ? [
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
            [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
            [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
            [0, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 0],
            [0, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 64, 0],
            [0, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 96, 0],
            [0, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 128, 0],
            [0, 160, 160, 160, 160, 160, 160, 160, 160, 160, 160, 160, 160, 160, 160, 0],
            [0, 192, 192, 192, 192, 192, 192, 192, 192, 192, 192, 192, 192, 192, 192, 0],
            [0, 224, 224, 224, 224, 224, 224, 224, 224, 224, 224, 224, 224, 224, 224, 0],
            [0, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 0],
            [0, 288, 288, 288, 288, 288, 288, 288, 288, 288, 288, 288, 288, 288, 288, 0],
            [0, 320, 320, 320, 320, 320, 320, 320, 320, 320, 320, 320, 320, 320, 320, 0],
            [0, 352, 352, 352, 352, 352, 352, 352, 352, 352, 352, 352, 352, 352, 352, 0],
            [0, 384, 384, 384, 384, 384, 384, 384, 384, 384, 384, 384, 384, 384, 384, 0]
        ] : layer === 1 ? [
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            [0, 32, 40, 48, 56, 64, 72, 80, 88, 96, 112, 128, 144, 160, 0, 0],
            [0, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8]
        ] : layer === 2 ? [
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448],
            [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224]
        ] : [
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        ];

        const bitrateKbps = bitrateTable[version][bitrateIndex];
        const samplingRateTable = isMpeg1 ? [16000, 44100, 48000, 32000] : [8000, 16000, 22050, 11025];
        const samplingRate = samplingRateTable[samplingRateIndex];
        const frameLength = samplingRate === 0 ? 0 : Math.floor(144 * bitrateKbps * 1000 / samplingRate) + 1;

        // Side information length (bytes after the 4-byte frame header)
        let sideInfoLength = 0;
        if (isMpeg1 && layer === 3) {
            sideInfoLength = channelMode === 3 ? 17 : 32;
        } else if (isMpeg1 && layer === 2) {
            sideInfoLength = channelMode === 3 ? 17 : 32;
        } else if (!isMpeg1 && layer === 3) {
            sideInfoLength = channelMode === 3 ? 9 : 17;
        } else if (!isMpeg1 && layer === 2) {
            sideInfoLength = channelMode === 3 ? 9 : 17;
        }

        return {
            frameLength,
            sideInfoLength,
            channelMode
        };
    }

    // Find the Xing/LAME header within the first audio frame
    function findXingHeaderOffset(bytes, audioStartOffset) {
        const header = parseMpegFrameHeader(bytes, audioStartOffset);
        if (!header) return -1;

        const xingOffset = audioStartOffset + 4 + header.sideInfoLength;
        if (xingOffset + 4 > bytes.length) return -1;

        const tag = String.fromCharCode(bytes[xingOffset], bytes[xingOffset + 1], bytes[xingOffset + 2], bytes[xingOffset + 3]);
        if (tag !== "Xing" && tag !== "Info") return -1;

        const flags = (bytes[xingOffset + 4] << 24) | (bytes[xingOffset + 5] << 16) | (bytes[xingOffset + 6] << 8) | bytes[xingOffset + 7];
        return {
            offset: xingOffset,
            flags,
            hasFrames: (flags & 0x01) !== 0,
            hasBytes: (flags & 0x02) !== 0
        };
    }

    // Count MPEG frames in an ArrayBuffer (for Xing header total frame count)
    function countMpegFrames(arrayBuffer) {
        const bytes = new Uint8Array(arrayBuffer);
        let count = 0;
        for (let i = 0; i < bytes.length - 3; i++) {
            if (bytes[i] === 0xFF && (bytes[i + 1] & 0xE0) === 0xE0) {
                const header = parseMpegFrameHeader(bytes, i);
                if (header && header.frameLength > 0) {
                    count++;
                    i += header.frameLength - 1;
                }
            }
        }
        return count;
    }

    // Patch the Xing header at the end of the stream with total frame count and byte count
    async function patchXingHeader(handle, xingInfo) {
        if (!xingInfo || xingInfo.offset === -1) return;

        try {
            const syncHandle = await handle.createSyncAccessHandle();
            syncHandle.seek(xingInfo.offset + 8);
            syncHandle.write(new DataView(new ArrayBuffer(4)).setUint32(0, xingInfo.totalFrames, false).buffer);
            if (xingInfo.hasBytes) {
                const bytesView = new DataView(new ArrayBuffer(4));
                bytesView.setUint32(0, xingInfo.totalBytes, false);
                syncHandle.write(bytesView.buffer);
            }
            syncHandle.flush();
            syncHandle.close();
        } catch (err) {
            console.warn("Could not patch Xing header:", err);
        }
}

    // Find the end of ID3v2 tag to get to the start of audio data
    function findID3v2End(bytes) {
        // Check if there's an ID3v2 tag at the start
        if (bytes.length >= 10 && 
            bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
            // ID3v2 tag size is encoded as 4 bytes, each using only 7 bits
            const size = ((bytes[6] & 0x7F) << 21) |
                        ((bytes[7] & 0x7F) << 14) |
                        ((bytes[8] & 0x7F) << 7) |
                        (bytes[9] & 0x7F);
            return 10 + size; // Skip the 10-byte header + tag size
        }
        return 0; // No ID3v2 tag
    }
    
    // Main streaming function: writes chapters sequentially to a single file
    async function buildAudiobookSingleMp3(urls, metadata, coverBlob, handle) {
        downloadElem.innerHTML = "<b>Downloading and tagging chapters...</b><br>";
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const writable = await handle.createWritable();
        const totalChapters = metadata.chapters ? metadata.chapters.length : urls.length;

        let totalFrames = 0;
        let totalBytes = 0;
        let firstXingInfo = null;

        for (let i = 0; i < totalChapters; i++) {
            const url = urls[i];
            const progress = (msg) => downloadElem.innerHTML += msg + "<br>";

            // Fetch chapter audio (ArrayBuffer)
            const response = await fetch(url.url);
            const arrayBuffer = await response.arrayBuffer();

            // Tag the chapter with ID3 metadata (same as current)
            const taggedBlob = await tagChapterMp3(arrayBuffer, {
                book: BIF.map,
                displayTitle: BIF.map.title.main,
                author: getAuthorString(),
                narrator: getNarratorString(),
                seriesName: null,
                seriesIndex: null,
                chapterNumber: url.index,
                totalChapters: totalChapters,
                durationMs: url.duration * 1000,
                coverBlob,
                progress
            });

            const taggedArrayBuffer = await taggedBlob.arrayBuffer();
            const bytes = new Uint8Array(taggedArrayBuffer);

            // Strip leading ID3 tag / Xing frames if needed
            const id3End = findID3v2End(bytes);
            const audioStartOffset = id3End;

            if (i === 0) {
                const xingInfo = findXingHeaderOffset(bytes, audioStartOffset);
                if (xingInfo && xingInfo.offset !== -1) {
                    firstXingInfo = {
                        offset: xingInfo.offset,
                        flags: xingInfo.flags,
                        hasFrames: xingInfo.hasFrames,
                        hasBytes: xingInfo.hasBytes,
                        totalFrames: 0,
                        totalBytes: 0
                    };
                }
            }

            // Write audio data directly to the writable stream
            await writable.write(bytes);
            totalBytes += taggedArrayBuffer.byteLength;
            totalFrames += countMpegFrames(taggedArrayBuffer);

            downloadElem.innerHTML += `Processed chapter ${i + 1}/${totalChapters}<br>`;
            downloadElem.scrollTo(0, downloadElem.scrollHeight);
        }

        // Patch Xing header to complete the stream
        if (firstXingInfo) {
            firstXingInfo.totalFrames = totalFrames;
            firstXingInfo.totalBytes = totalBytes;
            await patchXingHeader(handle, firstXingInfo);
        }

        await writable.close();
        downloadElem.innerHTML += `<b>Done! Saved: ${handle.name}</b><br>`;
        downloadElem.scrollTo(0, downloadElem.scrollHeight);
    }

    let downloadState = -1;
    let ffmpeg = null;
    async function tagFinalAudiobookMp3(arrayBuffer, metadata, coverBlob, urls) {
        const ID3Writer = await loadID3Writer();
        const writer = new ID3Writer(arrayBuffer);
        const title = metadata && metadata.title ? String(metadata.title) : String(BIF.map.title.main || 'Audiobook');
        const author = getAuthorString();
        const narrator = getNarratorString();
        const durationMs = Math.round(urls.reduce((total, url) => total + (Number(url.duration) || 0), 0) * 1000);
        const chapterCount = metadata && Array.isArray(metadata.chapters) ? metadata.chapters.length : 0;

        // This is one merged audiobook file, not one track per Libby delivery part.
        // browser-id3-writer removes the old ID3 tag, including the first part's
        // "Opening Credits" title and its delivery-part-based TRCK value.
        writer.setFrame('TIT2', title);
        writer.setFrame('TALB', title);
        if (author) {
            writer.setFrame('TPE1', [author]);
            writer.setFrame('TPE2', [author]);
        }
        writer.setFrame('TRCK', '1/1');
        if (durationMs > 0) writer.setFrame('TLEN', durationMs);
        if (narrator) writer.setFrame('TXXX', {
            description: 'Narrator',
            value: narrator,
        });
        writer.setFrame('COMM', {
            description: 'LibreGRAB',
            language: 'eng',
            text: chapterCount
                ? 'Audiobook with ' + chapterCount + ' logical chapters.'
                : 'Audiobook exported by LibreGRAB.',
        });
        if (coverBlob) {
            writer.setFrame('APIC', {
                type: 3,
                data: await coverBlob.arrayBuffer(),
                description: 'Cover',
            });
        }
        writer.addTag();
        return writer.arrayBuffer;
    }

    async function createAndDownloadMp3(urls){
        let metadata = getMetadata();
        let coverBlob = null;
        let coverName = null;

        if (metadata.coverUrl) {
            const csplit = metadata.coverUrl.split(".");
            const response = await fetch(metadata.coverUrl);
            coverBlob = await response.blob();
            coverName = "cover." + csplit[csplit.length-1];
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
                await buildAudiobookSingleMp3(urls, metadata, coverBlob, handle);
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

        // Fallback: original FFmpeg concat method
        await initFFmpeg();
        await ffmpeg.writeFile("chapters.txt", generateTOCFFmpeg(metadata));

        if (coverBlob && coverName) {
            const blob_url = URL.createObjectURL(coverBlob);
            await ffmpeg.writeFileFromUrl(coverName, blob_url);
            URL.revokeObjectURL(blob_url);
        }

        downloadElem.innerHTML += "Downloading mp3 files <br>";
        const totalLogicalChapters = metadata.chapters ? metadata.chapters.length : urls.length;
        let fetchPromises = urls.map(async (url) => {
            const progress = (msg) => downloadElem.innerHTML += msg + "<br>";

            const response = await fetch(url.url);
            const arrayBuffer = await response.arrayBuffer();

            const taggedBlob = await tagChapterMp3(arrayBuffer, {
                book: BIF.map,
                displayTitle: BIF.map.title.main,
                author: getAuthorString(),
                narrator: getNarratorString(),
                seriesName: null,
                seriesIndex: null,
                chapterNumber: url.index,
                totalChapters: totalLogicalChapters,
                durationMs: url.duration * 1000,
                coverBlob,
                progress
            });

            const blob_url = URL.createObjectURL(taggedBlob);
            await ffmpeg.writeFileFromUrl((url.index + 1) + ".mp3", blob_url);
            URL.revokeObjectURL(blob_url);

            downloadElem.innerHTML += `Download of disk ${url.index + 1} complete! <br>`;
            downloadElem.scrollTo(0, downloadElem.scrollHeight);
        });

        await Promise.all(fetchPromises);

        downloadElem.innerHTML += `<br><b>Downloads complete!</b> Now combining them together! (This might take a <b><i>minute</i></b>) <br> Transcode progress: <span id="mp3Progress">0</span> hours in to audiobook<br>`;
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        let files = "";
        for (let i = 0; i < urls.length; i++){
            files += `file '${i+1}.mp3'\n`
        }
        await ffmpeg.writeFile("files.txt", files);

        ffmpeg.setProgress((progress)=>{
            downloadElem.querySelector("#mp3Progress").textContent = (progress.time / 1000000 / 3600).toFixed(2);
        });
        ffmpeg.setLogger(console.log);

        await ffmpeg.exec([
            "-y", "-f", "concat",
            "-i", "files.txt",
            "-i", "chapters.txt"]
            .concat(coverName ? ["-i", coverName] : [])
            .concat([
                "-map_metadata", "-1",
                "-codec", "copy",
                "-map", "0:a",
                "-metadata", `title=${metadata.title}`,
                "-metadata", `album=${metadata.title}`,
                "-metadata", `artist=${getAuthorString()}`,
                "-metadata", `encoded_by=LibbyRip/LibreGRAB`,
                "-c:a", "copy"])
            .concat(coverName ? [
                "-map", "2:v",
                "-metadata:s:v", "title=Album cover",
                "-metadata:s:v", "comment=Cover (front)"]
                : [])
            .concat(["out.mp3"]));

        const blob_url = await ffmpeg.readFileToUrl("out.mp3");
        const finalMp3ArrayBuffer = await fetch(blob_url).then(r => {
            if (!r.ok) throw new Error('Could not read generated MP3: HTTP ' + r.status);
            return r.arrayBuffer();
        });
        const taggedMp3ArrayBuffer = await tagFinalAudiobookMp3(
            finalMp3ArrayBuffer,
            metadata,
            coverBlob,
            urls
        );
        const outputBlob = new Blob([taggedMp3ArrayBuffer], { type: 'audio/mpeg' });
        const outputFilename = getAuthorString() + ' - ' + BIF.map.title.main + '.mp3';
        downloadElem.innerHTML += "Sending MP3 to the top-level download handler…<br>";
        try {
            await requestSaveFromTopFrame(outputBlob, outputFilename, "audio/mpeg");
            downloadElem.innerHTML += "<b>Download complete!</b><br>";
        } catch (error) {
            if (error && error.name === "AbortError") {
                downloadElem.innerHTML += "Download cancelled by user.<br>";
            } else {
                console.error("Top-level save failed", error);
                downloadElem.innerHTML += "<b>Save failed:</b> " + String(error && error.message ? error.message : error) + "<br>";
            }
        }
        URL.revokeObjectURL(blob_url);

        downloadState = -1;
        downloadElem.innerHTML = "";
        downloadElem.classList.remove("active");
        setTimeout(() => URL.revokeObjectURL(blob_url), 100);
    }

    let ffmpegInitPromise = null;

    async function initFFmpeg() {
        console.log("initFFmpeg");
        if (ffmpegInitPromise) return ffmpegInitPromise;
        ffmpegInitPromise = (async () => {
            if (!window.createFFmpeg) {
                downloadElem.innerHTML += "Downloading FFmpeg.wasm (~50MB)<br>";
                console.log("Downloading FFmpeg.wasm (~50MB)");
                await addFFmpegJs();
                downloadElem.innerHTML += "Completed FFmpeg.wasm download<br>";
                console.log("Completed FFmpeg.wasm download");
            }

            // Initialize FFmpeg if not already done
            if (!ffmpeg) {
                downloadElem.innerHTML += "Initializing FFmpeg.wasm<br>";
                console.log("Initializing FFmpeg.wasm");
                ffmpeg = await window.createFFmpeg({ log: true });
                downloadElem.innerHTML += "FFmpeg.wasm initialized<br>";
                console.log("FFmpeg.wasm initialized");
            }
        })();
        return ffmpegInitPromise;
    }

    function exportMP3(){
        if (downloadState != -1)
            return;

        downloadState = 0;
        downloadElem.classList.add("active");
        downloadElem.innerHTML = "<b>Starting MP3</b><br>";
        createAndDownloadMp3(getUrls()).then((p)=>{});
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
            const filename = "Part " + paddy(url.index + 1, 3) + ".mp3";

            const progress = (msg) => downloadElem.innerHTML += msg + "<br>";
            const taggedBlob = await tagChapterMp3(arrayBuffer, {
                book: BIF.map,
                displayTitle: BIF.map.title.main,
                author: getAuthorString(),
                narrator: getNarratorString(),
                seriesName: null,
                seriesIndex: null,
                chapterNumber: url.index,
                totalChapters: urls.length,
                durationMs: url.duration * 1000,
                coverBlob,
                progress
            });

            let partElem = document.createElement("div");
            partElem.textContent = "Download of "+ filename + " complete";
            downloadElem.appendChild(partElem);
            downloadElem.scrollTo(0, downloadElem.scrollHeight);

            downloadState += 1;

            return {
                name: filename,
                input: taggedBlob
            };
        });

        // Start metadata creation in parallel with file downloads
        const metadataPromise = addMeta ? createMetadata() : Promise.resolve([]);

        // Wait for both file downloads and metadata creation to complete
        const [downloadedFiles, metadataFiles] = await Promise.all([
            Promise.all(fetchPromises),
            metadataPromise
        ]);

        files.push(...downloadedFiles);
        files.push(...metadataFiles);

        downloadElem.innerHTML += "<br><b>Downloads complete!</b> Starting ZIP generation and download...<br>";
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const filename = getAuthorString() + ' - ' + BIF.map.title.main + '.zip';

        // Try using File System Access API for streaming (much faster)
        if ('showSaveFilePicker' in window) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description: 'ZIP Archive',
                        accept: {'application/zip': ['.zip']},
                    }],
                });

                downloadElem.innerHTML += "Streaming ZIP file to disk...<br>";
                downloadElem.scrollTo(0, downloadElem.scrollHeight);

                const writable = await handle.createWritable();
                const zipStream = (await getDownloadZip())(files).body;

                await zipStream.pipeTo(writable);

                downloadElem.innerHTML += "Download complete!<br>";
                downloadElem.scrollTo(0, downloadElem.scrollHeight);
            } catch (err) {
                if (err.name === 'AbortError') {
                    // User cancelled the save dialog
                    downloadElem.innerHTML += "Download cancelled by user.<br>";
                } else {
                    console.error('Streaming download failed:', err);
                    downloadElem.innerHTML += "Streaming failed, using fallback...<br>";
                    // Fall back to blob method
                    await fallbackBlobDownload(files, filename);
                }
            }
        } else {
            // Fall back to blob method for older browsers
            await fallbackBlobDownload(files, filename);
        }

        downloadState = -1;
        downloadElem.innerHTML = ""
        downloadElem.classList.remove("active");
    }

    function exportChapters(){
        if (downloadState != -1)
            return;

        downloadState = 0;
        downloadElem.classList.add("active");
        downloadElem.innerHTML = "<b>Starting export</b><br>";
        createAndDownloadZip(getUrls(), true).then((p)=>{});
    }

    // Main entry point for audiobooks
    function bifFoundAudiobook(){
        // New global style info
        let s = document.createElement("style");
        s.innerHTML = CSS;
        document.head.appendChild(s)
        if (odreadCmptParams == null){
            alert("odreadCmptParams not set, so cannot resolve book urls! Please try refreshing.")
            return;
        }

        buildPirateUi();
        initFFmpeg().catch(console.error);
        loadID3Writer()
            .then(() => logLine("ID3 tagging library loaded OK.<br>"))
            .catch(e => logLine(`WARNING: ID3 tagging library failed to load (chapters will be saved untagged): ${e.message}<br>`));
    }



    /* =========================================
              END AUDIOBOOK SECTION!
       =========================================
    */

    /* =========================================
              BEGIN BOOK SECTION!
       =========================================
    */
    const bookNav = `
        <div style="text-align: center; width: 100%;">
           <a class="pLink" id="download"> <h1> Download EPUB </h1> </a>
        </div>
    `;
    const pages = window.pages = {};

    // Libby used the bind method as a way to "safely" expose
    // the decryption module. THIS IS THEIR DOWNFALL.
    // As we can hook bind, allowing us to obtain the
    // decryption function
    const originalBind = Function.prototype.bind;
    Function.prototype.bind = function(...args) {
        const boundFn = originalBind.apply(this, args);

        // Store bound arguments (excluding `this`) for potential decryption function
        boundFn.__boundArgs = args.slice(1);

        // Also store the original function for debugging
        boundFn.__originalFunction = this;

        // If this looks like a decryption function, store it globally
        if (this.toString().includes('decryption') ||
            args.some(arg => typeof arg === 'function' && arg.toString().includes('decryption'))) {
            console.log("Decryption function detected:", this);
            window.__libregrab_decryption_fn = args.find(arg => typeof arg === 'function');
        }

        return boundFn;
    };


    async function waitForChapters(callback){
        let components = getBookComponents();
        // Force all the chapters to load in.
        components.forEach(page =>{
            if (undefined != window.pages[page.id]) return;
            page._loadContent({callback: ()=>{}})
        });
        // But its not instant, so we need to wait until they are all set (see: bifFound())
        while (components.filter((page)=>undefined==window.pages[page.id]).length){
            await new Promise(r => setTimeout(r, 100));
            callback();
            console.log(components.filter((page)=>undefined==window.pages[page.id]).length);
        }
    }
    function getBookComponents(){
        return BIF.objects.reader._.context.spine._.components.filter(p => "hidden" != (p.block || {}).behavior)
    }
    function truncate(path){
        return path.substring(path.lastIndexOf('/') + 1);
    }
    function goOneLevelUp(url) {
        let u = new URL(url);
        if (u.pathname === "/") return url; // Already at root


        u.pathname = u.pathname.replace(/\/[^/]*\/?$/, "/");
        return u.toString();
    }
    function getFilenameFromURL(url) {
        const parsedUrl = new URL(url);
        const pathname = parsedUrl.pathname;
        return pathname.substring(pathname.lastIndexOf('/') + 1);
    }
    async function createContent(files, imgAssests){

        let cssRegistry = {};

        let components = getBookComponents();
        let totComp = components.length;
        downloadElem.innerHTML += `Gathering chapters <span id="chapAcc"> 0/${totComp} </span><br>`
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        let gc = 0;
        await waitForChapters(()=>{
            gc+=1;
            downloadElem.querySelector("span#chapAcc").innerHTML = ` ${components.filter((page)=>undefined!=window.pages[page.id]).length}/${totComp}`;
        });

        downloadElem.innerHTML += `Chapter gathering complete<br>`
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        let idToIfram = {};
        let idToMetaId = {};
        components.forEach(c=>{
            // Nothing that can be done here...
            if (c.sheetBox.querySelector("iframe") == null){
                console.warn("!!!" + window.pages[c.id]);
                return;
            }
            c.meta.id = c.meta.id || crypto.randomUUID()
            idToMetaId[c.id] = c.meta.id;
            idToIfram[c.id] = c.sheetBox.querySelector("iframe");

            c.sheetBox.querySelector("iframe").contentWindow.document.querySelectorAll("link").forEach(link=>{
                cssRegistry[c.id] = cssRegistry[c.id] || [];
                cssRegistry[c.id].push(link.href);

                if (imgAssests.includes(link.href)) return;
                imgAssests.push(link.href);


            });
        });
        let url = location.origin;
        for (let i of Object.keys(window.pages)){
            if (idToIfram[i])
                url = idToIfram[i].src;
            files.push({
                name: "OEBPS/" + truncate(i),
                input: fixXhtml(idToMetaId[i], url, window.pages[i], imgAssests, cssRegistry[i] || [])
            });
        }

        downloadElem.innerHTML += `Downloading assets <span id="assetGath"> 0/${imgAssests.length} </span><br>`
        downloadElem.scrollTo(0, downloadElem.scrollHeight);


        gc = 0;
        await Promise.all(imgAssests.map(name=>(async function(){
            const response = await fetch(name.startsWith("http") ? name : location.origin + "/" + name);
            if (response.status != 200) {
                downloadElem.innerHTML += `<b>WARNING:</b> Could not fetch ${name}<br>`
                downloadElem.scrollTo(0, downloadElem.scrollHeight);
                return;
            }
            const blob = await response.blob();

            files.push({
                name: "OEBPS/" + (name.startsWith("http") ? getFilenameFromURL(name) : name),
                input: blob
            });

            gc+=1;
            downloadElem.querySelector("span#assetGath").innerHTML = ` ${gc}/${imgAssests.length} `;
        })()));
    }
    function enforceEpubXHTML(metaId, url, htmlString, assetRegistry, links) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlString, 'text/html');
        const bod = doc.querySelector("body");
        if (bod){
            bod.setAttribute("id", metaId);
        }

        // Convert all elements to lowercase tag names
        const elements = doc.getElementsByTagName('*');
        for (let el of elements) {
            const newElement = doc.createElement(el.tagName.toLowerCase());

            // Copy attributes to the new element
            for (let attr of el.attributes) {
                newElement.setAttribute(attr.name, attr.value);
            }

            // Move child nodes to the new element
            while (el.firstChild) {
                newElement.appendChild(el.firstChild);
            }

            // Replace old element with the new one
            el.parentNode.replaceChild(newElement, el);
        }

        for (let el of elements) {
            if (el.tagName.toLowerCase() == "img" || el.tagName.toLowerCase() == "image"){
                let src = el.getAttribute("src") || el.getAttribute("xlink:href");
                if (!src) continue;

                if (!(src.startsWith("http://") ||  src.startsWith("https://"))){
                    src = (new URL(src, new URL(url))).toString();
                }
                if (!assetRegistry.includes(src))
                    assetRegistry.push(src);

                if (el.getAttribute("src"))
                    el.setAttribute("src", truncate(src));
                if (el.getAttribute("xlink:href"))
                    el.setAttribute("xlink:href", truncate(src));
            }
        }


        // Ensure the <head> element exists with a <title>
        let head = doc.querySelector('head');
        if (!head) {
            head = doc.createElement('head');
            doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
        }

        let title = head.querySelector('title');
        if (!title) {
            title = doc.createElement('title');
            title.textContent = BIF.map.title.main; // Default title
            head.appendChild(title);
        }

        for (let link of links){
            let src = link;
            if (!(src.startsWith("http://") || src.startsWith("https://"))) {
              src = (new URL(src, new URL(url))).toString();
            }
            let linkElement = doc.createElement('link');
            linkElement.setAttribute("href", truncate(src));
            linkElement.setAttribute("rel", "stylesheet");
            linkElement.setAttribute("type", "text/css");
            head.appendChild(linkElement);
        }

        // Get the serialized XHTML string
        const serializer = new XMLSerializer();
        let xhtmlString = serializer.serializeToString(doc);

        // Ensure proper namespaces (if not already present)
        if (!xhtmlString.includes('xmlns="http://www.w3.org/1999/xhtml"')) {
            xhtmlString = xhtmlString.replace('<html>', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:m="http://www.w3.org/1998/Math/MathML" xmlns:pls="http://www.w3.org/2005/01/pronunciation-lexicon" xmlns:ssml="http://www.w3.org/2001/10/synthesis" xmlns:svg="http://www.w3.org/2000/svg">');
        }

        return xhtmlString;
    }
    function fixXhtml(metaId, url, html, assetRegistry, links){
        html = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
` + enforceEpubXHTML(metaId, url, `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:m="http://www.w3.org/1998/Math/MathML" xmlns:pls="http://www.w3.org/2005/01/pronunciation-lexicon" xmlns:ssml="http://www.w3.org/2001/10/synthesis" xmlns:svg="http://www.w3.org/2000/svg">`
            + html + `</html>`, assetRegistry, links);



        return html;
    }
    function getMimeTypeFromFileName(fileName) {
        const mimeTypes = {
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            png: 'image/png',
            gif: 'image/gif',
            bmp: 'image/bmp',
            webp: 'image/webp',
            mp4: 'video/mp4',
            mp3: 'audio/mp3',
            pdf: 'application/pdf',
            txt: 'text/plain',
            html: 'text/html',
            css: 'text/css',
            json: 'application/json',
            // Add more extensions as needed
        };

        const ext = fileName.split('.').pop().toLowerCase();
        return mimeTypes[ext] || 'application/octet-stream';
    }
    function makePackage(files, assetRegistry){
        const idStore = [];
        const doc = document.implementation.createDocument(
            'http://www.idpf.org/2007/opf', // default namespace
            'package', // root element name
            null // do not specify a doctype
        );

        // Step 2: Set attributes for the root element
        const packageElement = doc.documentElement;
        packageElement.setAttribute('version', '2.0');
        packageElement.setAttribute('xml:lang', 'en');
        packageElement.setAttribute('unique-identifier', 'pub-identifier');
        packageElement.setAttribute('xmlns', 'http://www.idpf.org/2007/opf');
        packageElement.setAttribute('xmlns:dc', 'http://purl.org/dc/elements/1.1/');
        packageElement.setAttribute('xmlns:dcterms', 'http://purl.org/dc/terms/');
        packageElement.setAttribute('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance');

        // Step 3: Create and append child elements to the root
        const metadata = doc.createElementNS('http://www.idpf.org/2007/opf', 'metadata');
        packageElement.appendChild(metadata);

        // Create child elements for metadata
        const dcIdentifier = doc.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:identifier');
        dcIdentifier.setAttribute('id', 'pub-identifier');
        dcIdentifier.textContent = "" + BIF.map["-odread-buid"];
        metadata.appendChild(dcIdentifier);

        // Language
        if (BIF.map.language.length){
            const dcLanguage = doc.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:language');
            dcLanguage.setAttribute('xsi:type', 'dcterms:RFC4646');
            dcLanguage.textContent = BIF.map.language[0];
            packageElement.setAttribute('xml:lang', BIF.map.language[0]);
            metadata.appendChild(dcLanguage);
        }

        // Identifier
        const metaIdentifier = doc.createElementNS('http://www.idpf.org/2007/opf', 'meta');
        metaIdentifier.setAttribute('id', 'meta-identifier');
        metaIdentifier.setAttribute('property', 'dcterms:identifier');
        metaIdentifier.textContent = "" + BIF.map["-odread-buid"];
        metadata.appendChild(metaIdentifier);

        // Title
        const dcTitle = doc.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:title');
        dcTitle.setAttribute('id', 'pub-title');
        dcTitle.textContent = BIF.map.title.main;
        metadata.appendChild(dcTitle);


        // Creator (Author)
        if(BIF.map.creator.length){
            const dcCreator = doc.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:creator');
            dcCreator.textContent = BIF.map.creator[0].name;
            metadata.appendChild(dcCreator);
        }

        // Description
        if(BIF.map.description){
            // Remove HTML tags
            let p = document.createElement("p");
            p.innerHTML = BIF.map.description.full;


            const dcDescription = doc.createElementNS('http://purl.org/dc/elements/1.1/', 'dc:description');
            dcDescription.textContent = p.textContent;
            metadata.appendChild(dcDescription);
        }

        // Step 4: Create the manifest, spine, guide, and other sections...
        const manifest = doc.createElementNS('http://www.idpf.org/2007/opf', 'manifest');
        packageElement.appendChild(manifest);

        const spine = doc.createElementNS('http://www.idpf.org/2007/opf', 'spine');
        spine.setAttribute("toc", "ncx");
        packageElement.appendChild(spine);


        const item = doc.createElementNS('http://www.idpf.org/2007/opf', 'item');
        item.setAttribute('id', 'ncx');
        item.setAttribute('href', 'toc.ncx');
        item.setAttribute('media-type', 'application/x-dtbncx+xml');
        manifest.appendChild(item);


        // Generate out the manifest
        let components = getBookComponents();
        components.forEach(chapter =>{
            const item = doc.createElementNS('http://www.idpf.org/2007/opf', 'item');
            let id = chapter.meta.id || crypto.randomUUID();
            while (idStore.includes(id)) {
              id = id + "-" + crypto.randomUUID();
            }
            item.setAttribute('id', id);
            idStore.push(id);
            item.setAttribute('href', truncate(chapter.meta.path));
            item.setAttribute('media-type', 'application/xhtml+xml');
            manifest.appendChild(item);


            const itemref = doc.createElementNS('http://www.idpf.org/2007/opf', 'itemref');
            itemref.setAttribute('idref', id); // Use the same id as the manifest item
            itemref.setAttribute('linear', "yes");
            spine.appendChild(itemref);
        });

        assetRegistry.forEach(asset => {
            const item = doc.createElementNS('http://www.idpf.org/2007/opf', 'item');
            let aname = asset.startsWith("http") ? getFilenameFromURL(asset) : asset;
            let id = aname.split(".")[0];
            while (idStore.includes(id)) {
              id = id + "-" + crypto.randomUUID();
            }
            item.setAttribute('id', id);
            idStore.push(id);
            item.setAttribute('href', aname);
            item.setAttribute('media-type', getMimeTypeFromFileName(aname));
            manifest.appendChild(item);
        });

        // Step 5: Serialize the document to a string
        const serializer = new XMLSerializer();
        const xmlString = serializer.serializeToString(doc);

        files.push({
            name: "OEBPS/content.opf",
            input: `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n` + xmlString
        });
    }
    function makeToc(files){
        // Step 1: Create the document with a default namespace
        const doc = document.implementation.createDocument(
            'http://www.daisy.org/z3986/2005/ncx/', // default namespace
            'ncx', // root element name
            null // do not specify a doctype
        );

        // Step 2: Set attributes for the root element
        const ncxElement = doc.documentElement;
        ncxElement.setAttribute('version', '2005-1');

        // Step 3: Create and append child elements to the root
        const head = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'head');
        ncxElement.appendChild(head);

        const uidMeta = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'meta');
        uidMeta.setAttribute('name', 'dtb:uid');
        uidMeta.setAttribute('content', "" + BIF.map["-odread-buid"]);
        head.appendChild(uidMeta);

        // Step 4: Create docTitle and add text
        const docTitle = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'docTitle');
        ncxElement.appendChild(docTitle);

        const textElement = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'text');
        textElement.textContent = BIF.map.title.main;
        docTitle.appendChild(textElement);

        // Step 5: Create navMap and append navPoint elements
        const navMap = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'navMap');
        ncxElement.appendChild(navMap);


        let components = getBookComponents();

        components.forEach(chapter =>{
            // First navPoint
            const navPoint1 = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'navPoint');
            navPoint1.setAttribute('id', chapter.meta.id);
            navPoint1.setAttribute('playOrder', '' + (1+chapter.index));
            navMap.appendChild(navPoint1);

            const navLabel1 = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'navLabel');
            navPoint1.appendChild(navLabel1);

            const text1 = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'text');
            text1.textContent = BIF.map.title.main;
            navLabel1.appendChild(text1);

            const content1 = doc.createElementNS('http://www.daisy.org/z3986/2005/ncx/', 'content');
            content1.setAttribute('src', truncate(chapter.meta.path));
            navPoint1.appendChild(content1);
        });


        // Step 6: Serialize the document to a string
        const serializer = new XMLSerializer();
        const xmlString = serializer.serializeToString(doc);

        files.push({
            name: "OEBPS/toc.ncx",
            input: `<?xml version="1.0" encoding="utf-8" standalone="no"?>\n` + xmlString
        });
    }
    async function downloadEPUB(){
        let imageAssets = new Array();
        const files = [];

        // Add mimetype file (must be first and uncompressed for EPUB spec)
        files.push({
            name: "mimetype",
            input: "application/epub+zip"
        });

        // Add META-INF files
        files.push({
            name: "META-INF/container.xml",
            input: `<?xml version="1.0" encoding="UTF-8"?>
                <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                    <rootfiles>
                        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
                    </rootfiles>
                </container>
        `
        });

        // Add required encryption file for DRM compliance (required by EPUB spec)
        files.push({
            name: "META-INF/encryption.xml",
            input: `<?xml version="1.0" encoding="UTF-8"?>
                <encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"/>
        `
        });

        await createContent(files, imageAssets);

        makePackage(files, imageAssets);
        makeToc(files);


        downloadElem.innerHTML += "<br><b>Downloads complete!</b> Starting EPUB generation and download...<br>";
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        const filename = BIF.map.title.main + '.epub';

        // Try using File System Access API for streaming (much faster)
        if ('showSaveFilePicker' in window) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description: 'EPUB eBook',
                        accept: {'application/epub+zip': ['.epub']},
                    }],
                });

                downloadElem.innerHTML += "Streaming EPUB file to disk...<br>";
                downloadElem.scrollTo(0, downloadElem.scrollHeight);

                const writable = await handle.createWritable();
                const zipStream = (await getDownloadZip())(files).body;

                await zipStream.pipeTo(writable);

                downloadElem.innerHTML += "Download complete!<br>";
                downloadElem.scrollTo(0, downloadElem.scrollHeight);
            } catch (err) {
                if (err.name === 'AbortError') {
                    // User cancelled the save dialog
                    downloadElem.innerHTML += "Download cancelled by user.<br>";
                } else {
                    console.error('Streaming download failed:', err);
                    downloadElem.innerHTML += "Streaming failed, using fallback...<br>";
                    // Fall back to blob method
                    await fallbackBlobDownload(files, filename);
                }
            }
        } else {
            // Fall back to blob method for older browsers
            await fallbackBlobDownload(files, filename);
        }

        downloadState = -1;
    }

    // Main entry point for books
    function bifFoundBook(){
        // New global style info
        let s = document.createElement("style");
        s.innerHTML = CSS;
        document.head.appendChild(s)

        if (!window.__bif_cfc1){
            alert("Injection failed! __bif_cfc1 not found");
            return;
        }

        // Debug: Log the original function structure
        console.log("Original __bif_cfc1:", window.__bif_cfc1);
        console.log("__bif_cfc1.__boundArgs:", window.__bif_cfc1.__boundArgs);
        const old_crf1 = window.__bif_cfc1;
        window.__bif_cfc1 = (win, edata)=>{
            // If the bind hook succeeds, then the first element of bound args
            // will be the decryption function. So we just passivly build up an
            // index of the pages!
            if (old_crf1.__boundArgs && old_crf1.__boundArgs[0]) {
                pages[win.name] = old_crf1.__boundArgs[0](edata);
            } else {
                console.warn("Bind args not found, trying alternative decryption method");
                // Try global decryption function if available
                if (window.__libregrab_decryption_fn) {
                    try {
                        pages[win.name] = window.__libregrab_decryption_fn(edata);
                    } catch (error) {
                        console.error("Global decryption function failed:", error);
                    }
                }
                // Final fallback: try to extract decrypted content directly
                try {
                    pages[win.name] = old_crf1(win, edata);
                } catch (error) {
                    console.error("Failed to decrypt content:", error);
                    console.log("Attempting raw edata extraction");
                    pages[win.name] = edata; // Sometimes the edata is already decrypted
                }
            }
            return old_crf1(win, edata);
        };

        buildBookPirateUi();
    }

    function downloadEPUBBBtn(){
        if (downloadState != -1)
            return;

        downloadState = 0;
        downloadElem.classList.add("active");
        downloadElem.innerHTML = "<b>Starting download</b><br>";

        downloadEPUB().then(()=>{});
    }
    function buildBookPirateUi(){
        // Create the nav
        let nav = document.createElement("div");
        nav.innerHTML = bookNav;
        nav.querySelector("#download").onclick = downloadEPUBBBtn;
        nav.classList.add("pNav");
        let pbar = document.querySelector(".nav-progress-bar");
        pbar.insertBefore(nav, pbar.children[1]);



        downloadElem = document.createElement("div");
        downloadElem.classList.add("foldMenu");
        downloadElem.setAttribute("tabindex", "-1"); // Don't mess with tab key
        document.body.appendChild(downloadElem);
    }

    /* =========================================
              END BOOK SECTION!
       =========================================
    */

    /* =========================================
              BEGIN INITIALIZER SECTION!
       =========================================
    */

    // The "BIF" contains all the info we need to download
    // stuff, so we wait until the page is loaded, and the
    // BIF is present, to inject the pirate menu.
    let intr = setInterval(()=>{
        if (window.BIF != undefined && document.querySelector(".nav-progress-bar") != undefined){
            clearInterval(intr);
            BIF = window.BIF;
            let mode = location.hostname.split(".")[1];
            if (mode == "listen"){
                bifFoundAudiobook();
            }else if (mode == "read"){
                bifFoundBook();
            }
        }
    }, 25);
    }

    function injectPageScript(code) {
        const script = document.createElement('script');
        script.textContent = code;
        (document.documentElement || document.head || document.body).appendChild(script);
        script.remove();
    }

    injectPageScript(`${clientZipReadyCode}(${mainCode.toString()})();`);

    fetch('https://unpkg.com/client-zip@2.5.0/worker.js')
        .then(r => r.text())
        .then(clientZipCode => {
            injectPageScript(clientZipCode + ';\nwindow.__libregrabResolveClientZip?.(window.downloadZip);');
        })
        .catch(error => {
            console.error('LibreGRAB: failed to load client-zip', error);
            injectPageScript('window.__libregrabRejectClientZip?.(new Error("client-zip failed to load"));');
        });
})();
