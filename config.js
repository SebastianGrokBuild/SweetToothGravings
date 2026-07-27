/**
 * API base URL for order submissions.
 * deploy: 2026-07-27-insert-top-v5
 * sheet:  13ch_g0giBozxwFqh1OVV-gTEqttmfC23xU9pNYFVxRs
 * drive:  1r-3-RrGjLbE4JHO32bMCDbId4O0jwKPE
 *
 * - Local (node serve.js): leave PRODUCTION_API empty — uses same origin.
 * - GitHub Pages / static shop + API on Render: set PRODUCTION_API below.
 */
(function (global) {
  const host = (global.location && global.location.hostname) || "";

  /**
   * Node order server (serve.js) on Render — forced production targets live there.
   */
  const PRODUCTION_API = "https://sweettooth-cravings-api.onrender.com";

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
  global.STC_DEPLOY_BUILD = "2026-07-27-insert-top-v5";
  global.STC_EXPECTED_SHEET_ID = "13ch_g0giBozxwFqh1OVV-gTEqttmfC23xU9pNYFVxRs";
  global.STC_EXPECTED_DRIVE_ID = "1r-3-RrGjLbE4JHO32bMCDbId4O0jwKPE";
})(typeof window !== "undefined" ? window : globalThis);
