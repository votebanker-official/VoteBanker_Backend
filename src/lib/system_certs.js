const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const tls = require("tls");

const EXPORT_SCRIPT = `
$out = New-Object System.Collections.Generic.List[string]
foreach ($store in 'Cert:\\LocalMachine\\Root','Cert:\\CurrentUser\\Root') {
  Get-ChildItem $store -ErrorAction SilentlyContinue | ForEach-Object {
    $b64 = [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks')
    $out.Add("-----BEGIN CERTIFICATE-----$([Environment]::NewLine)$b64$([Environment]::NewLine)-----END CERTIFICATE-----")
  }
}
[System.IO.File]::WriteAllText($env:VB_CA_OUT, ($out -join [Environment]::NewLine))
`;

function windowsRootCertificates() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vb-ca-"));
  const file = path.join(dir, "roots.pem");
  const script = path.join(dir, "export.ps1");
  fs.writeFileSync(script, EXPORT_SCRIPT, "utf8");
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    {
      env: { ...process.env, VB_CA_OUT: file },
      stdio: "ignore",
      windowsHide: true,
    }
  );
  const pem = fs.readFileSync(file, "utf8");
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
}

/**
 * Node's built-in certificate list does not include roots that Windows trusts,
 * such as a local antivirus HTTPS scanner. Outbound calls then fail before
 * Facebook or Supabase can answer. Trust the same roots as the operating
 * system, and keep certificate checking on.
 */
function installSystemCertificates() {
  if (process.platform !== "win32" || global.__vbSystemCertsInstalled) return 0;
  let extra = [];
  try {
    extra = windowsRootCertificates();
  } catch (error) {
    console.error(`system certificate load skipped: ${error.message || error}`);
    return 0;
  }
  if (extra.length === 0) return 0;
  const original = tls.createSecureContext;
  tls.createSecureContext = function createSecureContext(options = {}) {
    const current = options.ca == null ? tls.rootCertificates.slice() : [].concat(options.ca);
    return original.call(this, { ...options, ca: current.concat(extra) });
  };
  global.__vbSystemCertsInstalled = true;
  return extra.length;
}

module.exports = { installSystemCertificates };
