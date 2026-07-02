const API_BASE = "https://deprecatedapis.tts.quest/v2";

export async function synthesize(text, speaker, key) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
    try {
      const url = API_BASE + "/voicevox/audio/?speaker=" + speaker +
        "&key=" + encodeURIComponent(key) + "&text=" + encodeURIComponent(text);
      const res = await fetch(url);
      if (!res.ok) throw new Error("合成APIエラー HTTP " + res.status);
      const blob = await res.blob();
      if (!blob.type.includes("audio")) {
        const body = (await blob.text()).slice(0, 200);
        const err = new Error(body);
        err.code = body.includes("notEnoughPoints") ? "points"
          : body.includes("invalidApiKey") ? "key" : "api";
        throw err;
      }
      return blob;
    } catch (e) {
      if (e.code === "points" || e.code === "key") throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function fetchSpeakers(key) {
  const res = await fetch(API_BASE + "/voicevox/speakers/?key=" + encodeURIComponent(key));
  if (!res.ok) throw new Error("話者一覧の取得に失敗しました");
  return res.json();
}

export async function fetchPoints(key) {
  const res = await fetch(API_BASE + "/api/?key=" + encodeURIComponent(key));
  if (!res.ok) throw new Error("ポイント確認に失敗しました");
  return res.json();
}
