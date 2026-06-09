/**
 * API base URL for order submissions.
 * - Local (node serve.js): leave PRODUCTION_API empty — uses same origin.
 * - GitHub Pages shop + API on Render (current setup): set PRODUCTION_API below.
 * - Full site on Render with sweettoothcravings.shop DNS: leave PRODUCTION_API empty.
 */
(function (global) {
  const host = (global.location && global.location.hostname) || "";

  /**
   * Node order server (serve.js) on Render — see DEPLOY.md.
   * Change only if your Render service URL is different.
   */
  const PRODUCTION_API = "https://sweettooth-cravings.onrender.com";

  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "";

  const isLiveShop =
    host === "sweettoothcravings.shop" ||
    host === "www.sweettoothcravings.shop" ||
    host.endsWith(".github.io");

  let base = "";
  if (isLocal) {
    base = "";
  } else if (isLiveShop && PRODUCTION_API) {
    base = String(PRODUCTION_API).replace(/\/$/, "");
  }

  global.STC_API_BASE = base;
})(typeof window !== "undefined" ? window : globalThis);