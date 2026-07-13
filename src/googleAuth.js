// Builds Google auth options that work BOTH locally and on a cloud host.
//
//   • Local:   a service-account JSON *file* at config.googleKeyFile.
//   • Cloud:   the JSON *contents* in the GOOGLE_SERVICE_ACCOUNT_JSON env var
//              (Railway/Heroku/etc., where committing a key file is unsafe and
//              gitignored files aren't uploaded).
//
// The env var wins if set. Returns an object you spread into new
// google.auth.GoogleAuth({ ...authOptions(config), scopes }).

const fs = require('fs');

function authOptions(config) {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) {
    let credentials;
    try {
      credentials = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        'GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid JSON. Paste the ' +
          'entire contents of the service-account key file as the value.'
      );
    }
    return { credentials };
  }

  if (!fs.existsSync(config.googleKeyFile)) {
    throw new Error(
      `No Google credentials found. Either set GOOGLE_SERVICE_ACCOUNT_JSON (the ` +
        `key file's contents) or place the key file at ${config.googleKeyFile}.`
    );
  }
  return { keyFile: config.googleKeyFile };
}

module.exports = { authOptions };
