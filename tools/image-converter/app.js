// ---- Configuration: fill these in after deploying services/image-converter ----
const API_BASE_URL = "https://api.ryaneng.land";
// NOTE: the reCAPTCHA site key also needs to be set directly in index.html's
// two data-sitekey attributes (Google's widget reads it from the HTML, not JS).
const RECAPTCHA_SITE_KEY = "6LdgUdgtAAAAAL4GhtiQ4PAvP_9rPa_WEOfaVX1-";
// --------------------------------------------------------------------------

// Keep in sync with services/image-converter/src/common/formats.py
const TARGET_FORMATS = [
  "jpg", "jpeg", "png", "gif", "webp", "tiff", "psd", "bmp",
  "heic", "jp2",
];

const SESSION_STORAGE_KEY = "ic_session_token";
// Local-only escape hatch: set via the console with
// localStorage.setItem('ic_dev_bypass', '<secret from SSM image-converter-dev-bypass-secret>')
// Never hardcode the secret here -- this file is served to every site visitor.
const DEV_BYPASS_STORAGE_KEY = "ic_dev_bypass";

function isLocalhost() {
  return ["localhost", "127.0.0.1"].includes(location.hostname);
}

function getDevBypassSecret() {
  return isLocalhost() ? localStorage.getItem(DEV_BYPASS_STORAGE_KEY) : null;
}

// The registered reCAPTCHA site key doesn't cover localhost, so loading the
// widget there only ever shows an error box -- skip it and rely on the
// dev-bypass secret (see getDevBypassSecret) for local testing instead.
if (!isLocalhost()) {
  const script = document.createElement("script");
  script.src = "https://www.google.com/recaptcha/api.js";
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

let verifyCaptchaToken = null;
let requestCaptchaToken = null;

function icOnVerifyCaptcha(token) {
  verifyCaptchaToken = token;
  document.querySelector("#ic-verify-form button").disabled = false;
}

function icOnRequestCaptcha(token) {
  requestCaptchaToken = token;
  document.querySelector("#ic-request-form button").disabled = false;
}
window.icOnVerifyCaptcha = icOnVerifyCaptcha;
window.icOnRequestCaptcha = icOnRequestCaptcha;

function getStoredToken() {
  const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.expiresAt > Date.now()) return parsed.token;
  } catch (err) {
    // ignore malformed storage
  }
  return null;
}

function storeToken(token, expiresIn) {
  sessionStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({ token, expiresAt: Date.now() + expiresIn * 1000 })
  );
}

function showTool() {
  document.getElementById("ic-gate").hidden = true;
  const toolSection = document.getElementById("ic-tool");
  toolSection.hidden = false;
  const select = document.getElementById("ic-target");
  select.innerHTML = TARGET_FORMATS.map((f) => `<option value="${f}">${f}</option>`).join("");
}

async function apiFetch(path, options = {}) {
  const token = getStoredToken();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const devBypass = getDevBypassSecret();
  if (devBypass) headers["X-Dev-Bypass"] = devBypass;
  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

document.addEventListener("DOMContentLoaded", () => {
  if (getStoredToken()) showTool();

  if (isLocalhost()) {
    document.querySelectorAll(".g-recaptcha").forEach((el) => {
      el.hidden = true;
    });
  }

  if (getDevBypassSecret()) {
    document.querySelector("#ic-verify-form button").disabled = false;
    document.querySelector("#ic-request-form button").disabled = false;
  }

  document.getElementById("ic-verify-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById("ic-verify-error");
    errorEl.textContent = "";
    const code = document.getElementById("ic-code").value.trim();

    try {
      const result = await apiFetch("/verify", {
        method: "POST",
        body: JSON.stringify({ code, captchaToken: verifyCaptchaToken }),
      });
      storeToken(result.token, result.expiresIn);
      showTool();
    } catch (err) {
      errorEl.textContent = err.message;
      if (window.grecaptcha) window.grecaptcha.reset();
      verifyCaptchaToken = null;
      document.querySelector("#ic-verify-form button").disabled = true;
    }
  });

  document.getElementById("ic-request-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById("ic-request-error");
    const successEl = document.getElementById("ic-request-success");
    errorEl.textContent = "";
    successEl.textContent = "";

    const form = event.target;
    const payload = {
      name: form.name.value.trim(),
      email: form.email.value.trim(),
      reason: form.reason.value.trim(),
      website: form.website.value, // honeypot, should stay empty
      captchaToken: requestCaptchaToken,
    };

    try {
      const result = await apiFetch("/request-access", { method: "POST", body: JSON.stringify(payload) });
      successEl.textContent = result.message;
      form.reset();
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      if (window.grecaptcha) window.grecaptcha.reset();
      requestCaptchaToken = null;
      document.querySelector("#ic-request-form button").disabled = true;
    }
  });

  document.getElementById("ic-convert-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const statusEl = document.getElementById("ic-status");
    const fileInput = document.getElementById("ic-file");
    const targetFormat = document.getElementById("ic-target").value;
    const file = fileInput.files[0];

    if (!file) return;

    try {
      statusEl.textContent = "Requesting upload URL…";
      const { uploadUrl, key, maxBytes } = await apiFetch("/uploads", {
        method: "POST",
        body: JSON.stringify({ filename: file.name }),
      });

      if (file.size > maxBytes) {
        statusEl.textContent = `File is too large (max ${(maxBytes / 1024 / 1024).toFixed(0)}MB).`;
        return;
      }

      statusEl.textContent = "Uploading…";
      const putResponse = await fetch(uploadUrl, { method: "PUT", body: file });
      if (!putResponse.ok) throw new Error("Upload failed.");

      statusEl.textContent = "Converting…";
      const { jobId } = await apiFetch("/convert", {
        method: "POST",
        body: JSON.stringify({ key, targetFormat }),
      });

      await pollJob(jobId, statusEl);
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    }
  });
});

async function pollJob(jobId, statusEl) {
  const maxAttempts = 30;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await apiFetch(`/jobs/${jobId}`);
    if (result.status === "DONE") {
      statusEl.innerHTML = `Done! <a href="${result.downloadUrl}">Download result</a>`;
      return;
    }
    if (result.status === "ERROR") {
      statusEl.textContent = `Conversion failed: ${result.error}`;
      return;
    }
    statusEl.textContent = "Converting…";
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  statusEl.textContent = "Still working — check back in a bit.";
}
