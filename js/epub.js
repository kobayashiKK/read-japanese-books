const DC_NS = "http://purl.org/dc/elements/1.1/";

function normalizePath(path) {
  const parts = [];
  for (const p of path.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return parts.join("/");
}

function dirOf(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
}

function stripFragment(href) {
  return href.split("#")[0];
}

async function readXml(zip, path) {
  const file = zip.file(path);
  if (!file) throw new Error(path + " が見つかりません");
  const text = await file.async("string");
  return new DOMParser().parseFromString(text, "application/xml");
}

function extractText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("rt, rp, script, style").forEach(e => e.remove());
  const text = doc.body ? doc.body.textContent : "";
  return text.replace(/[ \t　]+/g, " ").replace(/\n\s*/g, "\n").trim();
}

export function chunkText(text) {
  const MAX = 150;
  const TARGET = 100;
  const sentences = [];
  for (const line of text.split("\n")) {
    const parts = line.match(/[^。！？!?]*[。！？!?]+[」』）〉》]*|[^。！？!?]+$/g);
    if (parts) {
      for (const p of parts) {
        const s = p.trim();
        if (s) sentences.push(s);
      }
    }
  }
  const chunks = [];
  let cur = "";
  for (let s of sentences) {
    while (s.length > MAX) {
      if (cur) { chunks.push(cur); cur = ""; }
      let cut = s.lastIndexOf("、", MAX);
      if (cut < 40) cut = MAX - 1;
      chunks.push(s.slice(0, cut + 1));
      s = s.slice(cut + 1);
    }
    if (cur && (cur + s).length > TARGET) {
      chunks.push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter(c => /[ぁ-んァ-ヶ一-龠a-zA-Z0-9０-９]/.test(c));
}

async function parseNavToc(zip, navPath) {
  const file = zip.file(navPath);
  if (!file) return new Map();
  const doc = new DOMParser().parseFromString(await file.async("string"), "text/html");
  const base = dirOf(navPath);
  let tocNav = null;
  for (const nav of doc.querySelectorAll("nav")) {
    const type = nav.getAttribute("epub:type") || "";
    if (type.includes("toc")) { tocNav = nav; break; }
  }
  if (!tocNav) tocNav = doc.querySelector("nav");
  const map = new Map();
  if (!tocNav) return map;
  for (const a of tocNav.querySelectorAll("a[href]")) {
    const href = normalizePath(base + stripFragment(a.getAttribute("href")));
    const title = a.textContent.trim();
    if (href && title && !map.has(href)) map.set(href, title);
  }
  return map;
}

async function parseNcxToc(zip, ncxPath) {
  const map = new Map();
  const file = zip.file(ncxPath);
  if (!file) return map;
  const doc = new DOMParser().parseFromString(await file.async("string"), "application/xml");
  const base = dirOf(ncxPath);
  for (const np of doc.querySelectorAll("navPoint")) {
    const label = np.querySelector("navLabel > text");
    const content = np.querySelector("content");
    if (!label || !content) continue;
    const href = normalizePath(base + stripFragment(content.getAttribute("src") || ""));
    const title = label.textContent.trim();
    if (href && title && !map.has(href)) map.set(href, title);
  }
  return map;
}

export async function parseEpub(file, onProgress) {
  const report = onProgress || (() => {});
  report("EPUBを展開中…");
  const zip = await JSZip.loadAsync(file);

  const container = await readXml(zip, "META-INF/container.xml");
  const rootfile = container.querySelector("rootfile");
  if (!rootfile) throw new Error("container.xmlの形式が不正です");
  const opfPath = rootfile.getAttribute("full-path");
  const opfDir = dirOf(opfPath);
  const opf = await readXml(zip, opfPath);

  const titleEl = opf.getElementsByTagNameNS(DC_NS, "title")[0];
  const authorEl = opf.getElementsByTagNameNS(DC_NS, "creator")[0];
  const title = (titleEl && titleEl.textContent.trim()) || file.name.replace(/\.epub$/i, "");
  const author = (authorEl && authorEl.textContent.trim()) || "";

  const manifest = {};
  for (const item of opf.querySelectorAll("manifest > item")) {
    manifest[item.getAttribute("id")] = {
      href: item.getAttribute("href") || "",
      type: item.getAttribute("media-type") || "",
      props: item.getAttribute("properties") || ""
    };
  }

  let coverBlob = null;
  let coverHref = null;
  for (const id in manifest) {
    if (manifest[id].props.split(" ").includes("cover-image")) coverHref = manifest[id].href;
  }
  if (!coverHref) {
    const meta = opf.querySelector('meta[name="cover"]');
    const cid = meta && meta.getAttribute("content");
    if (cid && manifest[cid]) coverHref = manifest[cid].href;
  }
  if (coverHref) {
    const f = zip.file(normalizePath(opfDir + coverHref));
    if (f) coverBlob = await f.async("blob");
  }

  report("目次を解析中…");
  let tocMap = new Map();
  const navId = Object.keys(manifest).find(id => manifest[id].props.split(" ").includes("nav"));
  if (navId) {
    tocMap = await parseNavToc(zip, normalizePath(opfDir + manifest[navId].href));
  }
  if (tocMap.size === 0) {
    const spineEl = opf.querySelector("spine");
    const ncxId = spineEl && spineEl.getAttribute("toc");
    if (ncxId && manifest[ncxId]) {
      tocMap = await parseNcxToc(zip, normalizePath(opfDir + manifest[ncxId].href));
    }
  }

  const spineItems = [];
  for (const itemref of opf.querySelectorAll("spine > itemref")) {
    const m = manifest[itemref.getAttribute("idref")];
    if (!m || m.props.split(" ").includes("nav")) continue;
    if (m.type.includes("html") || m.type.includes("xml")) {
      spineItems.push(normalizePath(opfDir + m.href));
    }
  }
  if (spineItems.length === 0) throw new Error("本文が見つかりません");

  const guideRef = opf.querySelector('guide > reference[type="text"]');
  const startHref = guideRef ? normalizePath(opfDir + stripFragment(guideRef.getAttribute("href") || "")) : null;

  const rawChapters = [];
  for (let i = 0; i < spineItems.length; i++) {
    report("本文を抽出中… (" + (i + 1) + "/" + spineItems.length + ")");
    const f = zip.file(spineItems[i]);
    if (!f) continue;
    const text = extractText(await f.async("string"));
    const tocTitle = tocMap.get(spineItems[i]);
    if (tocTitle !== undefined || rawChapters.length === 0) {
      rawChapters.push({ title: tocTitle || "冒頭", text, hrefs: [spineItems[i]] });
    } else {
      const last = rawChapters[rawChapters.length - 1];
      last.text += "\n" + text;
      last.hrefs.push(spineItems[i]);
    }
  }

  report("文を分割中…");
  const chapters = [];
  let startChapter = 0;
  for (const c of rawChapters) {
    const chunks = chunkText(c.text);
    if (chunks.length === 0) continue;
    if (startHref && c.hrefs.includes(startHref)) startChapter = chapters.length;
    chapters.push({ title: c.title, chunks });
  }
  if (chapters.length === 0) throw new Error("読み上げ可能な本文が見つかりません");

  return { title, author, coverBlob, chapters, startChapter };
}
