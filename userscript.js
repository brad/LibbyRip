// ==UserScript==
// @name          LibreGRAB
// @namespace     http://tampermonkey.net/
// @version       2026-06-01
// @description   Download all the booty!  Audiobooks export as a streamed ID3-tagged MP3 or a zip of tagged parts.
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
    const clientZipReadyCode = `
window.__libregrabClientZipReady = new Promise((resolve, reject) => {
    window.__libregrabResolveClientZip = resolve;
    window.__libregrabRejectClientZip = reject;
});
`;
    function mainCode() {
    
    let downloadElem;
    let BIF;
    async function getDownloadZip() {
        if (window.downloadZip) return window.downloadZip;
        if (window.__libregrabClientZipReady) return window.__libregrabClientZipReady;
        throw new Error("client-zip did not load");
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

    function logLine(html){
        downloadElem.innerHTML += html;
        downloadElem.scrollTo(0, downloadElem.scrollHeight);
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

    function getCreatorsByRole(role){
        return (BIF.map.creator || [])
            .filter(creator => String(creator.role || "").toLowerCase().includes(role))
            .map(creator => creator.name)
            .filter(Boolean)
            .join(", ");
    }

    function getAuthorString(){
        return getCreatorsByRole("author") || "Unknown";
    }
    
    function getNarratorString(){
        return getCreatorsByRole("narrator");
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

    function guessImageMime(nameOrUrl, fallback){
        const ext = String(nameOrUrl || "").split("?")[0].split(".").pop().toLowerCase();
        return ({
            jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
            gif: "image/gif", webp: "image/webp", bmp: "image/bmp"
        })[ext] || fallback || "image/jpeg";
    }
    
    async function loadCover(metadata){
        if (!metadata || !metadata.coverUrl) return { bytes: null, mime: null, name: null, blob: null };
        try {
            const response = await fetch(metadata.coverUrl);
            if (!response.ok) throw new Error("HTTP " + response.status);
            const blob = await response.blob();
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const ext = metadata.coverUrl.split("?")[0].split(".").pop() || "jpg";
            return { bytes, mime: blob.type || guessImageMime(metadata.coverUrl), name: "cover." + ext, blob };
        } catch (e) {
            console.warn("LibreGRAB: cover fetch failed", e);
            return { bytes: null, mime: null, name: null, blob: null };
        }
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

/* =========================================
           ID3v2.3 + MPEG helpers
   =========================================
*/

function concatBytes(parts){
const arrays = parts.map(p => p instanceof Uint8Array ? p : new Uint8Array(p));
let total = 0;
for (const a of arrays) total += a.length;
const out = new Uint8Array(total);
let o = 0;
for (const a of arrays){ out.set(a, o); o += a.length; }
return out;
}
function u32be(n){
n = n >>> 0;
return new Uint8Array([(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]);
}
function writeU32be(u8, offset, n){
n = n >>> 0;
u8[offset] = (n >>> 24) & 0xFF;
u8[offset + 1] = (n >>> 16) & 0xFF;
u8[offset + 2] = (n >>> 8) & 0xFF;
u8[offset + 3] = n & 0xFF;
}
function synchsafe(n){
n = n >>> 0;
return new Uint8Array([(n >>> 21) & 0x7F, (n >>> 14) & 0x7F, (n >>> 7) & 0x7F, n & 0x7F]);
}
function latin1(str){
const s = String(str ?? "");
const out = new Uint8Array(s.length);
for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
return out;
}
function utf16beBom(str){
const s = String(str ?? "");
const out = new Uint8Array(2 + s.length * 2 + 2);
out[0] = 0xFE; out[1] = 0xFF;
for (let i = 0; i < s.length; i++){
const c = s.charCodeAt(i);
out[2 + i * 2] = (c >> 8) & 0xFF;
out[3 + i * 2] = c & 0xFF;
}
return out;
}
function id3Frame(id, payload){
return concatBytes([latin1(id), u32be(payload.length), new Uint8Array([0, 0]), payload]);
}
function textFrame(id, text){
return id3Frame(id, concatBytes([new Uint8Array([1]), utf16beBom(text)]));
}
function commFrame(text, language){
return id3Frame("COMM", concatBytes([
new Uint8Array([1]),
latin1(String(language || "eng").slice(0, 3).padEnd(3, " ")),
utf16beBom(""),
utf16beBom(String(text ?? ""))
]));
}
function apicFrame(coverBytes, mime){
return id3Frame("APIC", concatBytes([
new Uint8Array([1]),
latin1(mime || "image/jpeg"),
new Uint8Array([0, 3]),
utf16beBom("Cover"),
coverBytes
]));
}
function chapFrame(id, startMs, endMs, title){
return id3Frame("CHAP", concatBytes([
latin1(id), new Uint8Array([0]),
u32be(startMs), u32be(endMs),
new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
textFrame("TIT2", title)
]));
}
function ctocFrame(id, childIds, description){
const kids = [];
for (const cid of childIds){
kids.push(latin1(cid));
kids.push(new Uint8Array([0]));
}
return id3Frame("CTOC", concatBytes([
latin1(id),
new Uint8Array([0, 0x03, childIds.length & 0xFF]),
concatBytes(kids),
textFrame("TIT2", description)
]));
}
function buildId3Tag(frames){
const body = concatBytes(frames);
return concatBytes([latin1("ID3"), new Uint8Array([0x03, 0x00, 0x00]), synchsafe(body.length), body]);
}
function stripId3(buf){
let u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
if (u8.length >= 10 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33){
const size = ((u8[6] & 0x7F) << 21) | ((u8[7] & 0x7F) << 14) | ((u8[8] & 0x7F) << 7) | (u8[9] & 0x7F);
const footer = (u8[5] & 0x10) ? 10 : 0;
const start = 10 + size + footer;
if (start > 0 && start < u8.length) u8 = u8.subarray(start);
}
if (u8.length >= 128 && u8[u8.length - 128] === 0x54 && u8[u8.length - 127] === 0x41 && u8[u8.length - 126] === 0x47){
u8 = u8.subarray(0, u8.length - 128);
}
for (let i = 0; i < u8.length - 1; i++){
if (u8[i] === 0xFF && (u8[i + 1] & 0xE0) === 0xE0) return i === 0 ? u8 : u8.subarray(i);
}
return u8;
}
function writeId3(mp3Buffer, frames){
return concatBytes([buildId3Tag(frames), stripId3(mp3Buffer)]);
}

const BITRATE_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATE_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SR_MPEG1 = [44100, 48000, 32000];
const SR_MPEG2 = [22050, 24000, 16000];
const SR_MPEG25 = [11025, 12000, 8000];

function asciiAt(u8, offset, n){
if (offset + n > u8.length) return "";
let s = "";
for (let i = 0; i < n; i++) s += String.fromCharCode(u8[offset + i]);
return s;
}
function parseMpegHeader(u8, offset){
if (offset + 4 > u8.length) return null;
if (u8[offset] !== 0xFF || (u8[offset + 1] & 0xE0) !== 0xE0) return null;
const b1 = u8[offset + 1], b2 = u8[offset + 2], b3 = u8[offset + 3];
const ver = (b1 >> 3) & 3, layer = (b1 >> 1) & 3, prot = b1 & 1;
const brIdx = (b2 >> 4) & 0xF, srIdx = (b2 >> 2) & 3, padding = (b2 >> 1) & 1;
const chMode = (b3 >> 6) & 3;
if (ver === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
const isMpeg1 = ver === 3, isMpeg25 = ver === 0;
const bitrate = (isMpeg1 ? BITRATE_MPEG1_L3 : BITRATE_MPEG2_L3)[brIdx] * 1000;
const sampleRate = isMpeg1 ? SR_MPEG1[srIdx] : (isMpeg25 ? SR_MPEG25[srIdx] : SR_MPEG2[srIdx]);
if (!bitrate || !sampleRate) return null;
const frameLen = Math.floor(((isMpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding;
if (frameLen < 4) return null;
const channels = chMode === 3 ? 1 : 2;
const sideInfo = isMpeg1 ? (channels === 1 ? 17 : 32) : (channels === 1 ? 9 : 17);
return { frameLen, sideInfo, crc: prot === 0 ? 2 : 0, headerBytes: u8.subarray(offset, offset + 4) };
}
function countMpegFrames(u8){
let i = 0, count = 0;
while (i + 4 <= u8.length){
const h = parseMpegHeader(u8, i);
if (!h || i + h.frameLen > u8.length){ i++; continue; }
count++;
i += h.frameLen;
}
return count;
}
function xingPayloadOffset(header){ return 4 + header.crc + header.sideInfo; }
function leadingSpecialFrameLen(u8){
const h = parseMpegHeader(u8, 0);
if (!h || h.frameLen > u8.length) return 0;
const tag = asciiAt(u8, xingPayloadOffset(h), 4);
if (tag === "Xing" || tag === "Info") return h.frameLen;
if (asciiAt(u8, 36, 4) === "VBRI") return h.frameLen;
return 0;
}
function stripXingFrame(u8){
const n = leadingSpecialFrameLen(u8);
return n ? u8.subarray(n) : u8;
}
function makeXingFrame(proto, frames, bytes){
const frame = new Uint8Array(proto.frameLen);
frame.set(proto.headerBytes, 0);
const off = xingPayloadOffset(proto);
if (off + 116 > frame.length) throw new Error("MPEG frame too small for Xing header");
frame[off] = 0x58; frame[off + 1] = 0x69; frame[off + 2] = 0x6E; frame[off + 3] = 0x67;
writeU32be(frame, off + 4, 0x00000007);
writeU32be(frame, off + 8, frames >>> 0);
writeU32be(frame, off + 12, bytes >>> 0);
for (let i = 0; i < 100; i++) frame[off + 16 + i] = Math.min(255, Math.round((i / 99) * 255));
return frame;
}

function chaptersForSpine(metadata, spineIndex){
if (!metadata || !Array.isArray(metadata.chapters)) return [];
return metadata.chapters.filter(ch => ch.spine === spineIndex);
}

function chapterFramesForPart(metadata, spineIndex, durationSec){
const spineChapters = chaptersForSpine(metadata, spineIndex);
if (!spineChapters.length) return { frames: [], count: 0, warning: null };
for (let i = 1; i < spineChapters.length; i++){
if (spineChapters[i].offset <= spineChapters[i - 1].offset){
return { frames: [], count: 0, warning: "overlapping chapter offsets on spine " + spineIndex };
}
}
const frames = [];
const childIds = [];
let last = null;
for (let i = 0; i < spineChapters.length; i++){
const chap = spineChapters[i];
if (last === null){ last = chap; continue; }
const cid = "ch" + i;
childIds.push(cid);
frames.push(chapFrame(cid, Math.round(last.offset * 1000), Math.max(Math.round(chap.offset * 1000) - 1, Math.round(last.offset * 1000)), last.title));
last = chap;
}
if (last !== null){
const spineDur = (metadata.spine[last.spine] && metadata.spine[last.spine].duration != null)
? metadata.spine[last.spine].duration : durationSec;
const endMs = Math.max(Math.round((spineDur || 0) * 1000), Math.round(last.offset * 1000));
childIds.push("last");
frames.push(chapFrame("last", Math.round(last.offset * 1000), endMs, last.title));
}
if (childIds.length) frames.unshift(ctocFrame("toc", childIds, "Table of Contents"));
return { frames, count: childIds.length, warning: null };
}

function absoluteBookChapters(metadata){
const spineOffsets = [];
let acc = 0;
for (const s of (metadata.spine || [])){
spineOffsets.push(acc);
acc += Number(s.duration) || 0;
}
const totalMs = Math.round(acc * 1000);
let lastTitle = null;
const chapters = [];
for (const ch of (metadata.chapters || [])){
if (ch.title === lastTitle) continue;
lastTitle = ch.title;
const startMs = Math.round(((spineOffsets[ch.spine] || 0) + (Number(ch.offset) || 0)) * 1000);
chapters.push({ title: ch.title, startMs });
}
for (let i = 0; i < chapters.length; i++){
chapters[i].endMs = (i + 1 < chapters.length) ? chapters[i + 1].startMs : totalMs;
}
return { chapters, totalMs };
}

function tagPartMp3(arrayBuffer, { partNumber, totalParts, durationSec, metadata, cover }){
try {
const author = getAuthorString();
const narrator = getNarratorString();
const title = (metadata && metadata.title) || BIF.map.title.main || "Untitled";
const frames = [
textFrame("TIT2", "Part " + partNumber),
textFrame("TALB", title),
textFrame("TPE1", author),
textFrame("TRCK", totalParts ? (partNumber + "/" + totalParts) : String(partNumber)),
textFrame("TCON", "Audiobook"),
textFrame("TSSE", "LibbyRip/LibreGRAB")
];
if (narrator){
frames.push(textFrame("TPE2", narrator));
frames.push(textFrame("TCOM", narrator));
}
if (durationSec) frames.push(textFrame("TLEN", String(Math.round(durationSec * 1000))));
if (cover && cover.bytes && cover.bytes.length) frames.push(apicFrame(cover.bytes, cover.mime));
const chap = chapterFramesForPart(metadata, partNumber - 1, durationSec);
if (chap.warning) console.warn("LibreGRAB: " + chap.warning);
frames.push.apply(frames, chap.frames);
return new Blob([writeId3(arrayBuffer, frames)], { type: "audio/mpeg" });
} catch (e) {
console.warn("LibreGRAB: ID3 tagging failed for part " + partNumber, e);
return new Blob([arrayBuffer], { type: "audio/mpeg" });
}
}

function buildWholeBookId3Tag(metadata, cover){
const author = getAuthorString();
const narrator = getNarratorString();
const title = metadata.title || "Untitled";
const { chapters, totalMs } = absoluteBookChapters(metadata);
const frames = [
textFrame("TIT2", title),
textFrame("TALB", title),
textFrame("TPE1", author),
textFrame("TRCK", "1/1"),
textFrame("TCON", "Audiobook"),
textFrame("TSSE", "LibbyRip/LibreGRAB")
];
if (narrator){
frames.push(textFrame("TPE2", narrator));
frames.push(textFrame("TCOM", narrator));
}
if (totalMs) frames.push(textFrame("TLEN", String(totalMs)));
const desc = metadata.description && (metadata.description.full || metadata.description);
if (desc){
const p = document.createElement("p");
p.innerHTML = typeof desc === "string" ? desc : "";
if (p.textContent) frames.push(commFrame(p.textContent));
}
if (cover && cover.bytes && cover.bytes.length) frames.push(apicFrame(cover.bytes, cover.mime));
if (chapters.length){
const childIds = [];
const chapFrames = [];
chapters.forEach((ch, i) => {
const cid = i === chapters.length - 1 ? "last" : ("ch" + (i + 1));
childIds.push(cid);
chapFrames.push(chapFrame(cid, ch.startMs, ch.endMs, ch.title));
});
frames.push(ctocFrame("toc", childIds, "Table of Contents"));
frames.push.apply(frames, chapFrames);
}
return { tag: buildId3Tag(frames), chapterCount: chapters.length, totalMs };
}

let downloadState = -1;

async function fallbackBlobDownload(files, filename){
logLine("Using fallback download method...<br>");
const zipBlob = await (await getDownloadZip())(files).blob();
logLine("Generated zip file!<br>");
const downloadUrl = URL.createObjectURL(zipBlob);
const link = document.createElement("a");
link.href = downloadUrl;
link.download = filename;
document.body.appendChild(link);
link.click();
link.remove();
setTimeout(() => URL.revokeObjectURL(downloadUrl), 100);
}

async function createAndDownloadSingleMp3(urls, fileHandle){
const metadata = getMetadata();
logLine("Streaming single MP3 (one part in RAM). ffmpeg is not used.<br>");
const cover = await loadCover(metadata);
const { tag, chapterCount, totalMs } = buildWholeBookId3Tag(metadata, cover);
logLine("ID3 tag " + tag.length + " bytes, " + chapterCount + " chapters, " + (totalMs / 3600000).toFixed(2) + " h.<br>");

async function fetchPartAudio(url){
const res = await fetch(url.url);
if (!res.ok) throw new Error("HTTP " + res.status + " for part " + (url.index + 1));
return stripId3(await res.arrayBuffer());
}

const firstRaw = await fetchPartAudio(urls[0]);
const proto = parseMpegHeader(firstRaw, 0);
if (!proto) throw new Error("part " + (urls[0].index + 1) + " did not start with a valid MPEG frame");
const placeholderXing = makeXingFrame(proto, 0, 0);
const writable = await fileHandle.createWritable();
let audioBytes = 0;
let audioFrames = 0;
try {
await writable.write(tag);
await writable.write(placeholderXing);
let pending = Promise.resolve(firstRaw);
for (let i = 0; i < urls.length; i++){
const raw = await pending;
if (i + 1 < urls.length) pending = fetchPartAudio(urls[i + 1]);
const audio = stripXingFrame(raw);
if (!audio.length) throw new Error("part " + (urls[i].index + 1) + " had no MPEG frames after header strip");
const frames = countMpegFrames(audio);
audioFrames += frames;
audioBytes += audio.length;
await writable.write(audio);
logLine("Appended part " + (urls[i].index + 1) + "/" + urls.length + " (" + frames + " frames, " + (audioBytes / 1e6).toFixed(1) + " MB)<br>");
}
const totalFrames = audioFrames + 1;
const totalBytes = audioBytes + placeholderXing.length;
const finalXing = makeXingFrame(proto, totalFrames, totalBytes);
await writable.seek(tag.length);
await writable.write(finalXing);
logLine("Patched Xing: " + totalFrames + " frames, " + totalBytes + " bytes.<br>");
} catch (e) {
try { await writable.close(); } catch (ignore) {}
throw e;
}
await writable.close();
logLine("<b>Done.</b> " + (audioBytes / 1e6).toFixed(1) + " MB audio + ID3 + Xing.<br>");
}

async function exportMP3(){
if (downloadState != -1) return;
if (typeof window.showSaveFilePicker !== "function"){
alert("Export as MP3 streams to disk and needs Chrome or Edge (File System Access API). Use Export audiobook for a zip instead.");
return;
}
let handle;
try {
handle = await window.showSaveFilePicker({
suggestedName: getAuthorString() + " - " + BIF.map.title.main + ".mp3",
types: [{ description: "MP3 audio", accept: { "audio/mpeg": [".mp3"] } }]
});
} catch (e) {
if (e && e.name === "AbortError") return;
alert(e.message);
return;
}
downloadState = 0;
downloadElem.classList.add("active");
downloadElem.innerHTML = "<b>Starting MP3 stream</b><br>";
try {
await createAndDownloadSingleMp3(getUrls(), handle);
} catch (e) {
logLine("<b>ERROR</b> " + e.message + "<br>");
console.error(e);
}
downloadState = -1;
downloadElem.classList.remove("active");
downloadElem.innerHTML = "";
}

async function createAndDownloadZip(urls, addMeta){
const files = [];
const metadata = getMetadata();
const coverPromise = loadCover(metadata);

const fetchPromises = urls.map(async url => {
const response = await fetch(url.url);
if (!response.ok) throw new Error("HTTP " + response.status + " for part " + (url.index + 1));
const buf = await response.arrayBuffer();
const cover = await coverPromise;
const tagged = tagPartMp3(buf, {
partNumber: url.index + 1,
totalParts: urls.length,
durationSec: url.duration,
metadata,
cover
});
const filename = "Part " + paddy(url.index + 1, 3) + ".mp3";
const chap = chapterFramesForPart(metadata, url.index, url.duration);
let partElem = document.createElement("div");
partElem.textContent = "Download of " + filename + " complete" +
(chap.warning ? " (no CHAP: " + chap.warning + ")" :
(chap.count ? " (ID3 + " + chap.count + " chapters)" : " (ID3 tagged)"));
downloadElem.appendChild(partElem);
downloadElem.scrollTo(0, downloadElem.scrollHeight);
downloadState = 1;
return { name: filename, input: tagged };
});

const metadataPromise = addMeta ? createMetadata() : Promise.resolve({ files: [] });
const downloadedFiles = await Promise.all(fetchPromises);
const metaResult = await metadataPromise;
files.push(...downloadedFiles);
files.push(...metaResult.files);

logLine("<br><b>Downloads complete!</b> Starting ZIP generation and download...<br>");
const filename = getAuthorString() + " - " + BIF.map.title.main + ".zip";

if ("showSaveFilePicker" in window){
try {
const handle = await window.showSaveFilePicker({
suggestedName: filename,
types: [{ description: "ZIP Archive", accept: { "application/zip": [".zip"] } }]
});
logLine("Streaming ZIP file to disk...<br>");
const writable = await handle.createWritable();
const zipStream = (await getDownloadZip())(files).body;
await zipStream.pipeTo(writable);
logLine("Download complete!<br>");
} catch (err) {
if (err.name === "AbortError") logLine("Download cancelled by user.<br>");
else {
console.error("Streaming download failed", err);
logLine("Streaming failed, using fallback...<br>");
await fallbackBlobDownload(files, filename);
}
}
} else {
await fallbackBlobDownload(files, filename);
}

downloadState = -1;
downloadElem.innerHTML = "";
downloadElem.classList.remove("active");
}

function exportChapters(){
if (downloadState != -1) return;
downloadState = 0;
downloadElem.classList.add("active");
downloadElem.innerHTML = "<b>Starting export</b><br>";
createAndDownloadZip(getUrls(), true).then(() => {});
}

function bifFoundAudiobook(){
let s = document.createElement("style");
s.innerHTML = CSS;
document.head.appendChild(s);
if (odreadCmptParams == null){
alert("odreadCmptParams not set, so cannot resolve book urls! Please try refreshing.");
return;
}
buildPirateUi();
}

/* =========================================
END AUDIOBOOK SECTION!
BEGIN BOOK SECTION!
========================================= */

const bookNav = `
<div style="text-align: center; width: 100%">
<a class="pLink" id="download"><h1>Download EPUB</h1></a>
</div>
`;
const pages = window.pages = window.pages || {};

const originalBind = Function.prototype.bind;
Function.prototype.bind = function(...args){
const boundFn = originalBind.apply(this, args);
boundFn.boundArgs = args.slice(1);
boundFn.originalFunction = this;
if (this.toString().includes("decryption") || args.some(arg => typeof arg === "function" && arg.toString().includes("decryption"))){
console.log("Decryption function detected", this);
window.__libregrab_decryption_fn = args.find(arg => typeof arg === "function");
}
return boundFn;
};

async function waitForChapters(callback){
let components = getBookComponents();
components.forEach(page => {
if (undefined != window.pages[page.id]) return;
page.loadContent(callback);
});
while (components.filter(page => undefined == window.pages[page.id]).length){
await new Promise(r => setTimeout(r, 100));
callback();
}
}

function getBookComponents(){
return BIF.objects.reader._.context.spine._.components.filter(p => !p.hidden && !(p.block && p.block.behavior));
}

function truncate(path){
return path.substring(path.lastIndexOf("/") + 1);
}

function getFilenameFromURL(url){
const parsedUrl = new URL(url);
const pathname = parsedUrl.pathname;
return pathname.substring(pathname.lastIndexOf("/") + 1);
}

async function createContent(files, imgAssests){
let cssRegistry = {};
let components = getBookComponents();
let totComp = components.length;
downloadElem.innerHTML = "Gathering chapters <span id='chapAcc'>0/" + totComp + "</span><br>";
downloadElem.scrollTo(0, downloadElem.scrollHeight);
await waitForChapters(() => {
downloadElem.querySelector("span#chapAcc").innerHTML = components.filter(page => undefined != window.pages[page.id]).length + "/" + totComp;
});
logLine("Chapter gathering complete<br>");

let idToIfram = {};
let idToMetaId = {};
components.forEach(c => {
if (c.sheetBox.querySelector("iframe") == null){
console.warn("!!!", window.pages[c.id]);
return;
}
c.meta.id = c.meta.id || crypto.randomUUID();
idToMetaId[c.id] = c.meta.id;
idToIfram[c.id] = c.sheetBox.querySelector("iframe");
c.sheetBox.querySelector("iframe").contentWindow.document.querySelectorAll("link").forEach(link => {
cssRegistry[c.id] = cssRegistry[c.id] || [];
cssRegistry[c.id].push(link.href);
if (imgAssests.includes(link.href)) return;
imgAssests.push(link.href);
});
});

let url = location.origin;
for (let i of Object.keys(window.pages)){
if (idToIfram[i]) url = idToIfram[i].src;
files.push({
name: "OEBPS/" + truncate(i),
input: fixXhtml(idToMetaId[i], url, window.pages[i], imgAssests, cssRegistry[i] || [])
});
}

logLine("Downloading assets <span id='assetGath'>0/" + imgAssests.length + "</span><br>");
let gc = 0;
await Promise.all(imgAssests.map(async function(name){
const response = await fetch(name.startsWith("http") ? name : location.origin + "/" + name);
if (response.status != 200){
logLine("<b>WARNING</b> Could not fetch " + name + "<br>");
return;
}
const blob = await response.blob();
files.push({
name: "OEBPS/" + (name.startsWith("http") ? getFilenameFromURL(name) : name),
input: blob
});
gc++;
downloadElem.querySelector("span#assetGath").innerHTML = gc + "/" + imgAssests.length;
}));
}

function enforceEpubXHTML(metaId, url, htmlString, assetRegistry, links){
const parser = new DOMParser();
const doc = parser.parseFromString(htmlString, "text/html");
const bod = doc.querySelector("body");
if (bod) bod.setAttribute("id", metaId);

const elements = doc.getElementsByTagName("*");
for (let el of Array.from(elements)){
const newElement = doc.createElement(el.tagName.toLowerCase());
for (let attr of el.attributes) newElement.setAttribute(attr.name, attr.value);
while (el.firstChild) newElement.appendChild(el.firstChild);
el.parentNode.replaceChild(newElement, el);
}

for (let el of Array.from(doc.getElementsByTagName("*"))){
if (el.tagName.toLowerCase() == "img" || el.tagName.toLowerCase() == "image"){
let src = el.getAttribute("src") || el.getAttribute("xlink:href");
if (!src) continue;
if (!src.startsWith("http") && !src.startsWith("https"))
src = new URL(src, new URL(url)).toString();
if (!assetRegistry.includes(src)) assetRegistry.push(src);
if (el.getAttribute("src")) el.setAttribute("src", truncate(src));
if (el.getAttribute("xlink:href")) el.setAttribute("xlink:href", truncate(src));
}
}

let head = doc.querySelector("head");
if (!head){
head = doc.createElement("head");
doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
}
let title = head.querySelector("title");
if (!title){
title = doc.createElement("title");
title.textContent = BIF.map.title.main;
head.appendChild(title);
}
for (let link of (links || [])){
let src = link;
if (!src.startsWith("http") && !src.startsWith("https"))
src = new URL(src, new URL(url)).toString();
let linkElement = doc.createElement("link");
linkElement.setAttribute("href", truncate(src));
linkElement.setAttribute("rel", "stylesheet");
linkElement.setAttribute("type", "text/css");
head.appendChild(linkElement);
}

const serializer = new XMLSerializer();
let xhtmlString = serializer.serializeToString(doc);
if (!xhtmlString.includes('xmlns="http://www.w3.org/1999/xhtml"')){
xhtmlString = xhtmlString.replace("<html", '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:m="http://www.w3.org/1998/Math/MathML" xmlns:pls="http://www.w3.org/2005/01/pronunciation-lexicon" xmlns:ssml="http://www.w3.org/2001/10/synthesis" xmlns:svg="http://www.w3.org/2000/svg"');
}
return xhtmlString;
}

function fixXhtml(metaId, url, html, assetRegistry, links){
return '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
enforceEpubXHTML(
metaId, url,
'<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:m="http://www.w3.org/1998/Math/MathML" xmlns:pls="http://www.w3.org/2005/01/pronunciation-lexicon" xmlns:ssml="http://www.w3.org/2001/10/synthesis" xmlns:svg="http://www.w3.org/2000/svg">' + html + "</html>",
assetRegistry, links
);
}

function getMimeTypeFromFileName(fileName){
const mimeTypes = {
jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
bmp: "image/bmp", webp: "image/webp", mp4: "video/mp4", mp3: "audio/mp3",
pdf: "application/pdf", txt: "text/plain", html: "text/html", css: "text/css",
json: "application/json"
};
const ext = fileName.split(".").pop().toLowerCase();
return mimeTypes[ext] || "application/octet-stream";
}

function makePackage(files, assetRegistry){
const idStore = [];
const doc = document.implementation.createDocument("http://www.idpf.org/2007/opf", "package", null);
const packageElement = doc.documentElement;
packageElement.setAttribute("version", "2.0");
packageElement.setAttribute("xml:lang", "en");
packageElement.setAttribute("unique-identifier", "pub-identifier");
packageElement.setAttribute("xmlns", "http://www.idpf.org/2007/opf");
packageElement.setAttribute("xmlns:dc", "http://purl.org/dc/elements/1.1/");
packageElement.setAttribute("xmlns:dcterms", "http://purl.org/dc/terms/");
packageElement.setAttribute("xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance");

const metadata = doc.createElementNS("http://www.idpf.org/2007/opf", "metadata");
packageElement.appendChild(metadata);

const dcIdentifier = doc.createElementNS("http://purl.org/dc/elements/1.1/", "dc:identifier");
dcIdentifier.setAttribute("id", "pub-identifier");
dcIdentifier.textContent = BIF.map["-odread-buid"];
metadata.appendChild(dcIdentifier);

if (BIF.map.language && BIF.map.language.length){
const dcLanguage = doc.createElementNS("http://purl.org/dc/elements/1.1/", "dc:language");
dcLanguage.setAttribute("xsi:type", "dcterms:RFC4646");
dcLanguage.textContent = BIF.map.language[0];
packageElement.setAttribute("xml:lang", BIF.map.language[0]);
metadata.appendChild(dcLanguage);
}

const metaIdentifier = doc.createElementNS("http://www.idpf.org/2007/opf", "meta");
metaIdentifier.setAttribute("id", "meta-identifier");
metaIdentifier.setAttribute("property", "dcterms:identifier");
metaIdentifier.textContent = BIF.map["-odread-buid"];
metadata.appendChild(metaIdentifier);

const dcTitle = doc.createElementNS("http://purl.org/dc/elements/1.1/", "dc:title");
dcTitle.setAttribute("id", "pub-title");
dcTitle.textContent = BIF.map.title.main;
metadata.appendChild(dcTitle);

if (BIF.map.creator && BIF.map.creator.length){
const dcCreator = doc.createElementNS("http://purl.org/dc/elements/1.1/", "dc:creator");
dcCreator.textContent = BIF.map.creator[0].name;
metadata.appendChild(dcCreator);
}

if (BIF.map.description){
let p = document.createElement("p");
p.innerHTML = BIF.map.description.full || BIF.map.description;
const dcDescription = doc.createElementNS("http://purl.org/dc/elements/1.1/", "dc:description");
dcDescription.textContent = p.textContent;
metadata.appendChild(dcDescription);
}

const manifest = doc.createElementNS("http://www.idpf.org/2007/opf", "manifest");
packageElement.appendChild(manifest);
const spine = doc.createElementNS("http://www.idpf.org/2007/opf", "spine");
spine.setAttribute("toc", "ncx");
packageElement.appendChild(spine);

const ncxItem = doc.createElementNS("http://www.idpf.org/2007/opf", "item");
ncxItem.setAttribute("id", "ncx");
ncxItem.setAttribute("href", "toc.ncx");
ncxItem.setAttribute("media-type", "application/x-dtbncx+xml");
manifest.appendChild(ncxItem);

let components = getBookComponents();
components.forEach(chapter => {
const item = doc.createElementNS("http://www.idpf.org/2007/opf", "item");
let id = chapter.meta.id || crypto.randomUUID();
while (idStore.includes(id)) id = id + "-" + crypto.randomUUID();
item.setAttribute("id", id);
idStore.push(id);
item.setAttribute("href", truncate(chapter.meta.path));
item.setAttribute("media-type", "application/xhtml+xml");
manifest.appendChild(item);
const itemref = doc.createElementNS("http://www.idpf.org/2007/opf", "itemref");
itemref.setAttribute("idref", id);
itemref.setAttribute("linear", "yes");
spine.appendChild(itemref);
});

assetRegistry.forEach(asset => {
const item = doc.createElementNS("http://www.idpf.org/2007/opf", "item");
let aname = asset.startsWith("http") ? getFilenameFromURL(asset) : asset;
let id = aname.split(".")[0];
while (idStore.includes(id)) id = id + "-" + crypto.randomUUID();
item.setAttribute("id", id);
idStore.push(id);
item.setAttribute("href", aname);
item.setAttribute("media-type", getMimeTypeFromFileName(aname));
manifest.appendChild(item);
});

const serializer = new XMLSerializer();
files.push({
name: "OEBPS/content.opf",
input: '<?xml version="1.0" encoding="utf-8" standalone="no"?>' + serializer.serializeToString(doc)
});
}

function makeToc(files){
const doc = document.implementation.createDocument("http://www.daisy.org/z3986/2005/ncx/", "ncx", null);
const ncxElement = doc.documentElement;
ncxElement.setAttribute("version", "2005-1");
const head = doc.createElementNS("http://www.daisy.org/z3986/2005/ncx/", "head");
ncxElement.appendChild(head);
const uidMeta = doc.createElementNS("http://www.daisy.org/z3986/2005/ncx/", "meta");
uidMeta.setAttribute("name", "dtb:uid");
uidMeta.setAttribute("content", BIF.map["-odread-buid"]);
head.appendChild(uidMeta);
const docTitle = doc.createElementNS("http://www.daisy.org/z3986/2005/ncx/", "docTitle");
ncxElement.appendChild(docTitle);
const textElement = doc.createElementNS("http://www.daisy.org/z3986/2005/ncx/", "text");
textElement.textContent = BIF.map.title.main;
docTitle.appendChild(textElement);
const navMap = doc.createElementNS("http://www.daisy.org/z3986/2005/ncx/", "navMap");
ncxElement.appendChild(navMap);
getBookComponents().forEach(chapter => {
const navPoint1 = doc.createElementNS("http://www.daisy.org/z3986/2005/ncx/", "navPoint");
navPoint1.setAttribute("id", chapter.meta.id);
navPoint1.setAttribute("playOrder", 1 + chapter.index);
navMap.appendChild(navPoint1);
const navLabel1 = doc.createElementNS("http://www.daisy.org/z3986/2005/ncx/", "navLabel");
navPoint1.appendChild(navLabel1);
const text1 = doc.createElementNS("http://www.daisy.org/z3986/2005/ncx/", "text");
text1.textContent = BIF.map.title.main;
navLabel1.appendChild(text1);
const content1 = doc.createElementNS("http://www.daisy.org/z3986/2005/ncx/", "content");
content1.setAttribute("src", truncate(chapter.meta.path));
navPoint1.appendChild(content1);
});
const serializer = new XMLSerializer();
files.push({
name: "OEBPS/toc.ncx",
input: '<?xml version="1.0" encoding="utf-8" standalone="no"?>' + serializer.serializeToString(doc)
});
}

async function downloadEPUB(){
let imageAssets = [];
const files = [];
files.push({ name: "mimetype", input: "application/epub+zip" });
files.push({
name: "META-INF/container.xml",
input: '<?xml version="1.0" encoding="UTF-8"?>' +
'<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
'<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
});
files.push({
name: "META-INF/encryption.xml",
input: '<?xml version="1.0" encoding="UTF-8"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"></encryption>'
});
await createContent(files, imageAssets);
makePackage(files, imageAssets);
makeToc(files);

logLine("<br><b>Downloads complete!</b> Starting EPUB generation and download...<br>");
const filename = BIF.map.title.main + ".epub";

if ("showSaveFilePicker" in window){
try {
const handle = await window.showSaveFilePicker({
suggestedName: filename,
types: [{ description: "EPUB eBook", accept: { "application/epub+zip": [".epub"] } }]
});
logLine("Streaming EPUB file to disk...<br>");
const writable = await handle.createWritable();
const zipStream = (await getDownloadZip())(files).body;
await zipStream.pipeTo(writable);
logLine("Download complete!<br>");
} catch (err) {
if (err.name === "AbortError") logLine("Download cancelled by user.<br>");
else {
console.error("Streaming download failed", err);
logLine("Streaming failed, using fallback...<br>");
await fallbackBlobDownload(files, filename);
}
}
} else {
await fallbackBlobDownload(files, filename);
}
downloadState = -1;
}

function bifFoundBook(){
let s = document.createElement("style");
s.innerHTML = CSS;
document.head.appendChild(s);
if (!window.bif || !window.bif.cfc || !window.bif.cfc[1]){
alert("Injection failed! bif.cfc[1] not found");
return;
}
const oldcrf1 = window.bif.cfc[1];
window.bif.cfc[1] = function(win, edata){
if (oldcrf1.boundArgs && oldcrf1.boundArgs[0]){
pages[win.name] = oldcrf1.boundArgs[0](edata);
} else if (window.__libregrab_decryption_fn){
try { pages[win.name] = window.__libregrab_decryption_fn(edata); }
catch (error) { console.error("Global decryption function failed", error); }
} else {
try { pages[win.name] = oldcrf1(win, edata); }
catch (error) {
console.error("Failed to decrypt content", error);
pages[win.name] = edata;
}
}
return oldcrf1(win, edata);
};
buildBookPirateUi();
}

function downloadEPUBBBtn(){
if (downloadState != -1) return;
downloadState = 0;
downloadElem.classList.add("active");
downloadElem.innerHTML = "<b>Starting download</b><br>";
downloadEPUB().then(() => {});
}

function buildBookPirateUi(){
let nav = document.createElement("div");
nav.innerHTML = bookNav;
nav.querySelector("#download").onclick = downloadEPUBBBtn;
nav.classList.add("pNav");
let pbar = document.querySelector(".nav-progress-bar");
pbar.insertBefore(nav, pbar.children[1]);
downloadElem = document.createElement("div");
downloadElem.classList.add("foldMenu");
downloadElem.setAttribute("tabindex", "-1");
document.body.appendChild(downloadElem);
}

let intr = setInterval(() => {
if (window.BIF != undefined && document.querySelector(".nav-progress-bar") != undefined){
clearInterval(intr);
BIF = window.BIF;
let mode = location.hostname.split(".")[1];
if (mode == "listen") bifFoundAudiobook();
else if (mode == "read") bifFoundBook();
}
}, 25);

}
function injectPageScript(code){
const script = document.createElement("script");
script.textContent = code;
(document.documentElement || document.head || document.body).appendChild(script);
script.remove();
}
injectPageScript(clientZipReadyCode + "(" + mainCode.toString() + ")();");
fetch("https://unpkg.com/client-zip@2.5.0/worker.js")
.then(r => r.text())
.then(clientZipCode => {
injectPageScript(clientZipCode);
injectPageScript("window.__libregrabResolveClientZip?.(window.downloadZip)");
})
.catch(error => {
console.error("LibreGRAB failed to load client-zip", error);
injectPageScript("window.__libregrabRejectClientZip?.(new Error('client-zip failed to load'))");
});
})();
