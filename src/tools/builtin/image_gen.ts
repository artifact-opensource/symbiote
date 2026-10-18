// Symbiote — Builtin tool: image generation

import fs from 'node:fs';
import path from 'node:path';
import { validateSvg as validateSafeSvg } from '../../security/safe-svg.js';
import type { ToolDefinition } from '../types.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]!);
}

export function validateSvg(markup: string): string {
  return validateSafeSvg(markup);
}

function paletteFor(prompt: string, style: string): { background: string; deep: string; accent: string; light: string } {
  const words = `${prompt} ${style}`.toLowerCase();
  if (/forest|garden|nature|plant|leaf|mountain|landscape/.test(words)) {
    return { background: '#142d2a', deep: '#0c1c1d', accent: '#b6d5a0', light: '#e9f0d8' };
  }
  if (/warm|sunset|desert|terracotta|orange|gold/.test(words)) {
    return { background: '#392326', deep: '#20191f', accent: '#f4b87f', light: '#f8e1bd' };
  }
  if (/purple|violet|dream|cosmic|space|night/.test(words)) {
    return { background: '#282444', deep: '#17192e', accent: '#c3b4ff', light: '#f0eaff' };
  }
  if (/blue|ocean|water|technology|tech|digital|future/.test(words)) {
    return { background: '#152d3a', deep: '#101c2a', accent: '#78d7e5', light: '#e0f3f5' };
  }
  return { background: '#263831', deep: '#17241f', accent: '#d1c58f', light: '#f4ecd2' };
}

export function composePromptSvg(prompt: string, style = '', size = '1200x800'): string {
  const sizeMatch = /^(\d{1,4})x(\d{1,4})$/.exec(size);
  if (!sizeMatch) throw new Error('Image size must use WIDTHxHEIGHT (for example, 1200x800).');
  const width = Number(sizeMatch[1]);
  const height = Number(sizeMatch[2]);
  if (width < 256 || height < 256 || width > 2048 || height > 2048 || width * height > 4_194_304) {
    throw new Error('Image dimensions must be between 256 and 2048 pixels per side, with at most 4 megapixels.');
  }

  const palette = paletteFor(prompt, style);
  const cx = Math.round(width * 0.68);
  const cy = Math.round(height * 0.47);
  const title = escapeXml(prompt.trim().slice(0, 48));
  const subtitle = escapeXml(style.trim().slice(0, 72) || 'A locally composed vector illustration');
  const isNature = /forest|garden|nature|plant|leaf|mountain|landscape/i.test(prompt);
  const illustration = isNature
    ? `<circle cx="${cx}" cy="${Math.round(height * 0.34)}" r="${Math.round(height * 0.13)}" fill="url(#sun)"/>
       <path d="M${width * 0.32} ${height} L${width * 0.65} ${height * 0.28} L${width * 0.95} ${height}Z" fill="#45645a"/>
       <path d="M${width * 0.48} ${height} L${width * 0.78} ${height * 0.48} L${width * 1.1} ${height}Z" fill="#6f8770"/>
       <path d="M${width * 0.53} ${height * 0.55} L${width * 0.65} ${height * 0.28} L${width * 0.76} ${height * 0.53} L${width * 0.69} ${height * 0.49} L${width * 0.65} ${height * 0.57} L${width * 0.61} ${height * 0.48}Z" fill="${palette.light}" opacity=".72"/>
       <path d="M0 ${height * 0.82} Q${width * 0.25} ${height * 0.70} ${width * 0.48} ${height * 0.83} T${width} ${height * 0.77} V${height} H0Z" fill="#203d35"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${height * 0.25}" fill="url(#sun)" opacity=".9"/>
       <circle cx="${cx}" cy="${cy}" r="${height * 0.18}" fill="none" stroke="${palette.light}" stroke-opacity=".36" stroke-width="1.5"/>
       <circle cx="${cx}" cy="${cy}" r="${height * 0.29}" fill="none" stroke="${palette.accent}" stroke-opacity=".38" stroke-width="1" stroke-dasharray="2 9"/>
       <path d="M${cx - height * 0.12} ${cy} C${cx - height * 0.02} ${cy - height * 0.18}, ${cx + height * 0.07} ${cy + height * 0.18}, ${cx + height * 0.16} ${cy - height * 0.04}" fill="none" stroke="${palette.light}" stroke-width="3" stroke-linecap="round"/>
       <circle cx="${cx - height * 0.12}" cy="${cy}" r="5" fill="${palette.accent}"/><circle cx="${cx + height * 0.16}" cy="${cy - height * 0.04}" r="5" fill="${palette.light}"/>`;

  return `<svg xmlns="${SVG_NAMESPACE}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${title}</title><desc id="description">${subtitle}</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${palette.background}"/><stop offset="1" stop-color="${palette.deep}"/></linearGradient>
    <radialGradient id="sun"><stop stop-color="${palette.light}" stop-opacity=".96"/><stop offset=".48" stop-color="${palette.accent}" stop-opacity=".62"/><stop offset="1" stop-color="${palette.accent}" stop-opacity="0"/></radialGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="${palette.light}" stroke-opacity=".055" stroke-width="1"/></pattern>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop stop-color="${palette.light}" stop-opacity=".88"/><stop offset="1" stop-color="${palette.accent}" stop-opacity=".42"/></linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#background)"/><rect width="100%" height="100%" fill="url(#grid)"/>
  <circle cx="${cx}" cy="${cy}" r="${height * 0.43}" fill="url(#sun)" opacity=".19"/>
  <g>${illustration}</g>
  <path d="M${width * 0.08} ${height * 0.15} H${width * 0.2}" stroke="${palette.accent}" stroke-width="3" stroke-linecap="round"/>
  <text x="${width * 0.08}" y="${height * 0.30}" fill="${palette.light}" font-family="Inter,Segoe UI,sans-serif" font-size="${Math.round(height * 0.065)}" font-weight="600" letter-spacing="-1">${title}</text>
  <text x="${width * 0.08}" y="${height * 0.37}" fill="${palette.light}" fill-opacity=".66" font-family="Inter,Segoe UI,sans-serif" font-size="${Math.round(height * 0.022)}" letter-spacing="2">${subtitle}</text>
  <text x="${width * 0.08}" y="${height * 0.91}" fill="${palette.accent}" fill-opacity=".75" font-family="monospace" font-size="${Math.round(height * 0.014)}" letter-spacing="2">SYMBIOTE · LOCAL VECTOR STUDIO</text>
</svg>`;
}

function safeFilename(prompt: string, requested?: string): string {
  const source = requested?.replace(/\.svg$/i, '') || prompt.slice(0, 50);
  const slug = source.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'illustration';
  return `${slug}-${Date.now()}.svg`;
}

export function createImageGenTool(outputDirectory?: string): ToolDefinition {
  return {
    name: 'image_gen',
    description: 'Create original illustrations entirely locally as safe, editable SVG files. For custom art, pass detailed SVG markup in svg (include an SVG namespace and viewBox); use prompt/style/size for a polished built-in composition. No hosted model or network API is used.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Image concept, subject, composition, and intended mood.' },
        svg: { type: 'string', description: 'Optional complete SVG vector markup. Use layered shapes, gradients, paths, lighting, and typography for a custom design. Scripts, external images, links, and unsafe elements are rejected.' },
        style: { type: 'string', description: 'Optional artistic direction or subtitle for the local composition.' },
        size: { type: 'string', description: 'Output canvas size WIDTHxHEIGHT, 256–2048 px per side; defaults to 1200x800.' },
        filename: { type: 'string', description: 'Optional local output name; path components are removed and .svg is added.' },
      },
      required: ['prompt'],
    },
    idempotency: {
      class: 'reversible_local',
      reverseDescription: 'To reverse, delete the generated SVG file from the output directory. The original content can be recovered if a backup exists.',
      idempotencyKey: (input) => {
        const prompt = String(input.prompt ?? '');
        const style = String(input.style ?? '');
        const size = String(input.size ?? '');
        const filename = String(input.filename ?? '');
        return `image_gen:${prompt.slice(0, 64)}:${style}:${size}:${filename}`;
      },
    },
    async execute(input) {
      const prompt = String(input.prompt ?? '').trim();
      if (!prompt) throw new Error('prompt is required for local image generation.');
      const size = String(input.size ?? '1200x800');
      const customSvg = typeof input.svg === 'string' && input.svg.trim().length > 0;
      const markup = validateSvg(customSvg
        ? String(input.svg)
        : composePromptSvg(prompt, String(input.style ?? ''), size));
      const destination = path.resolve(outputDirectory ?? path.join(process.cwd(), 'generated-images'));
      fs.mkdirSync(destination, { recursive: true });
      const filePath = path.join(destination, safeFilename(prompt, String(input.filename ?? '')));
      fs.writeFileSync(filePath, markup, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return JSON.stringify({
        status: 'success',
        format: 'SVG',
        path: filePath,
        local: true,
        vectorMarkup: customSvg ? 'validated and saved' : 'locally composed and saved',
      });
    },
  };
}

export const imageGenTool = createImageGenTool();