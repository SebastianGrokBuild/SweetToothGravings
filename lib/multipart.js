/**
 * Minimal multipart/form-data parser (no dependencies).
 */
function parseContentType(contentType) {
  const parts = String(contentType || "").split(";");
  const type = parts[0].trim().toLowerCase();
  let boundary = "";
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i].trim();
    if (p.toLowerCase().startsWith("boundary=")) {
      boundary = p.slice(9).trim();
      if (boundary[0] === '"' && boundary.at(-1) === '"') {
        boundary = boundary.slice(1, -1);
      }
      break;
    }
  }
  return { type, boundary };
}

function parsePartHeaders(headerBuf) {
  const headerText = headerBuf.toString("utf8");
  const lines = headerText.split(/\r?\n/);
  let disposition = "";
  let contentType = "";
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("content-disposition:")) disposition = line;
    if (lower.startsWith("content-type:")) contentType = line.slice(13).trim();
  }

  let name = "";
  let filename = "";
  const nameMatch = disposition.match(/name="([^"]+)"/i);
  if (nameMatch) name = nameMatch[1];
  const fileMatch = disposition.match(/filename="([^"]*)"/i);
  if (fileMatch) filename = fileMatch[1];

  return { name, filename, contentType };
}

/**
 * @returns {{ fields: Record<string, string>, files: Array<{ name: string, filename: string, mimeType: string, data: Buffer }> }}
 */
function parseMultipart(body, contentType) {
  const { type, boundary } = parseContentType(contentType);
  if (type !== "multipart/form-data" || !boundary) {
    throw new Error("Expected multipart/form-data");
  }

  const fields = {};
  const files = [];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const endBuf = Buffer.from(`--${boundary}--`);

  let pos = body.indexOf(boundaryBuf);
  if (pos === -1) throw new Error("Invalid multipart body");

  pos += boundaryBuf.length;
  if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
  else if (body[pos] === 0x0a) pos += 1;

  while (pos < body.length) {
    if (body.subarray(pos, pos + endBuf.length).equals(endBuf)) break;

    let next = body.indexOf(boundaryBuf, pos);
    if (next === -1) break;

    let partEnd = next;
    if (partEnd >= 2 && body[partEnd - 2] === 0x0d && body[partEnd - 1] === 0x0a) {
      partEnd -= 2;
    } else if (partEnd >= 1 && body[partEnd - 1] === 0x0a) {
      partEnd -= 1;
    }

    const part = body.subarray(pos, partEnd);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      pos = next + boundaryBuf.length;
      if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
      else if (body[pos] === 0x0a) pos += 1;
      continue;
    }

    const headers = part.subarray(0, headerEnd);
    const data = part.subarray(headerEnd + 4);
    const meta = parsePartHeaders(headers);

    if (meta.filename) {
      files.push({
        name: meta.name || "photos",
        filename: meta.filename,
        mimeType: meta.contentType || "application/octet-stream",
        data,
      });
    } else if (meta.name) {
      fields[meta.name] = data.toString("utf8");
    }

    pos = next + boundaryBuf.length;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else if (body[pos] === 0x0a) pos += 1;
  }

  return { fields, files };
}

module.exports = { parseMultipart, parseContentType };