var plugin = (() => {
  const B = bunny;
  const React = B.React;
  const RN = B.ReactNative;
  const h = React.createElement;

  const MODES = [
    { key: "newest", label: "Newest first", by: "timestamp", order: "desc" },
    { key: "oldest", label: "Oldest first", by: "timestamp", order: "asc" },
    { key: "default", label: "Most relevant", by: null, order: null }
  ];

  const LABELS = [
    "By author type",
    "After a date",
    "Before a date",
    "Sent on a date",
    "Mention someone",
    "Has specific data",
    "In a specific channel",
    "From a specific person"
  ];
  const PREFERRED = "By author type";

  const defaults = { mode: "newest" };
  const store = B.plugin?.createStorage ? B.plugin.createStorage({ ...defaults }) : { ...defaults };
  if (store.mode === undefined) store.mode = defaults.mode;

  let unpatches = [];
  let lastSeen = "No search seen yet.";
  let menuHits = 0;
  let labelSightings = 0;
  let startNote = "";
  let lastSearchCall = null;
  let replayingSearch = false;
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn());

  function currentMode() {
    return MODES.find((m) => m.key === store.mode) || MODES[0];
  }

  function toast(text) {
    try {
      const show = B.ui?.toasts?.showToast || B.ui?.showToast;
      if (typeof show === "function") show(text);
    } catch {}
  }

  function choose(key) {
    store.mode = key;
    try {
      B.plugin?.flushStorage?.();
    } catch {}
    if (lastSearchCall && !replayingSearch) {
      replayingSearch = true;
      try {
        lastSearchCall();
        toast(`Search sort: ${currentMode().label}. Results refreshed.`);
      } catch (e) {
        console.error("[SearchSort] refresh", e?.message);
        toast(`Search sort: ${currentMode().label}. Run the search again to apply it.`);
      } finally {
        replayingSearch = false;
      }
    } else {
      toast(`Search sort: ${currentMode().label}. Run the search again to apply it.`);
    }
    notify();
  }

  // ---------- 1. Add the sort to the search request ----------
  function isSearchUrl(url) {
    return typeof url === "string" && /\/(guilds|channels)\/\d+\/messages\/search/.test(url);
  }

  function applyToRequest(request) {
    if (!request || typeof request !== "object" || !isSearchUrl(request.url)) return;
    const mode = currentMode();
    const notes = [];

    let body = request.body;
    const wasString = typeof body === "string";
    if (wasString) {
      try {
        body = JSON.parse(body);
      } catch {
        body = null;
      }
    }
    if (body && typeof body === "object") {
      if (body.tabs && typeof body.tabs === "object") {
        const keys = Object.keys(body.tabs);
        notes.push(`tabs: ${keys.join(",")}`);
        const target = body.tabs.messages && typeof body.tabs.messages === "object" ? ["messages"] : keys;
        for (const k of target) {
          if (body.tabs[k] && typeof body.tabs[k] === "object") {
            if (mode.by) {
              body.tabs[k].sort_by = mode.by;
              body.tabs[k].sort_order = mode.order;
            } else {
              delete body.tabs[k].sort_by;
              delete body.tabs[k].sort_order;
            }
          }
        }
      } else {
        notes.push("body without tabs");
        if (mode.by) {
          body.sort_by = mode.by;
          body.sort_order = mode.order;
        } else {
          delete body.sort_by;
          delete body.sort_order;
        }
      }
      request.body = wasString ? JSON.stringify(body) : body;
    }

    if (!body) {
      if (request.query == null || typeof request.query === "object") {
        request.query = { ...(request.query || {}) };
        if (mode.by) {
          request.query.sort_by = mode.by;
          request.query.sort_order = mode.order;
        } else {
          delete request.query.sort_by;
          delete request.query.sort_order;
        }
        notes.push("query object");
      } else if (typeof request.query === "string") {
        const clean = request.query.replace(/(^|&)sort_(by|order)=[^&]*/g, "").replace(/^&/, "");
        request.query = mode.by ? `${clean}${clean ? "&" : ""}sort_by=${mode.by}&sort_order=${mode.order}` : clean;
        notes.push("query string");
      }
    }

    lastSeen = `${String(request.url).split("?")[0]} | ${mode.label} | ${notes.join(" / ") || "nothing changed"}`;
    notify();
  }

  function applyToHttpArgs(args) {
    if (!Array.isArray(args) || args.length === 0) return;
    if (args[0] && typeof args[0] === "object") {
      applyToRequest(args[0]);
      return;
    }

    if (typeof args[0] !== "string" || !isSearchUrl(args[0])) return;
    const request = {
      url: args[0],
      body: args[1],
      query: args[2]
    };
    applyToRequest(request);
    args[1] = request.body;
    args[2] = request.query;
  }

  function copyRequestArgs(args) {
    return args.map((value) => {
      if (!value || typeof value !== "object") return value;
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return value;
      }
    });
  }

  // ---------- 2. Add the options to the "Filter results..." menu ----------
  const isEl = (x) => !!x && typeof x === "object" && !Array.isArray(x) && x.props && (x.type !== undefined || x.$$typeof !== undefined);
  const isPlain = (x) => !!x && typeof x === "object" && !Array.isArray(x) && !isEl(x);
  const isOurs = (x) => !!x && ((typeof x.key === "string" && x.key.startsWith("searchsort-")) || x.__searchsort === true);

  function containsOurs(node, depth = 0) {
    if (node == null || depth > 8) return false;
    if (isOurs(node)) return true;
    if (Array.isArray(node)) return node.some((item) => containsOurs(item, depth + 1));
    if (isEl(node)) {
      return Object.values(node.props).some((value) => containsOurs(value, depth + 1));
    }
    return false;
  }

  function labelsIn(node, out = new Set(), depth = 0) {
    if (node == null || depth > 4) return out;
    if (typeof node === "string") {
      if (LABELS.includes(node)) out.add(node);
    } else if (Array.isArray(node)) {
      if (node.length <= 30) for (const n of node) labelsIn(n, out, depth + 1);
    } else if (isEl(node)) {
      for (const v of Object.values(node.props)) labelsIn(v, out, depth + 1);
    }
    return out;
  }

  function plainLabel(obj) {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && LABELS.includes(v)) return { field: k, label: v };
    }
    return null;
  }

  const HANDLER_KEY = /(press|select|click|action|handler|callback)/i;

  function rewrite(node, from, to, handler, depth = 0) {
    if (node == null || depth > 6) return node;
    if (typeof node === "string") return node === from ? to : node;
    if (Array.isArray(node)) return node.map((n) => rewrite(n, from, to, handler, depth + 1));
    if (isEl(node)) {
      const next = {};
      for (const [k, v] of Object.entries(node.props)) {
        if (typeof v === "function" && HANDLER_KEY.test(k)) next[k] = handler;
        else if (typeof v === "string" || Array.isArray(v) || isEl(v)) next[k] = rewrite(v, from, to, handler, depth + 1);
      }
      return React.cloneElement(node, next);
    }
    return node;
  }

  function makeRow(anchor, found, mode) {
    const label = `${store.mode === mode.key ? "✔ " : ""}Sort: ${mode.label}`;
    const handler = () => choose(mode.key);
    if (isEl(anchor)) {
      return React.cloneElement(rewrite(anchor, found.label, label, handler), { key: `searchsort-${mode.key}` });
    }
    const copy = { ...anchor, __searchsort: true };
    copy[found.field] = label;
    for (const [k, v] of Object.entries(copy)) {
      if (typeof v === "function" && HANDLER_KEY.test(k)) copy[k] = handler;
    }
    if (typeof copy.key === "string") copy.key = `searchsort-${mode.key}`;
    if (typeof copy.id === "string") copy.id = `searchsort-${mode.key}`;
    return copy;
  }

  function transformArray(arr, depth) {
    if (!Array.isArray(arr) || depth > 3 || arr.length > 30 || arr.length === 0) return null;
    if (containsOurs(arr)) return null;

    const candidates = [];
    arr.forEach((item, i) => {
      if (isEl(item)) {
        const set = labelsIn(item);
        if (set.size > 0) labelSightings++;
        if (set.size === 1) candidates.push({ i, found: { label: [...set][0] } });
      } else if (isPlain(item)) {
        const f = plainLabel(item);
        if (f) {
          labelSightings++;
          candidates.push({ i, found: f });
        }
      }
    });

    if (candidates.length) {
      const pick = candidates.find((c) => c.found.label === PREFERRED) || candidates[candidates.length - 1];
      const anchor = arr[pick.i];
      const extras = MODES.map((m) => makeRow(anchor, pick.found, m));
      menuHits++;
      return [...arr.slice(0, pick.i + 1), ...extras, ...arr.slice(pick.i + 1)];
    }

    for (let i = 0; i < arr.length; i++) {
      if (Array.isArray(arr[i])) {
        const inner = transformArray(arr[i], depth + 1);
        if (inner) {
          const copy = arr.slice();
          copy[i] = inner;
          return copy;
        }
      }
    }
    return null;
  }

  function transformElement(node, depth = 0) {
    if (!isEl(node) || depth > 8) return null;
    const props = node.props;
    for (const [key, value] of Object.entries(props)) {
      if (Array.isArray(value)) {
        const next = transformArray(value, key === "children" ? 0 : 1);
        if (next) return React.cloneElement(node, { [key]: next });
      } else if (isEl(value)) {
        const next = transformElement(value, depth + 1);
        if (next) return React.cloneElement(node, { [key]: next });
      }
    }
    return null;
  }

  function onRender(result) {
    try {
      const next = transformElement(result);
      if (next) {
        notify();
        return next;
      }
    } catch (e) {
      console.error("[SearchSort] menu", e?.message);
    }
  }

  // ---------- start / stop ----------
  function findHttp() {
    try {
      const found =
        B.metro.findByProps("HTTP", "get", "post", "put", "patch", "del") ||
        B.metro.findByProps("get", "post", "put", "del");
      return found?.HTTP || found;
    } catch {
      return null;
    }
  }

  function start() {
    const patcher = B.patcher || B.api?.patcher;
    if (typeof patcher?.before !== "function") {
      startNote = "Patcher not available. Plugin is inactive.";
      return;
    }

    const http = findHttp();
    if (http) {
      for (const method of ["get", "post"]) {
        if (typeof http[method] !== "function") continue;
        try {
          unpatches.push(
            patcher.before(method, http, (args) => {
              try {
                if (!replayingSearch && args[0] && typeof args[0] === "object" && isSearchUrl(args[0].url)) {
                  const saved = copyRequestArgs(args);
                  lastSearchCall = () => http[method](...saved);
                } else if (!replayingSearch && typeof args[0] === "string" && isSearchUrl(args[0])) {
                  const saved = copyRequestArgs(args);
                  lastSearchCall = () => http[method](...saved);
                }
                applyToHttpArgs(args);
              } catch (e) {
                console.error("[SearchSort]", e?.message);
              }
            })
          );
        } catch {}
      }
    } else {
      startNote = "Could not find Discord's request code. ";
    }

    try {
      unpatches.push(patcher.after("createElement", React, (_a, res) => onRender(res)));
    } catch {}
    try {
      const rt = B.metro.findByProps("jsx", "jsxs");
      for (const k of ["jsx", "jsxs"]) {
        if (typeof rt?.[k] === "function") unpatches.push(patcher.after(k, rt, (_a, res) => onRender(res)));
      }
    } catch {}

    startNote += `Started with ${unpatches.length} patches.`;
  }

  function stop() {
    while (unpatches.length) {
      try {
        unpatches.pop()();
      } catch {}
    }
    listeners.clear();
  }

  // Settings page: status only. Sorting is chosen from the search Filter results menu.
  function Settings() {
    const [, bump] = React.useState(0);
    React.useEffect(() => {
      const fn = () => bump((n) => n + 1);
      listeners.add(fn);
      return () => listeners.delete(fn);
    }, []);

    const dim = { color: "#b9bbbe", fontSize: 13 };
    return h(
      RN.ScrollView,
      { contentContainerStyle: { padding: 16, gap: 10 } },
      h(RN.Text, { style: { color: "#ffffff", fontSize: 20, fontWeight: "700" } }, "SearchSort"),
      h(RN.Text, { style: { color: "#b9bbbe" } }, "Choose the sort order from the Filter results menu in search."),
      h(RN.Text, { style: dim }, `Current: ${currentMode().label}`),
      h(RN.Text, { style: dim }, `Status: ${startNote}`),
      h(RN.Text, { style: dim }, `Menu labels spotted: ${labelSightings}`),
      h(RN.Text, { style: dim }, `Menu rows added: ${menuHits}`),
      h(RN.Text, { style: dim }, `Last search: ${lastSeen}`)
    );
  }

  return {
    __esModule: true,
    default: definePlugin({
      async start() {
        start();
      },
      async stop() {
        stop();
      },
      SettingsComponent() {
        return h(Settings);
      }
    })
  };
})();
