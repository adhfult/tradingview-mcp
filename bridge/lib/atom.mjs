/**
 * Strict Atom/RSS extractor.
 * Public API: parseFeed(responseText, limits) returns plain
 * `{ entries: [{ id, title, link, updated, summary }], skipped: [{ index, reason }] }`.
 * Entry validation failures are skipped; invalid documents still throw.
 * Limits are `maxBytes`, `maxEntries`, and `maxFieldLength`.
 */

const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxEntries: 100,
  maxFieldLength: 16 * 1024,
});

const MAX_XML_DEPTH = 64;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const PREDEFINED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  apos: "'",
  quot: '"',
});
const OUTPUT_FIELDS = Object.freeze(['id', 'title', 'link', 'updated', 'summary']);

function invalidFeed(message) {
  return new Error(`Invalid feed: ${message}`);
}

function limitValue(limits, name) {
  const value = limits[name] ?? DEFAULT_LIMITS[name];
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function cleanControls(value) {
  return value.replace(CONTROL_CHARACTERS, '');
}

function isXmlSpace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function isNameStart(char) {
  if (!char) return false;
  const code = char.codePointAt(0);
  return (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x5f
    || code >= 0x80;
}

function isNameCharacter(char) {
  if (isNameStart(char)) return true;
  const code = char.codePointAt(0);
  return (code >= 0x30 && code <= 0x39)
    || char === '-'
    || char === '.'
    || char === ':';
}

function readName(source, offset) {
  let end = offset;
  while (end < source.length && isNameCharacter(source[end])) end += 1;
  if (end === offset || !isNameStart(source[offset])) {
    throw invalidFeed(`malformed XML name at offset ${offset}`);
  }
  const name = source.slice(offset, end);
  const firstColon = name.indexOf(':');
  if (firstColon === 0 || firstColon === name.length - 1
    || (firstColon !== -1 && name.indexOf(':', firstColon + 1) !== -1)) {
    throw invalidFeed(`malformed qualified XML name at offset ${offset}`);
  }
  return { name, end };
}

function localName(name) {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function validXmlCodePoint(codePoint) {
  return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

function decodeEntities(value) {
  let output = '';
  let offset = 0;
  while (offset < value.length) {
    const ampersand = value.indexOf('&', offset);
    if (ampersand === -1) {
      output += value.slice(offset);
      break;
    }
    output += value.slice(offset, ampersand);
    const semicolon = value.indexOf(';', ampersand + 1);
    if (semicolon === -1) throw invalidFeed('unterminated entity reference');
    const reference = value.slice(ampersand + 1, semicolon);
    if (Object.hasOwn(PREDEFINED_ENTITIES, reference)) {
      output += PREDEFINED_ENTITIES[reference];
    } else if (reference.startsWith('#')) {
      let digits = reference.slice(1);
      let radix = 10;
      if (digits.startsWith('x') || digits.startsWith('X')) {
        digits = digits.slice(1);
        radix = 16;
      }
      if (digits === '' || (radix === 10 ? !/^[0-9]+$/.test(digits) : !/^[0-9a-fA-F]+$/.test(digits))) {
        throw invalidFeed('invalid numeric character reference');
      }
      const codePoint = Number.parseInt(digits, radix);
      if (!Number.isSafeInteger(codePoint) || !validXmlCodePoint(codePoint)) {
        throw invalidFeed('invalid numeric character reference');
      }
      output += String.fromCodePoint(codePoint);
    } else {
      throw invalidFeed('unknown entity reference');
    }
    offset = semicolon + 1;
  }
  return output;
}

function readStartTag(source, offset) {
  const parsedName = readName(source, offset);
  const attributes = Object.create(null);
  let index = parsedName.end;

  while (index < source.length) {
    while (isXmlSpace(source[index])) index += 1;
    if (source.startsWith('/>', index)) {
      return { name: parsedName.name, attributes, end: index + 2, selfClosing: true };
    }
    if (source[index] === '>') {
      return { name: parsedName.name, attributes, end: index + 1, selfClosing: false };
    }
    if (index >= source.length) break;

    const parsedAttribute = readName(source, index);
    index = parsedAttribute.end;
    while (isXmlSpace(source[index])) index += 1;
    if (source[index] !== '=') throw invalidFeed(`expected '=' after attribute ${parsedAttribute.name}`);
    index += 1;
    while (isXmlSpace(source[index])) index += 1;
    const quote = source[index];
    if (quote !== '"' && quote !== "'") throw invalidFeed(`attribute ${parsedAttribute.name} must be quoted`);
    index += 1;
    const valueEnd = source.indexOf(quote, index);
    if (valueEnd === -1) throw invalidFeed(`unterminated attribute ${parsedAttribute.name}`);
    const rawValue = source.slice(index, valueEnd);
    if (rawValue.includes('<')) throw invalidFeed(`attribute ${parsedAttribute.name} contains '<'`);
    if (Object.hasOwn(attributes, parsedAttribute.name)) {
      throw invalidFeed(`duplicate XML attribute ${parsedAttribute.name}`);
    }
    attributes[parsedAttribute.name] = cleanControls(decodeEntities(rawValue));
    index = valueEnd + 1;
  }

  throw invalidFeed(`truncated start tag <${parsedName.name}>`);
}

function atomField(name) {
  if (name === 'id' || name === 'title' || name === 'updated' || name === 'summary') return name;
  return null;
}

function rssField(name) {
  if (name === 'id' || name === 'guid') return 'id';
  if (name === 'title') return 'title';
  if (name === 'link') return 'link';
  if (name === 'updated' || name === 'pubDate') return 'updated';
  if (name === 'summary' || name === 'description') return 'summary';
  return null;
}

function secureLink(value) {
  const link = value.trim();
  let parsed;
  try {
    parsed = new URL(link);
  } catch {
    throw invalidFeed('entry link must be an absolute HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === '') {
    throw invalidFeed('entry link must use https');
  }
  const authorityStart = parsed.href.indexOf('://') + 3;
  const authority = parsed.href.slice(authorityStart).split(/[/?#]/u, 1)[0];
  if (parsed.username !== '' || parsed.password !== '' || authority.includes('@')) {
    throw invalidFeed('entry link credentials are not allowed');
  }
  return link;
}

function parseEntry(entry, format, limits) {
  const fields = entry.fields;
  if (format === 'rss' && fields.id === undefined && fields.link !== undefined) {
    fields.id = fields.link;
  }
  const output = {};
  for (const name of OUTPUT_FIELDS) {
    const value = fields[name];
    if (typeof value !== 'string' || value.trim() === '') {
      throw invalidFeed(`entry is missing required field "${name}"`);
    }
    if (value.length > limits.maxFieldLength) {
      throw invalidFeed(`entry ${name} exceeds maxFieldLength (${limits.maxFieldLength})`);
    }
    output[name] = value;
  }
  output.link = secureLink(output.link);
  return output;
}

/** Parse an untrusted Atom or RSS response string into bounded, plain entries. */
export function parseFeed(responseText, limits = {}) {
  if (typeof responseText !== 'string') throw new TypeError('responseText must be a string');
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new TypeError('limits must be an object');
  }
  const resolvedLimits = {
    maxBytes: limitValue(limits, 'maxBytes'),
    maxEntries: limitValue(limits, 'maxEntries'),
    maxFieldLength: limitValue(limits, 'maxFieldLength'),
  };
  if (Buffer.byteLength(responseText, 'utf8') > resolvedLimits.maxBytes) {
    throw invalidFeed(`response exceeds maxBytes (${resolvedLimits.maxBytes})`);
  }

  const upper = responseText.toUpperCase();
  if (upper.includes('<!DOCTYPE') || upper.includes('<!ENTITY')) {
    throw invalidFeed('DOCTYPE and ENTITY declarations are not allowed');
  }

  let offset = 0;
  let rootName = null;
  let rootPrefix = '';
  let rootType = null;
  let rootClosed = false;
  let rssChannelCount = 0;
  const entries = [];
  const skipped = [];
  let entryCount = 0;
  const stack = [];

  function appendText(raw, cdata = false) {
    if (stack.length === 0) {
      if (raw.trim() !== '') throw invalidFeed('text is not allowed outside the document element');
      return;
    }
    const activeField = stack.at(-1).entry?.activeField;
    const decoded = cleanControls(cdata ? raw : decodeEntities(raw));
    if (activeField === null || activeField === undefined) return;
    if (activeField.length + decoded.length > resolvedLimits.maxFieldLength) {
      stack.at(-1).entry.error ??= `entry ${activeField.name} exceeds maxFieldLength (${resolvedLimits.maxFieldLength})`;
      return;
    }
    activeField.chunks.push(decoded);
    activeField.length += decoded.length;
  }

  function finishEntry(entry) {
    if (entry.activeField !== null) throw invalidFeed('truncated XML inside an entry field');
    try {
      if (entry.error) throw invalidFeed(entry.error);
      entries.push(parseEntry(entry, rootType, resolvedLimits));
    } catch (err) {
      skipped.push({ index: entry.index, reason: err.message });
    }
  }

  function closeElement(node) {
    stack.pop();
    if (node.fieldCapture !== null) {
      const value = cleanControls(node.fieldCapture.chunks.join('')).trim();
      node.entry.fields[node.fieldCapture.name] = value;
      node.entry.activeField = null;
    }
    if (node.isEntry) finishEntry(node.entry);
    if (stack.length === 0) rootClosed = true;
  }

  while (offset < responseText.length) {
    if (responseText[offset] !== '<') {
      const nextTag = responseText.indexOf('<', offset);
      const end = nextTag === -1 ? responseText.length : nextTag;
      appendText(responseText.slice(offset, end));
      offset = end;
      continue;
    }

    if (responseText.startsWith('<!--', offset)) {
      const end = responseText.indexOf('-->', offset + 4);
      if (end === -1) throw invalidFeed('truncated XML comment');
      if (responseText.slice(offset + 4, end).includes('--')) throw invalidFeed('malformed XML comment');
      offset = end + 3;
      continue;
    }
    if (responseText.startsWith('<![CDATA[', offset)) {
      if (stack.length === 0) throw invalidFeed('CDATA is not allowed outside the document element');
      const end = responseText.indexOf(']]>', offset + 9);
      if (end === -1) throw invalidFeed('truncated CDATA section');
      appendText(responseText.slice(offset + 9, end), true);
      offset = end + 3;
      continue;
    }
    if (responseText.startsWith('<?', offset)) {
      const end = responseText.indexOf('?>', offset + 2);
      if (end === -1) throw invalidFeed('truncated processing instruction');
      offset = end + 2;
      continue;
    }
    if (responseText.startsWith('</', offset)) {
      const parsedName = readName(responseText, offset + 2);
      let end = parsedName.end;
      while (isXmlSpace(responseText[end])) end += 1;
      if (responseText[end] !== '>') throw invalidFeed(`malformed closing tag </${parsedName.name}>`);
      const node = stack.at(-1);
      if (node === undefined || node.name !== parsedName.name) {
        throw invalidFeed(`mismatched or unexpected closing tag </${parsedName.name}>`);
      }
      closeElement(node);
      offset = end + 1;
      continue;
    }
    if (responseText.startsWith('<!', offset)) {
      throw invalidFeed('unsupported XML declaration');
    }

    const parsedTag = readStartTag(responseText, offset + 1);
    const name = localName(parsedTag.name);
    const parent = stack.at(-1);
    let entry = parent?.entry ?? null;
    let isEntry = false;
    let isRoot = false;

    if (parent === undefined) {
      if (rootName !== null || rootClosed) throw invalidFeed('XML must contain exactly one document element');
      rootName = name;
      rootPrefix = parsedTag.name.includes(':') ? parsedTag.name.split(':')[0] : '';
      rootType = name === 'feed' ? 'atom' : name === 'rss' ? 'rss' : null;
      if (rootType === null) throw invalidFeed(`unsupported document element <${name}>`);
      isRoot = true;
    } else {
      if (rootClosed) throw invalidFeed('XML must contain exactly one document element');
      if (rootType === 'atom' && stack.length === 1 && parent.localName === 'feed' && name === 'entry'
        && (!parsedTag.name.includes(':') || parsedTag.name.split(':')[0] === rootPrefix)) {
        isEntry = true;
      }
      if (rootType === 'rss' && stack.length === 1 && parent.localName === 'rss' && parsedTag.name === 'channel') {
        rssChannelCount += 1;
        if (rssChannelCount > 1) throw invalidFeed('RSS document must contain one channel');
      }
      if (rootType === 'rss' && stack.length === 2
        && stack[0].localName === 'rss' && parent.localName === 'channel' && parsedTag.name === 'item') {
        isEntry = true;
      }
    }

    let fieldCapture = null;
    if (isEntry) {
      if (entryCount >= resolvedLimits.maxEntries) {
        throw invalidFeed(`feed exceeds maxEntries (${resolvedLimits.maxEntries})`);
      }
      entry = { fields: Object.create(null), activeField: null, index: entryCount++ };
    } else if (parent?.isEntry && entry !== null
      && (!parsedTag.name.includes(':') || (rootType === 'atom' && parsedTag.name.split(':')[0] === rootPrefix))) {
      if (rootType === 'atom' && name === 'link') {
        const rel = parsedTag.attributes.rel ?? 'alternate';
        if (rel === 'alternate' && entry.fields.link === undefined) {
          if (parsedTag.attributes.href !== undefined) entry.fields.link = parsedTag.attributes.href.trim();
        }
      } else {
        const fieldName = rootType === 'atom' ? atomField(name) : rssField(name);
        if (fieldName !== null) {
          if (entry.fields[fieldName] !== undefined || entry.activeField !== null) {
            entry.error ??= `entry contains duplicate ${fieldName} field`;
          }
          fieldCapture = { name: fieldName, chunks: [], length: 0 };
          entry.activeField = fieldCapture;
        }
      }
    }

    if (stack.length >= MAX_XML_DEPTH) throw invalidFeed(`XML nesting exceeds ${MAX_XML_DEPTH} levels`);
    const node = {
      name: parsedTag.name,
      localName: name,
      entry,
      fieldCapture,
      isEntry,
      isRoot,
    };
    stack.push(node);
    offset = parsedTag.end;
    if (parsedTag.selfClosing) closeElement(node);
  }

  if (stack.length > 0) throw invalidFeed(`truncated XML: unclosed <${stack.at(-1).name}>`);
  if (rootName === null) throw invalidFeed('empty XML document');
  if (!rootClosed) throw invalidFeed(`truncated XML: unclosed <${rootName}>`);
  if (rootType === 'rss' && rssChannelCount !== 1) throw invalidFeed('RSS document is missing its channel');
  return { entries, skipped };
}
