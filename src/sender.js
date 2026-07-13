// Builds a WhatsApp message from a schedule entry and sends it, with retries.
// Media is inferred from the URL's file extension.

const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mediaKindFromUrl(url) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return 'image';
  if (['.gif'].includes(ext)) return 'video'; // WA treats gif as short video
  if (['.mp4', '.mov', '.3gp', '.mkv'].includes(ext)) return 'video';
  if (['.mp3', '.ogg', '.m4a', '.wav', '.opus'].includes(ext)) return 'audio';
  return 'document';
}

// Turn an entry into a Baileys message content object.
function buildContent(entry) {
  if (!entry.mediaUrl) {
    return { text: entry.message };
  }
  const kind = mediaKindFromUrl(entry.mediaUrl);
  const caption = entry.message || undefined;
  switch (kind) {
    case 'image':
      return { image: { url: entry.mediaUrl }, caption };
    case 'video':
      return { video: { url: entry.mediaUrl }, caption };
    case 'audio':
      return { audio: { url: entry.mediaUrl }, mimetype: 'audio/mp4' };
    default:
      return {
        document: { url: entry.mediaUrl },
        fileName: path.basename(new URL(entry.mediaUrl).pathname) || 'file',
        caption,
      };
  }
}

/**
 * Send one entry. Retries on failure with exponential-ish backoff.
 * Returns { ok, attempts, error? }.
 */
async function sendEntry(sock, entry, config) {
  const content = buildContent(entry);

  if (config.dryRun) {
    const preview = entry.mediaUrl
      ? `[media ${entry.mediaUrl}] ${entry.message}`
      : entry.message;
    console.log(`  [DRY RUN] would send to ${entry.groupName}: "${preview}"`);
    return { ok: true, attempts: 0, dryRun: true };
  }

  const maxAttempts = config.maxRetries + 1;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Brief "composing" presence looks more human than an instant send.
      try {
        await sock.sendPresenceUpdate('composing', entry.jid);
        await sleep(800 + Math.floor(Math.random() * 1200));
        await sock.sendPresenceUpdate('paused', entry.jid);
      } catch (_) {
        /* presence is best-effort */
      }

      await sock.sendMessage(entry.jid, content);
      return { ok: true, attempts: attempt };
    } catch (err) {
      lastErr = err;
      console.error(
        `  ✗ send to ${entry.groupName} failed (attempt ${attempt}/${maxAttempts}): ${err.message}`
      );
      if (attempt < maxAttempts) {
        await sleep(2000 * attempt + Math.floor(Math.random() * 2000));
      }
    }
  }
  return { ok: false, attempts: maxAttempts, error: lastErr?.message || 'unknown error' };
}

module.exports = { sendEntry, buildContent, mediaKindFromUrl, sleep };
