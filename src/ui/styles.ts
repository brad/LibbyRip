export const CSS = `
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

export const audioBookNav = `
    <a class="pLink" id="chap"> <h1> View chapters </h1> </a>
    <a class="pLink" id="down"> <h1> Export as MP3 </h1> </a>
    <a class="pLink" id="exp"> <h1> Export audiobook </h1> </a>
`;

export const chaptersMenu = `
    <h2>This book contains {CHAPTERS} chapters.</h2>
    <button class="shibui-button" style="background-color: white" id="dumpAll"> Download all </button><br>
`;