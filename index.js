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

  const MENU_ANCHOR = "By author type";
  const defaults = { mode: "newest" };
  const store = B.plugin?.createStorage ? B.plugin.createStorage({ ...defaults }) : { ...defaults };
  if (store.mode === undefined) store.mode = defaults.mode;

  let unpatches = [];
  let lastSeen = "No search seen yet.";
  let menuHits = 0;
  let startNote = "";
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
    const m = currentMode();
    toast(`Search sort: ${m.label}. Run the search again to apply.`);
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

    // New search screen: POST .../messages/search/tabs with the options inside body.tabs
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
        if (mode.by) {
          for (const k of target) {
            if (body.tabs[k] && typeof body.tabs[k] === "object") {
              body.tabs[k].sort_by = mode.by;
              body.tabs[k].sort_order = mode.order;
            }
          }
        }
      } else {
        notes.push("body without tabs");
        if (mode.by) {
          body.sort_by = mode.by;
          body.sort_order = mode.order;
        }
      }
      request.body = wasString ? JSON.stringify(body) : body;
    }

    // Older style: GET .../messages/search?query
    if (mode.by && !body) {
      if (request.query == null || typeof request.query === "object") {
        request.query = { ...(request.query || {}), sort_by: mode.by, sort_order: mode.order };
        notes.push("query object");
      } else if (typeof request.query === "string") {
        const clean = request.query.replace(/(^|&)sort_(by|order)=[^&]*/g, "").replace(/^&/, "");
        request.query = `${clean}${clean ? "&" : ""}sort_by=${mode.by}&sort_order=${mode.order}`;
        notes.push("query string");
      }
    }

    lastSeen = `${String(request.url).split("?")[0]} | ${mode.label} | ${notes.join(" / ") || "nothing changed"}`;
    notify();
  }

  // ---------- 2. Add the options to the "Filter results..." menu ----------
  function textMatches(node, depth = 0) {
    if (node == null || depth > 4) return false;
    if (typeof node === "string") return node === MENU_ANCHOR;
    if (Array.isArray(node)) return node.some((n) => textMatches(n, depth + 1));
    if (typeof node === "object" && node.props) {
      return Object.values(node.props).some((v) => textMatches(v, depth + 1));
    }
    return false;
  }

  function rewrite(node, label, handler, depth = 0) {
    if (node == null || depth > 6) return node;
    if (typeof node === "string") return node === MENU_ANCHOR ? label : node;
    if (Array.isArray(node)) return node.map((n) => rewrite(n, label, handler, depth + 1));
    if (typeof node === "object" && node.props) {
      const next = {};
      for (const [k, v] of Object.entries(node.props)) {
        if (typeof v === "function" && /^on(Press|Select|Click|Change)/.test(k)) next[k] = handler;
        else if (k === "children" || typeof v === "string" || (v && typeof v === "object" && !React.isValidElement?.(v) && !Array.isArray(v) ? false : true)) {
          next[k] = rewrite(v, label, handler, depth + 1);
        }
      }
      return React.cloneElement(node, next);
    }
    return node;
  }

  function injectMenu(el) {
    const kids = el?.props?.children;
    if (!Array.isArray(kids) || kids.length > 40) return;
    if (kids.some((k) => typeof k?.key === "string" && k.key.startsWith("searchsort-"))) return;
    const idx = kids.findIndex((k) => k && typeof k === "object" && k.props && textMatches(k));
    if (idx < 0) return;
    const anchor = kids[idx];
    const extras = MODES.map((m) => {
      const label = `${store.mode === m.key ? "\u2714 " : ""}Sort: ${m.label}`;
      const row = rewrite(anchor, label, () => choose(m.key));
      return React.cloneElement(row, { key: `searchsort-${m.key}` });
    });
    const next = [...kids.slice(0, idx + 1), ...extras, ...kids.slice(idx + 1)];
    menuHits++;
    notify();
    return React.cloneElement(el, { children: next });
  }

  function onRender(result) {
    try {
      if (result && result.props && Array.isArray(result.props.children)) return injectMenu(result);
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
                applyToRequest(args[0]);
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

  function Settings() {
    const [, bump] = React.useState(0);
    React.useEffect(() => {
      const fn = () => bump((n) => n + 1);
      listeners.add(fn);
      return () => listeners.delete(fn);
    }, []);

    const rows = MODES.map((m) => {
      const selected = store.mode === m.key;
      return h(
        RN.Pressable,
        {
          key: m.key,
          onPress: () => choose(m.key),
          style: {
            padding: 14,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: selected ? "#5865F2" : "#4f545c",
            backgroundColor: selected ? "rgba(88,101,242,0.25)" : "transparent"
          }
        },
        h(RN.Text, { style: { color: "#ffffff", fontSize: 16 } }, (selected ? "\u2714  " : "") + m.label)
      );
    });

    const dim = { color: "#b9bbbe", fontSize: 12 };
    return h(
      RN.ScrollView,
      { contentContainerStyle: { padding: 16, gap: 12 } },
      h(RN.Text, { style: { color: "#ffffff", fontSize: 20, fontWeight: "700" } }, "Search sort order"),
      h(RN.Text, { style: { color: "#b9bbbe" } }, "Also available in the search Filter results menu."),
      ...rows,
      h(RN.Text, { style: dim }, `Status: ${startNote}`),
      h(RN.Text, { style: dim }, `Filter menu rows added: ${menuHits} time(s)`),
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
