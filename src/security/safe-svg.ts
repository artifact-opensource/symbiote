const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'filter',
  'feGaussianBlur', 'feOffset', 'feMerge', 'feMergeNode', 'feColorMatrix',
  'feComponentTransfer', 'feFuncA', 'feFuncR', 'feFuncG', 'feFuncB', 'feBlend',
  'feComposite', 'text', 'tspan', 'title', 'desc', 'pattern', 'marker',
]);
const SVG_ATTRIBUTES = new Set([
  'xmlns', 'xmlns:xlink', 'id', 'class', 'role', 'aria-labelledby', 'aria-label', 'viewBox',
  'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd',
  'points', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'opacity',
  'transform', 'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'stop-color',
  'stop-opacity', 'clip-path', 'clip-rule', 'mask', 'filter', 'stdDeviation', 'dx', 'dy',
  'result', 'in', 'in2', 'type', 'values', 'mode', 'operator', 'text-anchor',
  'dominant-baseline', 'font-family', 'font-size', 'font-weight', 'letter-spacing',
  'textLength', 'lengthAdjust', 'patternUnits', 'patternTransform', 'markerWidth',
  'markerHeight', 'refX', 'refY', 'orient', 'href', 'xlink:href', 'style',
]);
const XML_ENTITIES = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i;

function validateAttributes(source: string, tagName: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? '')) cursor++;
    if (cursor === source.length) break;
    const nameMatch = /^[A-Za-z_:][A-Za-z0-9:_.-]*/.exec(source.slice(cursor));
    if (!nameMatch) throw new Error(`Invalid SVG attribute near "${source.slice(cursor, cursor + 20)}".`);
    const name = nameMatch[0];
    cursor += name.length;
    while (/\s/.test(source[cursor] ?? '')) cursor++;
    if (source[cursor] !== '=') throw new Error(`SVG attribute "${name}" must have a value.`);
    cursor++;
    while (/\s/.test(source[cursor] ?? '')) cursor++;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") throw new Error(`SVG attribute "${name}" must be quoted.`);
    cursor++;
    const valueStart = cursor;
    while (cursor < source.length && source[cursor] !== quote) cursor++;
    if (cursor >= source.length) throw new Error(`Unclosed SVG attribute "${name}".`);
    const value = source.slice(valueStart, cursor);
    cursor++;

    if (!SVG_ATTRIBUTES.has(name) || /^on/i.test(name)) throw new Error(`SVG attribute "${name}" is not allowed.`);
    if (XML_ENTITIES.test(value)) throw new Error(`SVG attribute "${name}" contains an invalid XML entity.`);
    if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) {
      throw new Error('SVG links must refer only to an element inside the same image.');
    }
    if (/url\s*\(/i.test(value) && !/url\(\s*['"]?#[-\w:.]+['"]?\s*\)/i.test(value)) {
      throw new Error(`SVG attribute "${name}" cannot reference external resources.`);
    }
    if (/javascript:|expression\s*\(|@import/i.test(value)) throw new Error(`Unsafe SVG value in "${name}".`);
    if (name === 'xmlns' && value !== SVG_NAMESPACE) throw new Error('SVG must use the standard SVG namespace.');
    attributes[name] = value;
  }
  if (tagName === 'svg' && attributes.xmlns !== SVG_NAMESPACE) {
    throw new Error('SVG root must declare xmlns="http://www.w3.org/2000/svg".');
  }
  return attributes;
}

export function validateSvg(markup: string): string {
  if (Buffer.byteLength(markup, 'utf8') > 1_000_000) throw new Error('SVG markup must be 1 MiB or smaller.');
  if (/<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|iframe|image|audio|video)\b/i.test(markup)) {
    throw new Error('SVG contains an unsupported or executable element.');
  }

  const source = markup.replace(/<!--[\s\S]*?-->/g, '').trim();
  const stack: string[] = [];
  let cursor = 0;
  let rootSeen = false;
  let rootClosed = false;
  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    const text = source.slice(cursor, open < 0 ? source.length : open);
    if (XML_ENTITIES.test(text)) throw new Error('SVG text contains an invalid XML entity.');
    if (open < 0) break;
    if (source.startsWith('<?xml', open) && !rootSeen) {
      const declarationEnd = source.indexOf('?>', open + 5);
      if (declarationEnd < 0) throw new Error('SVG XML declaration is not closed.');
      cursor = declarationEnd + 2;
      continue;
    }
    if (source.startsWith('<!', open)) throw new Error('SVG declarations and entity definitions are not allowed.');

    let quote = '';
    let end = open + 1;
    for (; end < source.length; end++) {
      const character = source[end];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
    }
    if (end >= source.length || quote) throw new Error('SVG contains an unclosed element.');
    const token = source.slice(open, end + 1);
    const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)([\s\S]*?)\s*(\/?)>$/.exec(token);
    if (!match) throw new Error('SVG contains malformed markup.');
    const [, closing, tagName, attributesSource, selfClosing] = match;
    if (!SVG_TAGS.has(tagName)) throw new Error(`SVG element "${tagName}" is not allowed.`);
    if (closing) {
      if (attributesSource.trim() || selfClosing || stack.pop() !== tagName) throw new Error(`Mismatched SVG closing tag "${tagName}".`);
      if (stack.length === 0) rootClosed = true;
    } else {
      if (rootClosed) throw new Error('SVG must contain only one root element.');
      if (!rootSeen) {
        if (tagName !== 'svg') throw new Error('SVG markup must begin with an <svg> root element.');
        rootSeen = true;
      }
      validateAttributes(attributesSource, tagName);
      if (!selfClosing) stack.push(tagName);
      else if (stack.length === 0) rootClosed = true;
    }
    cursor = end + 1;
  }
  if (!rootSeen || !rootClosed || stack.length) throw new Error('SVG markup must have one complete <svg> root element.');
  return source;
}
