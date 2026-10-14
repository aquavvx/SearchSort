var plugin = (() => {
  const B = bunny;
  const React = B.React;
  const RN = B.ReactNative;
  const h = React.createElement;

  const meta = {
    id: "searchsort",
    name: "SearchSort",
    description: "Sort Discord mobile search results by newest first or oldest first, like on PC.",
    version: "1.0.0"
  };

  const MODES = [
    { key: "default", label: "Default (relevance)", by: null, order: null },
    { key: "newest", label: "Newest first", by: "timestamp", order: "desc" },
    { key: "oldest", label: "Oldest first", by: "timestamp", order: "asc" }
  ];

  const defaults = { mode: "newest" };
  const store = B.plugin?.createStorage ? B.plugin.createStorage({ ...defaults }) : { ...defaults };
  if (store.mode === undefined) store.mode = defaults.mode;

  let unpatches = [];
  let lastStatus = "Waiting for a search...";
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn());

  function currentMode() {
    return MODES.find((m) => m.key === store.mode) || MODES[0];
  }

  function save(key) {
    store.mode = key;
    try {
      B.plugin?.flushStorage?.();
    } catch {}
    notify();
  }

  function isSearchUrl(url) {
    return typeof url === "string" && /\/(guilds|channels)\/\d+\/messages\/search/.test(url);
  }

  function addSort(request) {
    const mode = currentMode();
    if (!mode.by || !request || typeof request !== "object") return;
    if (!isSearchUrl(request.url)) return;

    if (request.query == null || typeof request.query === "object") {
      request.query = { ...(request.query || {}), sort_by: mode.by, sort_order: mode.order };
    } else if (typeof request.query === "string") {
      const clean = request.query.replace(/(^|&)sort_(by|order)=[^&]*/g, "").replace(/^&/, "");
      request.query = `${clean}${clean ? "&" : ""}sort_by=${mode.by}&sort_order=${mode.order}`;
    }
    lastStatus = `Last search was sorted: ${mode.label}`;
    notify();
  }

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
    const http = findHttp();
    const patcher = B.patcher || B.api?.patcher;
    if (!http || typeof patcher?.before !== "function") {
      lastStatus = "Could not find Discord's search request code. Plugin is inactive.";
      return;
    }
    for (const method of ["get", "post"]) {
      if (typeof http[method] !== "function") continue;
      try {
        unpatches.push(
          patcher.before(method, http, (args) => {
            try {
              addSort(args[0]);
            } catch (e) {
              console.error("[SearchSort]", e?.message);
            }
          })
        );
      } catch (e) {
        console.error("[SearchSort] patch failed", e?.message);
      }
    }
    if (!unpatches.length) lastStatus = "Patch failed. Plugin is inactive.";
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
          onPress: () => save(m.key),
          accessibilityRole: "button",
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

    return h(
      RN.ScrollView,
      { contentContainerStyle: { padding: 16, gap: 12 } },
      h(RN.Text, { style: { color: "#ffffff", fontSize: 20, fontWeight: "700" } }, "Search sort order"),
      h(RN.Text, { style: { color: "#b9bbbe" } }, "Pick how Discord search results are ordered, then run a search as normal."),
      ...rows,
      h(RN.Text, { style: { color: "#b9bbbe", marginTop: 8 } }, lastStatus)
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
