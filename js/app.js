import { dbGetAll, dbPut, dbDelete, dbDeleteRange, dbClear, bookRange, getSetting, setSetting } from "./db.js";
import { parseEpub } from "./epub.js";
import { fetchSpeakers, fetchPoints } from "./tts.js";
import { Player } from "./player.js";

const $ = s => document.querySelector(s);
const CHARS_PER_SEC = 6;

const state = {
  apiKey: "",
  speaker: 3,
  rate: 1.0,
  book: null,
  chapters: [],
  cum: [],
  chapterChars: 0,
  coverUrls: new Map(),
  seeking: false,
  speakersLoaded: false,
  readCh: 0,
  readCk: 0,
  readEls: [],
  scrollTick: false,
  readSaveTimer: null
};

const player = new Player($("#audio"), {
  onChunk: handleChunk,
  onPlayState: handlePlayState,
  onError: handleError,
  onBookEnd: () => toast("最後まで再生しました")
});

function toast(msg, sticky) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  if (!sticky) el._t = setTimeout(() => { el.hidden = true; }, 4000);
}

function busy(msg) {
  $("#busyMsg").textContent = msg || "";
  $("#busy").hidden = !msg;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0")
    : m + ":" + String(s).padStart(2, "0");
}

function coverUrl(book) {
  if (!book.coverBlob) return null;
  if (!state.coverUrls.has(book.id)) {
    state.coverUrls.set(book.id, URL.createObjectURL(book.coverBlob));
  }
  return state.coverUrls.get(book.id);
}

function bookProgress(book) {
  if (!book.position || !book.totalChunks) return 0;
  let done = 0;
  for (let i = 0; i < book.position.chapter; i++) done += book.chapterChunkCounts[i] || 0;
  done += book.position.chunk;
  return Math.round(done / book.totalChunks * 100);
}

async function renderLibrary() {
  const books = await dbGetAll("books");
  books.sort((a, b) => (b.updatedAt || b.addedAt) - (a.updatedAt || a.addedAt));
  const grid = $("#bookGrid");
  grid.innerHTML = "";
  for (const book of books) {
    const card = document.createElement("div");
    card.className = "card";
    const url = coverUrl(book);
    const pct = bookProgress(book);
    card.innerHTML =
      (url ? '<img class="cover" alt="">' : '<div class="cover ph"></div>') +
      '<div class="prog"><div class="progfill"></div></div>' +
      '<div class="btitle"></div><div class="bmeta"></div>' +
      '<button class="delbtn" aria-label="削除">×</button>';
    if (url) card.querySelector(".cover").src = url;
    else card.querySelector(".cover").textContent = book.title;
    card.querySelector(".progfill").style.width = pct + "%";
    card.querySelector(".btitle").textContent = book.title;
    card.querySelector(".bmeta").textContent = pct > 0 ? pct + "%・" + book.author : book.author || "未再生";
    card.querySelector(".delbtn").addEventListener("click", e => {
      e.stopPropagation();
      deleteBook(book);
    });
    card.addEventListener("click", () => openBook(book));
    grid.appendChild(card);
  }
  $("#emptyHint").hidden = books.length > 0;
}

async function deleteBook(book) {
  if (!confirm("「" + book.title + "」を削除しますか？（音声キャッシュも削除されます）")) return;
  if (state.book && state.book.id === book.id) {
    player.pause();
    state.book = null;
  }
  await dbDelete("books", book.id);
  await dbDeleteRange("chapters", bookRange(book.id));
  await dbDeleteRange("audio", bookRange(book.id));
  await dbDeleteRange("bookmarks", bookRange(book.id));
  renderLibrary();
}

async function importEpub(file) {
  try {
    busy("EPUBを読み込み中…");
    const parsed = await parseEpub(file, busy);
    const book = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: parsed.title,
      author: parsed.author,
      coverBlob: parsed.coverBlob,
      chapterTitles: parsed.chapters.map(c => c.title),
      chapterChunkCounts: parsed.chapters.map(c => c.chunks.length),
      totalChunks: parsed.chapters.reduce((n, c) => n + c.chunks.length, 0),
      position: { chapter: parsed.startChapter || 0, chunk: 0 },
      addedAt: Date.now(),
      updatedAt: Date.now()
    };
    busy("保存中…");
    await dbPut("books", book);
    for (let i = 0; i < parsed.chapters.length; i++) {
      await dbPut("chapters", { bookId: book.id, index: i, title: parsed.chapters[i].title, chunks: parsed.chapters[i].chunks });
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    busy(null);
    toast("「" + book.title + "」を追加しました（全" + book.totalChunks + "文）");
    renderLibrary();
  } catch (e) {
    busy(null);
    toast("取り込み失敗: " + e.message, true);
  }
}

async function openBook(book) {
  if (!state.apiKey) {
    openSettings();
    toast("先にAPIキーを設定してください");
    return;
  }
  if (!state.book || state.book.id !== book.id) {
    if (player.playing) player.pause();
    busy("読み込み中…");
    const chapters = await dbGetAll("chapters", bookRange(book.id));
    chapters.sort((a, b) => a.index - b.index);
    busy(null);
    state.book = book;
    state.chapters = chapters;
    player.setBook(book, chapters);
    renderChapterSheet();
    setupMediaSession();
  }
  $("#pBookTitle").textContent = book.title;
  const url = coverUrl(book);
  const coverEl = $("#pCover");
  coverEl.innerHTML = url ? '<img src="' + url + '" alt="">' : '<div class="ph">' + escapeHtml(book.title) + "</div>";
  handleChunk(player.ch, player.ck);
  handlePlayState(player.playing, false);
  showView("player");
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function showView(name) {
  $("#libraryView").hidden = name !== "library";
  $("#playerView").hidden = name !== "player";
  $("#readerView").hidden = name !== "reader";
  window.scrollTo(0, 0);
  if (name === "library") renderLibrary();
}

function renderReader(ch) {
  state.readCh = ch;
  const chapter = state.chapters[ch];
  $("#rChapterTitle").textContent = chapter.title;
  const cont = $("#readerText");
  cont.innerHTML = "";
  state.readEls = [];
  chapter.chunks.forEach((text, i) => {
    const p = document.createElement("p");
    p.className = "rp";
    p.textContent = text;
    p.addEventListener("click", () => setReadPos(i));
    cont.appendChild(p);
    state.readEls.push(p);
  });
  $("#rPrevChap").hidden = ch === 0;
  $("#rNextChap").hidden = ch >= state.chapters.length - 1;
}

function setReadPos(ck) {
  state.readCk = ck;
  const cur = $("#readerText .rcur");
  if (cur) cur.classList.remove("rcur");
  const el = state.readEls[ck];
  if (el) el.classList.add("rcur");
  clearTimeout(state.readSaveTimer);
  state.readSaveTimer = setTimeout(() => {
    if (!state.book) return;
    state.book.position = { chapter: state.readCh, chunk: state.readCk };
    state.book.updatedAt = Date.now();
    dbPut("books", state.book).catch(() => {});
  }, 800);
}

function onReaderScroll() {
  if ($("#readerView").hidden || !state.readEls.length) return;
  if (state.scrollTick) return;
  state.scrollTick = true;
  requestAnimationFrame(() => {
    state.scrollTick = false;
    const line = window.scrollY + window.innerHeight * 0.35;
    const els = state.readEls;
    let lo = 0, hi = els.length - 1, idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (els[mid].offsetTop <= line) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (idx !== state.readCk) setReadPos(idx);
  });
}

function enterReader() {
  if (!state.chapters.length) return;
  if (player.playing) player.pause();
  renderReader(player.ch);
  showView("reader");
  state.readCk = player.ck;
  requestAnimationFrame(() => {
    const el = state.readEls[state.readCk];
    if (el) el.scrollIntoView({ block: "center" });
    setReadPos(state.readCk);
  });
}

function computeCum(ch) {
  const chunks = state.chapters[ch].chunks;
  const cum = [0];
  for (let i = 0; i < chunks.length; i++) cum.push(cum[i] + chunks[i].length);
  state.cum = cum;
  state.chapterChars = cum[chunks.length];
}

function handleChunk(ch, ck) {
  if (!state.chapters.length) return;
  const chapter = state.chapters[ch];
  $("#pChapterTitle").textContent = chapter.title;
  $("#pChunkText").textContent = chapter.chunks[ck];
  computeCum(ch);
  const seek = $("#seek");
  seek.max = chapter.chunks.length - 1;
  if (!state.seeking) seek.value = ck;
  updateTimes(ch, ck);
  highlightChapter(ch);
  if ("mediaSession" in navigator && navigator.mediaSession.metadata) {
    navigator.mediaSession.metadata.artist = chapter.title;
  }
}

function updateTimes(ch, ck) {
  $("#tCur").textContent = fmtTime(state.cum[ck] / CHARS_PER_SEC / state.rate);
  $("#tTotal").textContent = fmtTime(state.chapterChars / CHARS_PER_SEC / state.rate);
}

function handlePlayState(playing, loading) {
  const btn = $("#playBtn");
  btn.textContent = loading ? "…" : playing ? "⏸︎" : "▶︎";
}

function handleError(e) {
  if (e.name === "NotAllowedError") {
    toast("もう一度再生ボタンを押してください");
  } else if (e.code === "points") {
    toast("本日の合成上限に達しました。キャッシュ済みの範囲は再生できます。ポイントは24時間以内に回復します。", true);
  } else if (e.code === "key") {
    toast("APIキーが無効です。設定を確認してください。", true);
    openSettings();
  } else {
    toast("エラー: " + e.message);
  }
}

function renderChapterSheet() {
  const list = $("#chapterList");
  list.innerHTML = "";
  state.chapters.forEach((c, i) => {
    const chars = c.chunks.reduce((n, s) => n + s.length, 0);
    const row = document.createElement("button");
    row.className = "chrow";
    row.innerHTML = '<span class="chname"></span><span class="chtime"></span>';
    row.querySelector(".chname").textContent = c.title;
    row.querySelector(".chtime").textContent = "約" + fmtTime(chars / CHARS_PER_SEC);
    row.addEventListener("click", () => {
      $("#chapterSheet").hidden = true;
      if (player.playing) player.playAt(i, 0);
      else { player.setPosition(i, 0); handleChunk(i, 0); }
    });
    list.appendChild(row);
  });
}

function highlightChapter(ch) {
  $("#chapterList").querySelectorAll(".chrow").forEach((el, i) => {
    el.classList.toggle("current", i === ch);
  });
}

function setupMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const art = [];
  if (state.book.coverBlob) {
    art.push({ src: coverUrl(state.book), sizes: "512x512", type: state.book.coverBlob.type || "image/jpeg" });
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.book.title,
    artist: state.chapters[player.ch] ? state.chapters[player.ch].title : "",
    album: state.book.author,
    artwork: art
  });
  navigator.mediaSession.setActionHandler("play", () => player.resume());
  navigator.mediaSession.setActionHandler("pause", () => player.pause());
  navigator.mediaSession.setActionHandler("nexttrack", () => player.advance(1));
  navigator.mediaSession.setActionHandler("previoustrack", () => player.advance(-1));
}

function updateRateBtn() {
  $("#rateBtn").textContent = state.rate.toFixed(1) + "x";
}

function applyRate(rate) {
  state.rate = Math.round(rate * 10) / 10;
  player.setRate(state.rate);
  updateRateBtn();
  $("#rateVal").textContent = state.rate.toFixed(1) + "x";
  $("#rateSlider").value = state.rate;
  if (state.chapters.length) updateTimes(player.ch, player.ck);
  setSetting("rate", state.rate);
}

async function renderBookmarks() {
  const marks = await dbGetAll("bookmarks", bookRange(state.book.id));
  marks.sort((a, b) => b.createdAt - a.createdAt);
  const list = $("#bmList");
  list.innerHTML = "";
  $("#bmEmpty").hidden = marks.length > 0;
  for (const m of marks) {
    const row = document.createElement("div");
    row.className = "bmrow";
    row.innerHTML = '<button class="bmmain"><div class="bmch"></div><div class="bmsnip"></div></button>' +
      '<span class="bmdate"></span><button class="bmdel" aria-label="しおりを削除">×</button>';
    row.querySelector(".bmch").textContent = m.chapterTitle;
    row.querySelector(".bmsnip").textContent = m.snippet;
    row.querySelector(".bmdate").textContent = new Date(m.createdAt)
      .toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    row.querySelector(".bmmain").addEventListener("click", () => {
      $("#bmSheet").hidden = true;
      const ch = Math.min(m.chapter, state.chapters.length - 1);
      const ck = Math.min(m.chunk, state.chapters[ch].chunks.length - 1);
      if (player.playing) player.playAt(ch, ck);
      else { player.setPosition(ch, ck); handleChunk(ch, ck); }
    });
    row.querySelector(".bmdel").addEventListener("click", async () => {
      await dbDelete("bookmarks", [m.bookId, m.createdAt]);
      renderBookmarks();
    });
    list.appendChild(row);
  }
}

async function addBookmark() {
  const chapter = state.chapters[player.ch];
  await dbPut("bookmarks", {
    bookId: state.book.id,
    createdAt: Date.now(),
    chapter: player.ch,
    chunk: player.ck,
    chapterTitle: chapter.title,
    snippet: chapter.chunks[player.ck].slice(0, 60)
  });
  renderBookmarks();
}

async function openSettings() {
  $("#settingsSheet").hidden = false;
  $("#keyInput").value = state.apiKey;
  refreshSettingsInfo();
}

async function refreshSettingsInfo() {
  if (!state.apiKey) return;
  if (!state.speakersLoaded) {
    try {
      const speakers = await fetchSpeakers(state.apiKey);
      const sel = $("#speakerSel");
      sel.innerHTML = "";
      for (const sp of speakers) {
        for (const st of sp.styles) {
          const opt = document.createElement("option");
          opt.value = st.id;
          opt.textContent = sp.name + "（" + st.name + "）";
          sel.appendChild(opt);
        }
      }
      sel.value = String(state.speaker);
      if (!sel.value) sel.selectedIndex = 0;
      state.speakersLoaded = true;
    } catch (e) {
      $("#pointsInfo").textContent = "話者一覧の取得に失敗しました";
    }
  }
  try {
    const p = await fetchPoints(state.apiKey);
    $("#pointsInfo").textContent = "残り " + p.points.toLocaleString() + " pt（新規合成 約" +
      Math.round(p.points / 36000) + "分ぶん・" + Math.round(p.resetInHours) + "時間後に回復）";
  } catch (e) {
    $("#pointsInfo").textContent = "ポイント情報を取得できませんでした";
  }
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    $("#cacheInfo").textContent = "ストレージ使用量: 約" + Math.round((est.usage || 0) / 1048576) + "MB";
  }
}

function wireEvents() {
  $("#fileInput").addEventListener("change", e => {
    const f = e.target.files[0];
    if (f) importEpub(f);
    e.target.value = "";
  });

  $("#backBtn").addEventListener("click", () => showView("library"));
  $("#playBtn").addEventListener("click", () => player.toggle());
  $("#nextBtn").addEventListener("click", () => player.advance(1));
  $("#prevBtn").addEventListener("click", () => player.advance(-1));
  $("#nextChapBtn").addEventListener("click", () => jumpChapter(1));
  $("#prevChapBtn").addEventListener("click", () => jumpChapter(-1));
  $("#tocBtn").addEventListener("click", () => { $("#chapterSheet").hidden = false; highlightChapter(player.ch); });
  $("#chapterClose").addEventListener("click", () => { $("#chapterSheet").hidden = true; });

  $("#rateBtn").addEventListener("click", () => {
    $("#rateVal").textContent = state.rate.toFixed(1) + "x";
    $("#rateSlider").value = state.rate;
    $("#rateSheet").hidden = false;
  });
  $("#rateClose").addEventListener("click", () => { $("#rateSheet").hidden = true; });
  $("#rateSlider").addEventListener("input", () => applyRate(Number($("#rateSlider").value)));
  document.querySelectorAll(".presets button").forEach(btn => {
    btn.addEventListener("click", () => applyRate(Number(btn.dataset.rate)));
  });

  $("#bmAddQuickBtn").addEventListener("click", async () => {
    if (!state.book) return;
    await addBookmark();
    const c = state.chapters[player.ch];
    toast("しおりを挟みました: " + c.title + "「" + c.chunks[player.ck].slice(0, 15) + "…」");
  });
  $("#bmListBtn").addEventListener("click", () => {
    $("#bmSheet").hidden = false;
    renderBookmarks();
  });
  $("#bmClose").addEventListener("click", () => { $("#bmSheet").hidden = true; });

  const seek = $("#seek");
  seek.addEventListener("input", () => {
    state.seeking = true;
    const ck = Number(seek.value);
    $("#pChunkText").textContent = state.chapters[player.ch].chunks[ck];
    updateTimes(player.ch, ck);
  });
  seek.addEventListener("change", () => {
    state.seeking = false;
    const ck = Number(seek.value);
    if (player.playing) player.playAt(player.ch, ck);
    else { player.setPosition(player.ch, ck); handleChunk(player.ch, ck); }
  });

  $("#readModeBtn").addEventListener("click", enterReader);
  $("#readerBackBtn").addEventListener("click", () => {
    player.setPosition(state.readCh, state.readCk);
    showView("player");
  });
  $("#readerPlayBtn").addEventListener("click", () => {
    showView("player");
    player.playAt(state.readCh, state.readCk);
  });
  $("#rPrevChap").addEventListener("click", () => {
    renderReader(state.readCh - 1);
    window.scrollTo(0, 0);
    setReadPos(0);
  });
  $("#rNextChap").addEventListener("click", () => {
    renderReader(state.readCh + 1);
    window.scrollTo(0, 0);
    setReadPos(0);
  });
  window.addEventListener("scroll", onReaderScroll, { passive: true });

  $("#settingsBtn").addEventListener("click", openSettings);
  $("#pSettingsBtn").addEventListener("click", openSettings);
  $("#settingsClose").addEventListener("click", () => { $("#settingsSheet").hidden = true; });

  $("#keyInput").addEventListener("change", () => {
    state.apiKey = $("#keyInput").value.trim();
    player.apiKey = state.apiKey;
    state.speakersLoaded = false;
    setSetting("apiKey", state.apiKey);
    refreshSettingsInfo();
  });

  $("#speakerSel").addEventListener("change", () => {
    state.speaker = Number($("#speakerSel").value);
    player.speaker = state.speaker;
    setSetting("speaker", state.speaker);
    toast("話者を変更しました。以降の合成に適用されます");
  });

  $("#cacheClearBtn").addEventListener("click", async () => {
    if (!confirm("合成済み音声のキャッシュをすべて削除しますか？（再生時に再合成され、ポイントを消費します）")) return;
    await dbClear("audio");
    toast("キャッシュを削除しました");
    refreshSettingsInfo();
  });

  $("#toast").addEventListener("click", () => { $("#toast").hidden = true; });
}

async function init() {
  const urlKey = new URLSearchParams(location.search).get("key");
  if (urlKey) {
    await setSetting("apiKey", urlKey);
    history.replaceState(null, "", location.pathname);
  }
  state.apiKey = await getSetting("apiKey", "") || localStorage.getItem("voicevoxKey") || "";
  if (state.apiKey) setSetting("apiKey", state.apiKey);
  state.speaker = await getSetting("speaker", 3);
  state.rate = await getSetting("rate", 1.0);
  player.apiKey = state.apiKey;
  player.speaker = state.speaker;
  player.setRate(state.rate);
  updateRateBtn();
  wireEvents();
  await renderLibrary();
  if (!state.apiKey) openSettings();
}

init();
