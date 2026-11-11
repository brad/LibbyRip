// ==UserScript==
// @name          LibreGRAB
// @namespace     http://tampermonkey.net/
// @version       2026-11-10
// @description   Download all the booty!
// @author        PsychedelicPalimpsest
// @license       MIT
// @supportURL    https://github.com/PsychedelicPalimpsest/LibbyRip/issues
// @match         *://*.listen.libbyapp.com/*
// @match         *://*.listen.overdrive.com/*
// @match         *://*.read.libbyapp.com/?*
// @match         *://*.read.overdrive.com/?*
// @run-at        document-start
// @icon          https://www.google.com/s2/favicons?sz=64&domain=libbyapp.com
// @grant         none
// @downloadURL https://update.greasyfork.org/scripts/498782/LibreGRAB.user.js
// @updateURL https://update.greasyfork.org/scripts/498782/LibreGRAB.meta.js
// ==/UserScript==

// Chrome (Tampermonkey/MV3) runs userscripts in an isolated JS world, meaning
// overrides to JSON.parse and Function.prototype.bind never reach the page's
// own execution context. The fix is to inject the main script body into the
// real page world. client-zip is fetched here (where CSP does not apply to the
// extension context) and injected into the page once it is ready.

(function () {
    function mainCode() {

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
        // Lazy: the client-zip promise must NOT exist at load. Creating it
        // during parsing redirects the player to terms, so it is created
        // only on first export use, long after the player initialized.
        window.__libregrabClientZipReady = new Promise((resolve, reject) => {
            window.__libregrabResolveClientZip = resolve;
            window.__libregrabRejectClientZip = reject;
        });
        fetch('https://unpkg.com/client-zip@2.5.0/worker.js')
            .then(r => r.text())
            .then(clientZipCode => {
                const tag = document.createElement('script');
                tag.textContent = clientZipCode + ';\nwindow.__libregrabResolveClientZip?.(window.downloadZip);';
                (document.documentElement || document.head || document.body).appendChild(tag);
                tag.remove();
            })
            .catch(error => {
                console.error('LibreGRAB: failed to load client-zip', error);
                window.__libregrabRejectClientZip?.(new Error('client-zip failed to load'));
            });
        return window.__libregrabClientZipReady;
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
        cursor: pointer;
    }
    .foldMenu{
        position: fixed;
        left: 0;
        right: 0;
        top: 8px;
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

    // OverDrive stopped sending -odread-cmpt-params (upstream issue #82), so
    // chapter URLs built from it end in "?undefined" and fetch as 502s. The
    // player itself still requests working URLs, so record the media URLs it
    // requests and prefer those when building chapter URLs. Capture can never
    // break playback: every step is guarded.
    let capturedPlayerUrls = new Map();
    function partKeyFromUrl(u){
        try { return decodeURIComponent(new URL(u, location.href).pathname.split("/").pop()); }
        catch (e) { return null; }
    }
    function recordPlayerUrl(u){
        try {
            if (typeof u !== "string" || u.indexOf(".mp3") === -1) return;
            let key = partKeyFromUrl(u);
            if (key && !capturedPlayerUrls.has(key)) {
                capturedPlayerUrls.set(key, u);
                console.log("[LibreGRAB] Captured player URL for " + key);
            }
        } catch (e) {}
    }
    // No HTMLMediaElement src/setAttribute patch: patching media prototypes
    // is a suspected detection vector (OverDrive navigates to terms when it
    // detects tampering), and capture via mergePerformanceMediaUrls()
    // (performance entries) alone proved sufficient for every part.
    function mergePerformanceMediaUrls(){
        try {
            let entries = performance.getEntriesByType("resource") || [];
            for (let i = 0; i < entries.length; i++) {
                let en = entries[i];
                if ((en.initiatorType === "audio" || en.initiatorType === "media") && en.name) recordPlayerUrl(en.name);
            }
        } catch (e) {}
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
    let libreShadowHost = null;
    let libreShadowRoot = null;

    function buildPirateUi(){
        // Create the nav
        let nav = document.createElement("div");
        nav.innerHTML = audioBookNav;
        nav.querySelector("#chap").onclick = viewChapters;
        nav.querySelector("#down").onclick = exportMP3;
        nav.querySelector("#exp").onclick = exportChapters;
        nav.classList.add("pNav");
        let pbar = document.querySelector(".nav-progress-bar");
        pbar.insertBefore(libreShadowHost, pbar.children[1]);
        libreShadowRoot.appendChild(nav);

        // Create the chapters menu
        chapterMenuElem = document.createElement("div");
        chapterMenuElem.classList.add("foldMenu");
        chapterMenuElem.setAttribute("tabindex", "-1"); // Don't mess with tab key
        const urls = getUrls();

        chapterMenuElem.innerHTML = chaptersMenu.replace("{CHAPTERS}", urls.length);
        libreShadowRoot.appendChild(chapterMenuElem);

        downloadElem = document.createElement("div");
        downloadElem.classList.add("foldMenu");
        downloadElem.setAttribute("tabindex", "-1"); // Don't mess with tab key
        libreShadowRoot.appendChild(downloadElem);
    }
    function getUrls(){
        let ret = [];
        for (let spine of BIF.objects.spool.components){
            let partFile = null;
            try { partFile = decodeURIComponent(spine.meta.path); } catch (e) { partFile = spine.meta.path; }
            let captured = partFile ? capturedPlayerUrls.get(partFile) : null;
            let data = {

                url: captured || location.origin + "/" + spine.meta.path + "?" + (odreadCmptParams || [])[spine.spinePosition],
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

    let downloadState = -1;
    let ffmpeg = null;
    async function createAndDownloadMp3(urls){
        await initFFmpeg();
        let metadata = getMetadata();
        downloadElem.innerHTML += "Downloading mp3 files <br>";
        await ffmpeg.writeFile("chapters.txt", generateTOCFFmpeg(metadata));


        let fetchPromises = urls.map(async (url) => {
            // Download the mp3
            const response = await fetch(url.url);
            const blob = await response.blob();

            // Dump it into ffmpeg (We do the request here as not to bog down the worker thread)
            const blob_url = URL.createObjectURL(blob);
            await ffmpeg.writeFileFromUrl((url.index + 1) + ".mp3", blob_url);
            URL.revokeObjectURL(blob_url);


            downloadElem.innerHTML += `Download of disk ${url.index + 1} complete! <br>`
            downloadElem.scrollTo(0, downloadElem.scrollHeight);
        });

        let coverName = null;

        if (metadata.coverUrl){
            console.log(metadata.coverUrl);
            const csplit = metadata.coverUrl.split(".");
            const response = await fetch(metadata.coverUrl);
            const blob = await response.blob();

            coverName = "cover." + csplit[csplit.length-1];

            const blob_url = URL.createObjectURL(blob);
            await ffmpeg.writeFileFromUrl(coverName, blob_url);
            URL.revokeObjectURL(blob_url);
        }


        await Promise.all(fetchPromises);

        downloadElem.innerHTML += `<br><b>Downloads complete!</b> Now combining them together! (This might take a <b><i>minute</i></b>) <br> Transcode progress: <span id="mp3Progress">0</span> hours in to audiobook<br>`
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        let files = "";

        for (let i = 0; i < urls.length; i++){
            files += `file '${i+1}.mp3'\n`
        }
        await ffmpeg.writeFile("files.txt", files);

        ffmpeg.setProgress((progress)=>{
            // The progress.time feature seems to be in micro secounds
            downloadElem.querySelector("#mp3Progress").textContent = (progress.time / 1000000 / 3600).toFixed(2);
        });
        ffmpeg.setLogger(console.log);

        await ffmpeg.exec([
                           "-y", "-f", "concat",
                           "-i", "files.txt",
                           "-i", "chapters.txt"]
                          .concat(coverName ? ["-i", coverName] : [])
                          .concat([
                            "-map_metadata", "1",
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



        let blob_url = await ffmpeg.readFileToUrl("out.mp3");

        const link = document.createElement('a');
        link.href = blob_url;

        link.download = getAuthorString() + ' - ' + BIF.map.title.main + '.mp3';
        document.body.appendChild(link);
        link.click();
        link.remove();

        downloadState = -1;
        downloadElem.innerHTML = ""
        downloadElem.classList.remove("active");

        // Clean up the object URL
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

    // Fill in any chapter URLs the player has not provided yet by driving the
    // player itself through the missing parts: seeking to a part makes the
    // player set that part's working URL on its audio element, which the
    // capture hook records. No manual seeking needed. Parts whose URLs
    // already carry a query are left alone, so players with working params
    // (e.g. Libby) are untouched. The original position is always restored.
    function hasWorkingUrl(u){
        return /\?.+=/.test(u.url);
    }
    async function ensurePlayerUrls(urls){
        mergePerformanceMediaUrls();
        urls = getUrls();
        let missing = urls.filter(function(u){ return !hasWorkingUrl(u); });
        if (!missing.length) return getUrls();
        let spool = BIF.objects && BIF.objects.spool;
        let compass = BIF.objects && BIF.objects.compass;
        if (!spool || !compass || typeof compass.at !== "function") return getUrls();
        let origFloc = spool.focus ? spool.focus.floc : 0;
        downloadElem.innerHTML += "Gathering audio <span id=\"sweepAcc\"></span><br>";
        try {
            for (let i = 0; i < missing.length; i++) {
                let u = missing[i];
                let sweepSpan = downloadElem.querySelector("span#sweepAcc"); if (sweepSpan) sweepSpan.textContent = "part " + (u.index + 1) + " of " + urls.length + "…";
                try {
                    let fracUsed = (u.index === urls.length - 1) ? (0.25 + Math.random() * 0.5) : (0.01 + Math.random() * 0.98); let place = compass.at({ floc: u.index + fracUsed });
                    if (place && typeof place.seek === "function") place.seek();
                } catch (e) {}
                let waited = 0;
                while (waited < 2000) {
                    mergePerformanceMediaUrls();
                    if (hasWorkingUrl(getUrls().filter(function(x){ return x.index === u.index; })[0] || u)) break;
                    await new Promise(function(r){ setTimeout(r, 100); });
                    waited += 100;
                }
                if (i < missing.length - 1) {
                    await new Promise(function(r){ setTimeout(r, 400 + Math.random() * 1200); });
                }
            }
            let settled = 0;
            while (settled < 20000) {
                mergePerformanceMediaUrls();
                if (!getUrls().filter(function(x){ return !hasWorkingUrl(x); }).length) break;
                await new Promise(function(r){ setTimeout(r, 500); });
                settled += 500;
            }
        } finally {
            try {
                let back = compass.at({ floc: origFloc });
                if (back && typeof back.seek === "function") back.seek();
            } catch (e) {}
            let sweepDone = downloadElem.querySelector("span#sweepAcc"); if (sweepDone) sweepDone.textContent = "complete";
        }
        mergePerformanceMediaUrls();
        return getUrls();
    }

    function exportMP3(){
        if (downloadState != -1)
            return;

        downloadState = 0;
        downloadElem.classList.add("active");
        downloadElem.innerHTML = "<b>Starting MP3</b><br>";
        ensurePlayerUrls(getUrls()).then(function(urls){
            let bad = urls.filter(function(u){ return !hasWorkingUrl(u); });
            if (bad.length) {
                downloadElem.innerHTML += "<b>Cannot export:</b> no working URL for part(s) " + bad.map(function(u){ return u.index + 1; }).join(", ") + ". Try playing through those parts first, then export again.<br>";
                downloadState = -1;
                return;
            }
            createAndDownloadMp3(urls).then((p)=>{});
        }).catch(function(err){
            downloadElem.innerHTML += "<b>Error:</b> " + err.message + "<br>";
            downloadState = -1;
        });
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

        // Fetch all files and add them to the files array
        const fetchPromises = urls.map(async (url) => {
            const response = await fetch(url.url);
            const blob = await response.blob();
            const filename = "Part " + paddy(url.index + 1, 3) + ".mp3";

            let partElem = document.createElement("div");
            partElem.textContent = "Download of "+ filename + " complete";
            downloadElem.appendChild(partElem);
            downloadElem.scrollTo(0, downloadElem.scrollHeight);

            downloadState += 1;

            return {
                name: filename,
                input: blob
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
        ensurePlayerUrls(getUrls()).then(function(urls){
            let bad = urls.filter(function(u){ return !hasWorkingUrl(u); });
            if (bad.length) {
                downloadElem.innerHTML += "<b>Cannot export:</b> no working URL for part(s) " + bad.map(function(u){ return u.index + 1; }).join(", ") + ". Try playing through those parts first, then export again.<br>";
                downloadState = -1;
                return;
            }
            downloadElem.innerHTML += "Downloading...<br>";
            createAndDownloadZip(urls, true).then((p)=>{});
        }).catch(function(err){
            downloadElem.innerHTML += "<b>Error:</b> " + err.message + "<br>";
            downloadState = -1;
        });
    }

    // Main entry point for audiobooks
    function bifFoundAudiobook(){
        // New global style info
        libreShadowHost = document.createElement("div");
        libreShadowHost.style.display = "contents";
        libreShadowRoot = libreShadowHost.attachShadow({mode: "closed"});
        let s = document.createElement("style");
        s.innerHTML = CSS;
        libreShadowRoot.appendChild(s)
        if (odreadCmptParams == null){
            alert("odreadCmptParams not set, so cannot resolve book urls! Please try refreshing.")
            return;
        }

        buildPirateUi();
        initFFmpeg().catch(console.error);
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
    // NOTE: the old window.pages mechanism (a Function.prototype.bind
    // hook feeding a pages index) is gone. Chapter gathering now uses
    // the capture/decrypt helpers below, ported from fork PR #4: they
    // decrypt each chapter shell as it loads instead of depending on
    // the reader's own pages index, which no longer fills on the
    // current reader.


    // A chapter is ready as soon as its iframe has a src: plain chapters
    // are already-decrypted XHTML, encrypted ones hand their payload to
    // parent.__bif_cfc1 / __bif_cfc0 as the iframe loads (see capture).
    function chapterUrl(c){
        const f = c.sheetBox && c.sheetBox.querySelector("iframe");
        return (f && f.src) ? f.src : null;
    }
    // Standalone payload decryption (replicates the bifocal "rumi"
    // transform): cfc1 payloads are base64 with each 4-char group's 1st
    // and 4th characters swapped; cfc0 payloads are plain base64.
    function decryptPayload(edata, isCfc1){
        return atob(isCfc1 ? edata.replace(/(.)(.)(.)(.)/g, "$4$2$3$1") : edata);
    }

    // Each chapter shell is just <head> (styles) + <body><script>
    // parent.__bif_cfc1(self,'<edata>')</script></body>. The edata is base64
    // with every 4-char group's 1st and 4th characters swapped; decoding it
    // yields the real <body>...</body> HTML. This replicates the reader's own
    // __bif_cfc1 decryptor so the download doesn't depend on their globals.
    //
    // Returns {html, status}. Status is one of:
    //   "decrypted"     - payload found and decrypted into a real <body>
    //   "unencrypted"   - no payload and no <script> in the body (cover, title, ...)
    //   "unknown-shell" - no payload match, but the body holds a <script>:
    //                     the shell format changed and we cannot decrypt it
    //   "decrypt-failed"- payload found but the transform threw
    //   "bad-payload"   - payload decrypted to something that is not a <body>
    function decryptChapterShell(shellHtml){
        const m = shellHtml.match(/parent\.__bif_cfc1\(self,'([^']+)'\)/)
               || shellHtml.match(/parent\.__bif_cfc0\(self,'([^']+)'\)/);
        if (!m){
            const hasScript = /<body[^>]*>[\s\S]*<script/i.test(shellHtml);
            return {html: shellHtml, status: hasScript ? "unknown-shell" : "unencrypted"};
        }
        const isCfc1 = shellHtml.includes("__bif_cfc1");
        let decrypted;
        try{
            decrypted = decryptPayload(m[1], isCfc1);
        }catch(e){
            return {html: shellHtml, status: "decrypt-failed"};
        }
        if (!/^\s*<body/i.test(decrypted)){
            return {html: shellHtml, status: "bad-payload"};
        }
        // Splice the decrypted <body> into the shell, keeping its <head> (styles).
        const spliced = shellHtml.replace(/<body[^>]*>[\s\S]*<\/body>/i, ()=>decrypted);
        return {html: spliced !== shellHtml ? spliced : shellHtml, status: "decrypted"};
    }


    // Chapter capture: every chapter shell hands its payload to
    // parent.__bif_cfc1 / __bif_cfc0 as its iframe loads. Wrapping those
    // functions lets us decrypt and stash each chapter *during* the load
    // waitForChapters already forces, instead of fetching every signed
    // chapter URL a second time afterwards (each chapter was requested
    // twice per download, which is both wasteful and conspicuous).
    // Captured HTML is keyed by the chapter window's name, which the
    // reader sets to the spine component id. The original function is
    // always called through so the reader renders normally.
    const capturedChapters = {};
    // Plain chapters harvested from their frames during the gather
    // pass: the reader recycles distant chapter frames as new ones
    // load, so by build time a plain chapter's frame may be gone even
    // though it loaded fine. Harvest while it is definitely alive.
    const harvestedChapters = {};
    // Stylesheet links per chapter, snapshotted at settle time for
    // the same reason: they live in the chapter's frame document,
    // which the reader may remove before build time.
    const harvestedCss = {};
    const realCfcHandlers = {};
    function makeCfcCapture(kind){
        const isCfc1 = kind === "__bif_cfc1";
        return function(win, edata){
            try {
                const html = decryptPayload(edata, isCfc1);
                if (win && win.name && /^\s*<body/i.test(html))
                    capturedChapters[win.name] = html;
            } catch(e) {
                console.warn("LibreGRAB: chapter capture failed for " + kind, e);
            }
            const real = realCfcHandlers[kind];
            if (typeof real === "function")
                return real(win, edata);
        };
    }
    function installCfcCapture(kind){
        const wrapper = makeCfcCapture(kind);
        if (typeof window[kind] === "function")
            realCfcHandlers[kind] = window[kind];
        try {
            // A property trap, so a handler the reader defines *after*
            // this runs is wrapped on assignment too.
            Object.defineProperty(window, kind, {
                configurable: true,
                enumerable: true,
                get(){ return wrapper; },
                set(fn){
                    if (typeof fn === "function" && fn !== wrapper)
                        realCfcHandlers[kind] = fn;
                }
            });
        } catch(e) {
            window[kind] = wrapper;
        }
    }
    function installChapterCapture(){
        installCfcCapture("__bif_cfc1");
        installCfcCapture("__bif_cfc0");
    }

    function chapterCaptureFor(c, idToIfram){
        const iframe = idToIfram[c.id];
        return capturedChapters[c.id] ||
            (iframe && iframe.name ? capturedChapters[iframe.name] : undefined);
    }
    // A chapter is settled when its capture arrived, or its iframe has
    // finished loading and no longer holds a shell script (a plain
    // chapter that never calls __bif_cfc*, or a load the capture
    // missed); those fall back to fetching in createContent.
    // Read a chapter straight out of its already-loaded iframe instead
    // of fetching its URL again from outside the iframe. Only for
    // settled chapters the capture did not claim: plain chapters
    // (covers, title pages) never call __bif_cfc*, and a rendered
    // chapter's document no longer holds the shell script either.
    // Returns null when the chapter is not safely readable this way.
    function harvestLoadedChapter(c, idToIfram){
        const iframe = idToIfram[c.id];
        if (!iframe || !iframe.src) return null;
        let doc;
        try { doc = iframe.contentWindow && iframe.contentWindow.document; }
        catch(e) { return null; }
        if (!doc || !doc.documentElement || doc.readyState !== "complete")
            return null;
        if (doc.documentElement.innerHTML.includes("__bif_cfc"))
            return null; // shell has not run yet (or capture is coming)
        if (!doc.body || !doc.body.innerHTML.trim()) return null;
        return doc.documentElement.outerHTML;
    }
    function chapterDocSettled(c, idToIfram){
        const iframe = idToIfram[c.id];
        if (!iframe || !iframe.src) return !iframe;
        let doc;
        try { doc = iframe.contentWindow && iframe.contentWindow.document; }
        catch(e) { return true; }
        if (!doc || !doc.documentElement) return false;
        // An iframe whose src was assigned but which has not navigated
        // yet still shows its initial about:blank document, which is
        // "complete" and shell-free - that is NOT settled, the chapter
        // has not even started loading.
        if (!doc.URL || !doc.URL.startsWith("http")) return false;
        return doc.readyState === "complete" &&
            !doc.documentElement.innerHTML.includes("__bif_cfc");
    }

    // A chapter URL suitable for resolving relative asset paths
    // against, for chapters whose content we already hold (captured or
    // harvested) but whose frame the reader has since recycled: the
    // signed URL if the frame survives, else the chapter's own path
    // on this origin (asset fetches work unsigned; the token in the
    // signed URL is not needed for base resolution).
    function chapterBaseUrl(c, idToIfram){
        const f = idToIfram[c.id];
        if (f && f.src) return f.src;
        return location.origin + "/" + c.id;
    }
    // Names of spine chapters that have no file entry - used as a
    // hard completeness check before the EPUB is written, so a
    // partially-built book can never be saved silently.
    function missingChapterFiles(files, components){
        const names = new Set(files.map(f => f.name));
        return components
            .map(c => "OEBPS/" + truncate(c.id))
            .filter(n => !names.has(n));
    }

    // Load chapters one at a time, in spine order, waiting for each to
    // settle (captured, or its document finished loading shell-free)
    // before starting the next. Loading the whole spine at once is a
    // burst no human reader produces; one by one in order looks like
    // someone flipping through the book, and it makes the capture
    // race-free. A chapter that does not settle within the timeout is
    // left for the fallback fetch rather than stalling the download.
    // OverDrive: the reader's background pagination pass never runs
    // while a download is in progress, so waiting for it cannot work.
    // The table of contents DOES force a chapter to load: clicking an
    // entry jumps the reader there in ~1s and renders its frame. So:
    // open the ToC, click each entry in order, harvest the frame it
    // loads, then jump back to the chapter the download started on.
    // Libby keeps the _loadContent + capture path (its chapters are
    // encrypted shells, not plain docs).
    // Reader ToC helpers (hoisted: used by waitForChapters).
    // Pure DOM helpers; visibleIndex stays inside
    // waitForChapters (it needs the local components list).
    const panelOpen = () => {
        try { return (document.body.innerText || '').toLowerCase().indexOf('search within book') >= 0; }
        catch(e) { return false; }
    };
    const menuBtn = () => {
        try {
            return [...document.querySelectorAll('button, [role="button"]')].find(b => /\bMENU\b/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')));
        } catch(e) { return undefined; }
    };
    const titleLine = () => {
        try {
            const el = document.querySelector('.chapter-bar-title-button') || [...document.querySelectorAll('[class*="chapter-bar-title"]')][0];
            if (!el) return '';
            return (el.innerText || '').trim().split('\n')[0].trim();
        } catch(e) { return ''; }
    };
    const tocEntries = () => {
        try {
            const out = [];
            const seen = new Set();
            for (const li of document.querySelectorAll('li')) {
                if (!/Page \d+/.test(li.innerText || '')) continue;
                const btn = li.querySelector('button');
                const t = btn ? (btn.innerText || '').trim() : (li.innerText || '').trim().split('\n')[0].trim();
                if (!t || seen.has(t)) continue;
                seen.add(t);
                out.push(t);
            }
            return out;
        } catch(e) { return []; }
    };
    // Wait until the ToC entry list stops growing (two
    // consecutive polls with the same count), up to 90s.
    // Entries populate progressively after the page-counting
    // pass; returning on the first entry gives a partial list,
    // and a later entry missing from it gets skipped by the
    // loop. Returns whatever is there after the timeout.
    const stableEntries = async () => {
        let last = -1, stable = 0;
        for (let i = 0; i < 45; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const e = tocEntries();
            if (e.length > 0 && e.length === last) {
                stable++;
                if (stable >= 2) return e;
            } else {
                stable = 0;
                last = e.length;
            }
        }
        return tocEntries();
    };
    const openToc = async () => {
        // If the ToC list is already showing, just wait for it to
        // settle. (Do NOT return early merely because the menu sheet
        // is open: it may be on the main menu, with no list at all,
        // and polling then waits for entries that will never appear.)
        if (tocEntries().length > 0) return stableEntries();
        if (!panelOpen()) {
            const btn = menuBtn();
            if (btn) btn.click();
            await new Promise(r => setTimeout(r, 1200));
        }
        const leaves = [...document.querySelectorAll('*')].filter(el => el.children.length === 0 && (el.textContent || '').trim().toLowerCase() === 'table of contents');
        const vis = leaves.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        if (vis.length) {
            let deepest = vis[0], depth = -1;
            for (const el of vis) {
                let d = 0, p = el;
                while (p.parentElement) { d++; p = p.parentElement; }
                if (d > depth) { depth = d; deepest = el; }
            }
            // The leaf can sit below the viewport (y > 839 on this
            // reader), where the click does not open the list.
            // Scroll it into view first.
            try { deepest.scrollIntoView({block: 'center'}); } catch(_) {}
            await new Promise(r => setTimeout(r, 400));
            deepest.click();
        }
        return stableEntries();
    };
    const clickEntry = (title) => {
        try {
            const words = title.toLowerCase();
            const pick = (cands) => {
                if (!cands.length) return null;
                let deepest = cands[0], depth = -1;
                for (const el of cands) {
                    let d = 0, p = el;
                    while (p.parentElement) { d++; p = p.parentElement; }
                    if (d > depth) { depth = d; deepest = el; }
                }
                return deepest;
            };
            const all = [...document.querySelectorAll('button, a, li')].filter(el => {
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });
            // Exact match first: the title button's text IS
            // the title. Contains-match is the fallback for
            // short titles that are substrings of others.
            let target = pick(all.filter(el => (el.innerText || '').trim().toLowerCase() === words));
            if (!target) target = pick(all.filter(el => (el.innerText || '').trim().toLowerCase().indexOf(words) >= 0));
            if (!target) return false;
            target.click();
            return true;
        } catch(e) { return false; }
    };
    async function waitForChapters(callback){
        let components = getBookComponents();
        if (/read\.overdrive\.com$/i.test(location.hostname)){
            // OverDrive gathers by navigation, not by waiting for the
            // reader's background pagination pass (it never runs while
            // a download is in progress). openToc opens the table of
            // contents, scrolls its entry into view, and waits for the
            // entry list to stop growing; each entry is clicked in
            // order, with one retry, which forces its frame to load.
            // After the ToC loop, components still missing are walked
            // with the reader's Next/Previous Chapter controls, and
            // the walk sweeps after every step even when the arrival
            // could not be confirmed (a component may load without
            // registering a visible index). A chapter that still has
            // no frame is fetched in createContent from its signed
            // URL (spine path + per-component token, as the audiobook
            // path builds it) instead of skipped. The ToC loop gets
            // its own 10-min budget inside the 15-min gather budget,
            // so a slow ToC cannot starve the walk; an empty ToC
            // falls through to the walk instead of aborting.
            const visibleIndex = () => {
                try {
                    let best = -1, bestX = 1e9;
                    components.forEach((c, i) => {
                        const f = c.sheetBox && c.sheetBox.querySelector('iframe');
                        if (!f || !f.src) return;
                        const r = f.getBoundingClientRect();
                        if (r.width > 0 && Math.abs(r.x) < Math.abs(bestX)) { bestX = r.x; best = i; }
                    });
                    return best;
                } catch(e) { return -1; }
            };
            const sweepSettled = (done) => {
                for (let page of components) {
                    if (done.has(page.id)) continue;
                    const f = page.sheetBox && page.sheetBox.querySelector('iframe');
                    if (!f || !f.src) continue;
                    const one = {}; one[page.id] = f;
                    if (chapterCaptureFor(page, one)) { done.add(page.id); callback(); continue; }
                    if (chapterDocSettled(page, one)) {
                        try {
                            const fdoc = f.contentWindow && f.contentWindow.document;
                            if (fdoc) {
                                const links = Array.from(fdoc.querySelectorAll('link')).map(l => l.href).filter(Boolean);
                                if (links.length) harvestedCss[page.id] = links;
                            }
                        } catch(e) { /* frame already gone */ }
                        if (!harvestedChapters[page.id]) {
                            const h = harvestLoadedChapter(page, one);
                            if (h) { harvestedChapters[page.id] = h; done.add(page.id); callback(); }
                        }
                    }
                }
            };
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const startTitle = titleLine();
            const startIndex = visibleIndex();
            const done = new Set();
            // Two budgets: the ToC loop gets 10 min, the whole gather
            // (loop + leftover walk + jump-back) gets 15 min, so a
            // slow ToC cannot starve the walk.
            const deadline = Date.now() + 900000;
            const tocDeadline = Date.now() + 600000;
            sweepSettled(done);
            // Go to one ToC entry (open the sheet, click it, wait for
            // the title), retrying once before giving up on it. A
            // single failed click must not silently skip the chapter.
            const gotoEntry = async (title) => {
                for (let attempt = 0; attempt < 2; attempt++) {
                    entries = await openToc();
                    if (!entries.length) return false;
                    if (!clickEntry(title)) continue;
                    const t0 = Date.now();
                    while (Date.now() - t0 < 12000) {
                        if (titleLine() === title) return true;
                        await sleep(500);
                    }
                }
                return false;
            };
            // Step the reader to a component index with its own Next /
            // Previous Chapter controls (no ToC needed).
            const gotoIndex = async (targetIdx) => {
                // Direction of travel from where the reader starts.
                const startCur = visibleIndex();
                const forward = startCur < 0 ? true : startCur < targetIdx;
                for (let step = 0; step < 30; step++) {
                    if (Date.now() > deadline) return false;
                    const cur = visibleIndex();
                    if (cur === targetIdx) return true;
                    if (cur < 0) { await sleep(1000); continue; }
                    // Overshoot: the reader skipped past the target.
                    // Its Next / Previous Chapter controls do not stop
                    // at every spine component, a footnote block is
                    // skipped as a group (one Next click from the last
                    // real chapter jumps the visible index past all of
                    // them). Do not keep stepping and oscillating; the
                    // frames the reader just loaded are swept by the
                    // caller, which is how the group gets gathered.
                    if (forward && cur > targetIdx) return false;
                    if (!forward && cur < targetIdx) return false;
                    const btn = [...document.querySelectorAll('button, a, [role="button"]')].find(el => {
                        const r = el.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) return false;
                        const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim();
                        return cur < targetIdx ? /next chapter/i.test(label) : /previous chapter/i.test(label);
                    });
                    if (!btn) return false;
                    btn.click();
                    const t0 = Date.now();
                    while (Date.now() - t0 < 5000) {
                        if (visibleIndex() === targetIdx) return true;
                        await sleep(500);
                    }
                }
                return visibleIndex() === targetIdx;
            };
            let entries = await openToc();
            if (!entries.length) {
                // Cold page: the counting pass had not filled the ToC
                // yet. Do NOT abort; the walk below reaches the
                // chapters with Next/Previous, and the fetch fallback
                // in createContent covers any that still has no frame.
                downloadElem.innerHTML += 'WARNING: table of contents empty; walking chapters with Next/Previous instead.<br>';
                downloadElem.scrollTo(0, downloadElem.scrollHeight);
            }
            for (const title of entries) {
                if (Date.now() > tocDeadline) break;
                await gotoEntry(title);
                sweepSettled(done);
                if (done.size >= components.length) break;
            }
            sweepSettled(done);
            // Components the ToC walk never reached (no ToC entry, or
            // a missed entry): walk them with the reader's own Next /
            // Previous Chapter controls so each gets a loaded frame.
            // The reader only keeps ~3 frames alive, so a chapter
            // outside the window at the final position has no content
            // and no signed URL without this.
            const missingIdx = [];
            components.forEach((c, i) => { if (!done.has(c.id)) missingIdx.push(i); });
            if (missingIdx.length) {
                downloadElem.innerHTML += `Walking ${missingIdx.length} missed chapter(s) with Next/Previous Chapter<br>`;
                downloadElem.scrollTo(0, downloadElem.scrollHeight);
                for (const idx of missingIdx) {
                    if (Date.now() > deadline) break;
                    // Already gathered as part of a group (e.g. the
                    // footnote block, swept together after one
                    // overshoot); do not walk it again.
                    if (done.has(components[idx].id)) continue;
                    await gotoIndex(idx);
                    // Sweep even if gotoIndex could not confirm the
                    // arrival: the last component (e.g. next-reads)
                    // may not register a visible index, yet its frame
                    // can still be loaded and harvestable. Give it a
                    // moment to settle first.
                    await sleep(2500);
                    sweepSettled(done);
                    if (done.size >= components.length) break;
                }
                sweepSettled(done);
            }
            // Jump back to the chapter the download started on.
            const backTitle = entries.find(t => t === startTitle) || entries.find(t => t.toLowerCase().indexOf(startTitle.toLowerCase().slice(0, 20)) >= 0) || entries[0];
            if (backTitle) {
                await openToc();
                if (clickEntry(backTitle)) {
                    const t0 = Date.now();
                    while (Date.now() - t0 < 12000) {
                        if (titleLine() === backTitle) break;
                        await sleep(500);
                    }
                }
            } else if (startIndex >= 0) {
                await gotoIndex(startIndex);
            }
            if (panelOpen()) {
                const btn = menuBtn();
                if (btn) btn.click();
            }
            return;
        }
        for (let page of components){
            const frameOf = () => page.sheetBox && page.sheetBox.querySelector("iframe");
            if (!chapterUrl(page))
                page._loadContent({callback: ()=>{}});
            const deadline = Date.now() + 15000;
            let retried = false;
            while (Date.now() < deadline){
                const f = frameOf();
                if (f){
                    const one = {}; one[page.id] = f;
                    if (chapterCaptureFor(page, one) || chapterDocSettled(page, one))
                        break;
                    // src set but the frame never navigated (still
                    // about:blank) - ask the reader to load it again.
                    if (!retried && Date.now() > deadline - 12000){
                        retried = true;
                        page._loadContent({callback: ()=>{}});
                    }
                }
                await new Promise(r => setTimeout(r, 200));
            }
            // If the reader has already recycled nothing yet, this is
            // the moment this chapter's frame is guaranteed alive:
            // harvest plain chapters now (encrypted ones are captured).
            const fNow = frameOf();
            if (fNow){
                const one = {}; one[page.id] = fNow;
                try {
                    const fdoc = fNow.contentWindow && fNow.contentWindow.document;
                    if (fdoc){
                        const links = Array.from(fdoc.querySelectorAll("link"))
                            .map(l => l.href).filter(Boolean);
                        if (links.length) harvestedCss[page.id] = links;
                    }
                } catch(e) { /* frame already gone; cssRegistry may miss it */ }
                if (!chapterCaptureFor(page, one) && !harvestedChapters[page.id]){
                    const h = harvestLoadedChapter(page, one);
                    if (h) harvestedChapters[page.id] = h;
                }
            }
            callback();
        }
    }
    function getBookComponents(){
        return BIF.objects.reader._.context.spine._.components.filter(p => "hidden" != (p.block || {}).behavior)
            // Skip the "next-reads" recommendations page: the reader
            // never loads it (no table-of-contents entry, no Next
            // Chapter after the last real chapter, no iframe, and no
            // signed URL token), so it can never be gathered. It is
            // publisher boilerplate, not book content.
            .filter(p => truncate(p.id) !== "next-reads.xhtml")
            // Skip footnote components (Footnote_1, Footnote_2, ...):
            // the reader does not treat them as navigable chapters.
            // Its Next / Previous Chapter controls skip the whole
            // footnote block as a group (one Next click from the last
            // real chapter jumps the visible index past all of them),
            // and it only keeps ~3 frames alive, so the block can
            // never be harvested in full. They cannot be fetched
            // either: OverDrive no longer sends the per-component
            // signed-URL token (-odread-cmpt-params, issue #82), and
            // an unsigned fetch of the chapter path returns 403.
            // Known limitation: the EPUB omits the endnotes. The main
            // text is complete without them.
            .filter(p => !/Footnote_\d+\.xhtml$/.test(truncate(p.id)))
    }
    function truncate(path){
        return path.substring(path.lastIndexOf('/') + 1);
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

        let gatheredCount = 0;
        await waitForChapters(()=>{
            gatheredCount += 1;
            downloadElem.querySelector("span#chapAcc").innerHTML = ` ${gatheredCount}/${totComp}`;
        });

        downloadElem.innerHTML += `Chapter gathering complete<br>`
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        let idToIfram = {};
        let idToMetaId = {};
        components.forEach(c=>{
            // XML ids (OPF/NCX) may not start with a digit; prefix those.
            const rawMetaId = c.meta.id || crypto.randomUUID();
            c.meta.id = (/^[a-zA-Z_]/.test(rawMetaId) ? "" : "chap-") + rawMetaId;
            idToMetaId[c.id] = c.meta.id;

            if (c.sheetBox.querySelector("iframe") == null){
                // The reader recycled this chapter's frame after it
                // loaded. Content survives via capture/harvest, and so
                // do the stylesheet links snapshotted at settle time.
                if (harvestedCss[c.id]) cssRegistry[c.id] = harvestedCss[c.id].slice();
                else console.warn("No iframe for chapter " + c.id);
                return;
            }
            idToIfram[c.id] = c.sheetBox.querySelector("iframe");

            c.sheetBox.querySelector("iframe").contentWindow.document.querySelectorAll("link").forEach(link=>{
                cssRegistry[c.id] = cssRegistry[c.id] || [];
                cssRegistry[c.id].push(link.href);

                if (imgAssests.includes(link.href)) return;
                imgAssests.push(link.href);
            });
        });
        // Chapters were captured and decrypted as their iframes loaded
        // (see installChapterCapture), so most need no network request
        // at all. Only chapters the capture missed are fetched from
        // their signed iframe URL, then decrypted client-side (see
        // decryptChapterShell). The capture fires when a chapter's
        // shell script runs, which lags the forced loads, so wait
        // until every component is settled before building.
        const settleDeadline = Date.now() + 120000;
        while (Date.now() < settleDeadline){
            const pending = components.filter(c =>
                !chapterCaptureFor(c, idToIfram) && !chapterDocSettled(c, idToIfram));
            if (!pending.length) break;
            const acc0 = downloadElem.querySelector("span#chapAcc");
            if (acc0) acc0.innerHTML = ` ${totComp - pending.length}/${totComp}`;
            await new Promise(r => setTimeout(r, 250));
        }

        const capturedById = {};
        components.forEach(c=>{
            const html = chapterCaptureFor(c, idToIfram);
            if (html) capturedById[c.id] = html;
        });
        const capturedCount = Object.keys(capturedById).length;
        console.log(`LibreGRAB: captured ${capturedCount}/${totComp} chapters during load`);
        downloadElem.innerHTML += `Captured ${capturedCount}/${totComp} chapters as they loaded<br>`;
        downloadElem.scrollTo(0, downloadElem.scrollHeight);

        let processed = 0;
        let harvested = 0;
        let refetched = 0;
        for (let c of components){
            // Content first: captured and harvested chapters are used
            // even when the reader has recycled their frame (no signed
            // URL survives then, which used to skip them silently).
            let chapterHtml = capturedById[c.id] || harvestedChapters[c.id];
            if (chapterHtml && harvestedChapters[c.id] && !capturedById[c.id])
                harvested += 1;
            if (!chapterHtml){
                chapterHtml = harvestLoadedChapter(c, idToIfram);
                if (chapterHtml) harvested += 1;
            }
            let signedSrc = (idToIfram[c.id] && idToIfram[c.id].src) || chapterUrl(c);
            if (!signedSrc) {
                // No loaded frame: build the signed URL the same way
                // the audiobook path does (spine path + the
                // per-component token captured from the reader), so a
                // chapter the reader never loaded can still be fetched
                // instead of skipped. Only the missing chapters use
                // this, never a burst fetch of the whole book.
                const tok = (odreadCmptParams || [])[c.meta && c.meta["-odread-spine-position"]];
                if (tok && c.meta && c.meta.path) signedSrc = location.origin + "/" + c.meta.path + "?" + tok;
            }
            const src = signedSrc || chapterBaseUrl(c, idToIfram);
            if (!chapterHtml && !signedSrc){
                const msg = "No chapter content or URL for " + c.id + ", skipping";
                console.warn(msg);
                downloadElem.innerHTML += `<b>WARNING:</b> ${msg}<br>`;
                downloadElem.scrollTo(0, downloadElem.scrollHeight);
                continue;
            }
            if (!chapterHtml){
                refetched += 1;
                let res;
                try {
                    res = await fetch(signedSrc, {credentials: "include"});
                } catch(e) {
                    downloadElem.innerHTML += `<b>WARNING:</b> Could not fetch chapter ${c.id}: ${e}<br>`;
                    downloadElem.scrollTo(0, downloadElem.scrollHeight);
                    continue;
                }
                if (!res.ok) {
                    downloadElem.innerHTML += `<b>WARNING:</b> Could not fetch chapter ${c.id} (HTTP ${res.status})<br>`;
                    downloadElem.scrollTo(0, downloadElem.scrollHeight);
                    continue;
                }
                const chapter = decryptChapterShell(await res.text());
                if (chapter.status !== "decrypted" && chapter.status !== "unencrypted"){
                    const msg = "Chapter " + c.id + ": shell kept as-is (" + chapter.status +
                        ") - page will be empty";
                    console.warn(msg);
                    downloadElem.innerHTML += `<b>WARNING:</b> ${msg}<br>`;
                    downloadElem.scrollTo(0, downloadElem.scrollHeight);
                }
                chapterHtml = chapter.html;
            }
            for (const link of cssRegistry[c.id] || []){
                if (!imgAssests.includes(link)) imgAssests.push(link);
            }
            files.push({
                name: "OEBPS/" + truncate(c.id),
                input: fixXhtml(idToMetaId[c.id] || c.id, src, chapterHtml, imgAssests, cssRegistry[c.id] || [])
            });
            processed += 1;
            const acc = downloadElem.querySelector("span#chapAcc");
            if (acc) acc.innerHTML = ` ${processed}/${totComp}`;
        }
        if (harvested){
            console.log(`LibreGRAB: read ${harvested} chapter(s) from their loaded frames`);
            downloadElem.innerHTML += `Read ${harvested} chapter(s) from their loaded frames<br>`;
            downloadElem.scrollTo(0, downloadElem.scrollHeight);
        }
        if (refetched)
            console.log(`LibreGRAB: re-fetched ${refetched} chapter(s) the capture missed`);


        downloadElem.innerHTML += `Downloading assets <span id="assetGath"> 0/${imgAssests.length} </span><br>`
        downloadElem.scrollTo(0, downloadElem.scrollHeight);


        let gc = 0;
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

        // Hard completeness check (ported from fork PR #4, same lesson
        // as upstream PR #79's fail-incomplete): never save a book
        // that is missing spine chapters.
        const missing = missingChapterFiles(files, getBookComponents());
        if (missing.length){
            downloadElem.innerHTML += `<br><b>ERROR:</b> ${missing.length} of ${getBookComponents().length} chapter(s) missing from the EPUB (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", ..." : ""}). The file was NOT saved - please report this.<br>`;
            downloadElem.scrollTo(0, downloadElem.scrollHeight);
            downloadState = -1;
            return;
        }

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

        // Chapter capture (ported from fork PR #4): wrap the reader's
        // __bif_cfc1/__bif_cfc0 handlers so each chapter shell's payload
        // is decrypted and stashed as it loads, instead of depending on
        // the reader's own pages index (the old mechanism, which no
        // longer fills on the current reader). The original handlers
        // are always called through so the reader renders normally.
        installChapterCapture();

        buildBookPirateUi();
    }

    function downloadEPUBBBtn(){
        if (downloadState != -1)
            return;

        downloadState = 0;
        downloadElem.classList.add("active");
        downloadElem.innerHTML = "<b>Starting download</b><br>";

        downloadEPUB().then(()=>{}).catch(e=>{
            console.error("LibreGRAB: EPUB export failed", e);
            try {
                downloadElem.innerHTML += "<br><b>ERROR:</b> " + (e && e.message ? e.message : e) + "<br>";
                downloadElem.scrollTo(0, downloadElem.scrollHeight);
            } catch(_){}
            downloadState = -1;
        });
    }
    function buildBookPirateUi(){
        // All ebook UI lives in a closed shadow root, mirroring the
        // audiobook fix: plain-DOM writes into the reader tree (nav into
        // the progress bar, foldMenu div onto body) made the reader
        // navigate to the ToC. The display:contents host keeps the button
        // in the progress bar position without disturbing the reader DOM.
        let ebookShadowHost = document.createElement("div");
        ebookShadowHost.style.display = "contents";
        let ebookShadowRoot = ebookShadowHost.attachShadow({mode: "closed"});
        let s = document.createElement("style");
        s.innerHTML = CSS;
        ebookShadowRoot.appendChild(s);
        // Create the nav
        let nav = document.createElement("div");
        nav.innerHTML = bookNav;
        nav.querySelector("#download").onclick = downloadEPUBBBtn;
        nav.classList.add("pNav");
        let pbar = document.querySelector(".nav-progress-bar");
        pbar.insertBefore(ebookShadowHost, pbar.children[1]);
        ebookShadowRoot.appendChild(nav);

        downloadElem = document.createElement("div");
        downloadElem.classList.add("foldMenu");
        downloadElem.setAttribute("tabindex", "-1"); // Don't mess with tab key
        ebookShadowRoot.appendChild(downloadElem);
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
    // Delay UI until the player has fully initialized: building during
    // load races the player's own setup and redirects (audiobooks: to
    // terms; ebooks: to the ToC). Readiness = BIF + a progress bar whose
    // child count is stable across polls, plus the audiobook-only spool
    // components and bootstrap params. A throw while checking never
    // escapes: keep polling.
    let __pbarCount = -1, __stablePolls = 0;
    let intr = setInterval(()=>{
        try {
            const pbar = document.querySelector(".nav-progress-bar");
            if (window.BIF == undefined || pbar == undefined) { __pbarCount = -1; __stablePolls = 0; return; }
            let mode = location.hostname.split(".")[1];
            if (mode != "listen") {
                // Same stability gate as audiobooks: the ebook reader
                // navigates to the ToC if our UI lands while it is still
                // initializing, so wait for its progress bar to settle.
                if (pbar.children.length !== __pbarCount) { __pbarCount = pbar.children.length; __stablePolls = 0; return; }
                if (++__stablePolls < 2) return;
                clearInterval(intr);
                BIF = window.BIF;
                bifFoundBook();
                return;
            }
            const spool = window.BIF.objects && window.BIF.objects.spool;
            const ready = spool && Array.isArray(spool.components) && spool.components.length > 0 &&
                odreadCmptParams != null;
            if (!ready) { __pbarCount = -1; __stablePolls = 0; return; }
            if (pbar.children.length !== __pbarCount) { __pbarCount = pbar.children.length; __stablePolls = 0; return; }
            if (++__stablePolls < 2) return;
            clearInterval(intr);
            BIF = window.BIF;
            bifFoundAudiobook();
        } catch (e) { __pbarCount = -1; __stablePolls = 0; }
    }, 500);
    }

    function injectPageScript(code) {
        const script = document.createElement('script');
        script.textContent = code;
        (document.documentElement || document.head || document.body).appendChild(script);
        script.remove();
    }

    injectPageScript(`(${mainCode.toString()})();`);

})();
