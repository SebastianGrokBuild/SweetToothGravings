/**
 * API base URL for order submissions.
 * - Local (node serve.js): leave empty — uses same origin.
 * - Live shop on static hosting: set PRODUCTION_API to your Node server URL.
 */
(function (global) {
  const host = (global.location && global.location.hostname) || "";

  /** After deploying serve.js (see DEPLOY.md), paste URL here, e.g. https://sweettooth-cravings.onrender.com */
  const PRODUCTION_API = "";

  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "";

  const isLiveShop =
    host === "sweettoothcravings.shop" || host === "www.sweettoothcravings.shop";

  let base = "";
  if (isLocal) {
    base = "";
  } else if (isLiveShop && PRODUCTION_API) {
    base = String(PRODUCTION_API).replace(/\/$/, "");
  }

  global.STC_API_BASE = base;
})(typeof window !== "undefined" ? window : globalThis);