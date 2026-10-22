/**
 * 黄果短剧 (huangguoai) —— THLRedGuo / CatPawOpen JS Spider
 *
 * 完全基于站点公开 JSON 接口实现，无需解析 HTML：
 *   GET /api/tags                 分类 + 标签
 *   GET /api/videos?cate_id=&page=&size=   列表
 *   GET /api/videos/{id}          详情
 *   GET /api/videos/{id}/play?ep=N 播放地址
 *   GET /api/search?q=&page=&size= 搜索
 *
 * 约定：全局 spider 对象 + globalThis.fetch（沙箱内唯一网络能力）
 */

const meta = {
  id: "huangguo",
  name: "黄果短剧",
  version: "1.0.0",
  description: "黄果短剧 · AI短剧/漫剧/换脸/魔改，专为 THLRedGuo 适配",
  author: "THLRedLook",
  type: "video",
  icon: "",
  requiresAuth: false,
  features: ["search", "suggestions", "rankingBoards", "rankings", "recommendations", "categories"]
};

// ---- 可用域名池（发布页动态更新，失效自动切换） ----
const PUBLISH_SOURCES = [
  "https://proxy.oily.cn/proxy/https://huangguoai.pages.dev/publish.js",
  "https://huangguoai.pages.dev/publish.js",
  "https://huang-guo.pages.dev/publish.js"
];

const FALLBACK_HOSTS = [
  "https://thu.ir95e08v.cc",
  "https://pku.ir95e08v.cc",
  "https://fdu.ir95e08v.cc",
  "https://sjtu.ir95e08v.cc",
  "https://thu.zj73w86v.cc",
  "https://thu.uw29h15s.com"
];

// ---- 站点主分类（已实测cate_id 对应关系） ----
const SITE_CLASSES = [
  { id: "24", name: "AI成人短剧", slug: "ai-duanju" },
  { id: "25", name: "AI成人漫剧", slug: "ai-manju" },
  { id: "26", name: "AI换脸", slug: "ai-huanlian" },
  { id: "27", name: "AI魔改", slug: "ai-mogai" }
];

let _host = "";
let _hostCheckedAt = 0;
// 最近一次访问的剧 ID（用于引擎兜底形态 "源ID_集号" 的剧 ID 还原）
let _lastVid = "";

const TIMEOUT = 15000;

// 播放器 UA（与 THLRedGuo ExoPlayer 注入的一致，防盗链 CDN 友好）
const PLAYER_UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

// 本源可能出现的 id 前缀（引擎会自动给 sourceId 加 "源ID_" 前缀）
const ID_PREFIXES = ["huangguo_", "huangguo:", "huangguo", "hg_", "hg:"];

function currentHost() {
  return _host || FALLBACK_HOSTS[0];
}

// 剥掉引擎附加的源前缀，返回纯数字视频 ID
function normalizeVid(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  for (const p of ID_PREFIXES) {
    if (s.toLowerCase().indexOf(p) === 0) {
      s = s.slice(p.length);
      break;
    }
  }
  // 形如 "12/1" 或 "12_1"：取视频号部分
  const m = s.match(/^(\d+)(?:[\/_$].*)?$/);
  if (m) return m[1];
  const digits = s.match(/(\d+)/);
  return digits ? digits[1] : "";
}

// 解析播放目标：区分「剧ID_集号」与「剧ID」两种形态
// "huangguo_9654_1"  -> vid=9654 ep=1
// "huangguo_1"       -> 可能是「剧ID=1」，也可能是引擎兜底「第1集」
// 引擎兜底 target = "${sourceId}_${episodeIndex}"，此时集号已知但剧 ID 丢失，
// 故用最近一次 detail 缓存的剧 ID 兜底。
async function resolvePlayTarget(raw, fallbackVid) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return { vid: "", ep: "1" };

  for (const p of ID_PREFIXES) {
    if (s.toLowerCase().indexOf(p) === 0) {
      s = s.slice(p.length);
      break;
    }
  }
  s = s.split("?")[0];

  // "剧ID_集号"：两段数字
  let m = s.match(/^(\d+)[_/](\d{1,5})$/);
  if (m) return { vid: m[1], ep: String(m[2]) };

  // "剧ID$集号"
  m = s.match(/^(\d+)\$(\d{1,5})$/);
  if (m) return { vid: m[1], ep: String(m[2]) };

  // 纯剧ID
  m = s.match(/^(\d+)$/);
  if (m) {
    // 该数字若不是有效剧 ID，则视为「集号」，配合最近缓存的剧 ID
    if (fallbackVid && m[1] !== fallbackVid && !(await isLikelyVid(m[1]))) {
      return { vid: fallbackVid, ep: m[1] };
    }
    return { vid: m[1], ep: "1" };
  }

  // 兜底形态：只给了集号（如 "huangguo_1"），用最近缓存的剧 ID
  const epOnly = s.match(/(\d{1,5})$/);
  if (epOnly && fallbackVid) return { vid: fallbackVid, ep: epOnly[1] };

  return { vid: "", ep: "1" };
}

// 判断数字是否是一个真实存在的剧 ID（避免把「集号」误当剧 ID）
const _vidCache = {};
async function isLikelyVid(num) {
  if (!num) return false;
  if (_vidCache[num] !== undefined) return _vidCache[num];
  try {
    const d = await api("/api/videos/" + encodeURIComponent(num));
    const ok = !!(d && (d.id !== undefined || d.title));
    _vidCache[num] = ok;
    return ok;
  } catch (e) {
    _vidCache[num] = false;
    return false;
  }
}

function now() {
  return Date.now();
}

async function httpGet(url, opts) {
  opts = opts || {};
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": PLAYER_UA,
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://" + (url.split("/")[2] || "") + "/"
    },
    timeoutMs: opts.timeoutMs || TIMEOUT
  });
  if (!r || !r.ok) {
    throw new Error("HTTP " + (r ? r.status : "no-response"));
  }
  const txt = await r.text();
  if (!txt || !txt.length) throw new Error("empty body");
  return JSON.parse(txt);
}

// ---- 动态解析可用 host ----
function parsePublishHosts(js) {
  const out = [];
  try {
    const urlMatch = js.match(/urls\s*=\s*\[([\s\S]*?)\]/);
    const subMatch = js.match(/subdomains\s*=\s*\[([\s\S]*?)\]/);
    const domains = [];
    if (urlMatch) {
      const raw = urlMatch[1].match(/['"]([^'"]+)['"]/g) || [];
      for (const d of raw) {
        const c = d.replace(/['"\/\s]/g, "");
        if (c) domains.push(c);
      }
    }
    let subs = ["thu", "pku", "fdu", "sjtu", "zju", "nju", "xmu", "sysu"];
    if (subMatch) {
      const raw = subMatch[1].match(/['"]([^'"]+)['"]/g) || [];
      if (raw.length) {
        subs = raw.slice(0, 8).map((s) => s.replace(/['"]/g, ""));
      }
    }
    for (const d of domains) {
      for (const s of subs) out.push("https://" + s + "." + d);
    }
  } catch (e) {
    /* ignore */
  }
  return out;
}

async function probeHost(h) {
  try {
    const r = await fetch(h + "/api/tags", {
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      timeoutMs: 8000
    });
    if (r && r.ok) {
      const t = await r.text();
      if (t && t.indexOf("categories") !== -1) return true;
    }
  } catch (e) {
    /* ignore */
  }
  return false;
}

async function resolveHost() {
  if (_host && now() - _hostCheckedAt < 30 * 60 * 1000) return _host;

  const candidates = [];
  for (const src of PUBLISH_SOURCES) {
    try {
      const r = await fetch(src, { method: "GET", timeoutMs: 6000 });
      if (r && r.ok) {
        const t = await r.text();
        if (t && t.indexOf("urls=") !== -1) {
          const hs = parsePublishHosts(t);
          for (const h of hs) candidates.push(h);
          if (candidates.length) break;
        }
      }
    } catch (e) {
      /* ignore */
    }
  }
  for (const h of FALLBACK_HOSTS) candidates.push(h);

  for (const h of candidates) {
    if (await probeHost(h)) {
      _host = h;
      _hostCheckedAt = now();
      return _host;
    }
  }
  _host = FALLBACK_HOSTS[0];
  _hostCheckedAt = now();
  return _host;
}

async function api(path, params) {
  const host = await resolveHost();
  let url = host + path;
  const qs = [];
  if (params) {
    for (const k in params) {
      const v = params[k];
      if (v === undefined || v === null || v === "") continue;
      qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
    }
  }
  if (qs.length) url += (url.indexOf("?") === -1 ? "?" : "&") + qs.join("&");
  const j = await httpGet(url);
  if (j && j.status === 0) throw new Error(j.msg || "api error");
  return j && j.data ? j.data : j;
}

function mapItem(it) {
  return {
    vod_id: String(it.id),
    vod_name: (it.title || "").trim(),
    vod_pic: it.cover || it.preview_url || "",
    vod_remarks: it.episode_count ? it.episode_count + "集" : (it.is_finished ? "完结" : "连载"),
    vod_year: "",
    vod_area: "",
    vod_actor: "",
    vod_director: "",
    vod_content: (it.description || "").trim(),
    vod_score: it.score || "",
    vod_time: it.created_at || ""
  };
}

const spider = {
  meta: meta,

  // ---- 首页 ----
  async home(filter) {
    const d = await api("/api/videos", { page: 1, size: 20 });
    const list = (d && d.items ? d.items : []).map(mapItem);
    return {
      class: SITE_CLASSES.map((c) => ({ type_id: c.id, type_name: c.name })),
      filters: {
        分类: SITE_CLASSES.map((c) => ({ name: c.name, value: c.id }))
      },
      recommendations: list
    };
  },

  // ---- 分类列表 ----
  async category(tid, page, filter, extend) {
    const p = page || 1;
    const params = { page: p, size: 20 };
    if (tid) params.cate_id = tid;
    if (extend) {
      if (extend.cate_id) params.cate_id = extend.cate_id;
      if (extend.tagid) params.tag_id = extend.tagid;
    }
    const d = await api("/api/videos", params);
    const list = (d && d.items ? d.items : []).map(mapItem);
    const pg = (d && d.pagination) || {};
    return {
      page: p,
      pagecount: pg.pages || 100,
      limit: list.length,
      total: pg.total || 0,
      list: list
    };
  },

  // ---- 详情 ----
  async detail(id) {
    // 兼容引擎可能传入 "huangguo_9654" 这类带前缀的 sourceId
    const vid = normalizeVid(id);
    const d = await api("/api/videos/" + encodeURIComponent(vid));
    _lastVid = String(d.id || vid);
    const eps = [];
    const episodes = d.episodes || [];
    for (const e of episodes) {
      // 接口的第2集起 title 是简介文案，统一规范成 "第N集"
      // ID 用 "vid/ep" 形式（含 "/"，可避免引擎自动加 sourceId_ 前缀）
      eps.push({
        name: "第" + e.ep_num + "集",
        id: vid + "/" + e.ep_num
      });
    }
    if (!eps.length && d.episode_count) {
      for (let i = 1; i <= d.episode_count; i++) {
        eps.push({ name: "第" + i + "集", id: vid + "/" + i });
      }
    }
    return {
      vod_id: String(d.id),
      vod_name: (d.title || "").trim(),
      vod_pic: d.cover || "",
      vod_remarks: d.episode_count ? d.episode_count + "集" : "",
      vod_year: "",
      vod_area: "",
      vod_actor: "",
      vod_director: (d.author && d.author.name) || "",
      vod_content: (d.description || "").trim(),
      vod_score: d.score || "",
      vod_time: d.created_at || "",
      vod_play_from: "黄果",
      vod_play_url: eps.map((e) => e.name + "$" + e.id).join("#")
    };
  },

  // ---- 播放 ----
  async play(flag, id, flags) {
    const parsed = await resolvePlayTarget(id, _lastVid);
    let vid = parsed.vid;
    const ep = parsed.ep;
    if (!vid) return { parse: 0, url: "", header: {} };

    let url = "";
    try {
      const d = await api("/api/videos/" + encodeURIComponent(vid) + "/play", { ep: ep });
      url = d.video_url || d.preview_url || "";
    } catch (e) {
      url = "";
    }
    if (!url) {
      // 兜底：详情 JSON 里也有 video_url
      try {
        const det = await api("/api/videos/" + encodeURIComponent(vid));
        url = det.video_url || "";
      } catch (e) {
        url = "";
      }
    }
    if (!url) return { parse: 0, url: "", header: {} };
    return {
      parse: 0,
      url: url,
      header: { "User-Agent": PLAYER_UA, "Referer": currentHost() + "/" }
    };
  },

  // ---- 搜索 ----
  async search(word, quick, page) {
    const p = page || 1;
    const d = await api("/api/search", { q: word, page: p, size: 20 });
    const list = (d && d.items ? d.items : []).map(mapItem);
    return list;
  },

  // ---- 搜索建议 ----
  async suggestions(word) {
    try {
      const d = await api("/api/search", { q: word, page: 1, size: 10 });
      const items = (d && d.items) || [];
      return items.map((it) => ({ name: (it.title || "").trim(), id: String(it.id) }));
    } catch (e) {
      return [];
    }
  }
};

if (typeof globalThis !== "undefined" && !globalThis.spider) {
  globalThis.spider = spider;
}
