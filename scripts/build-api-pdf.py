#!/usr/bin/env python3
"""Build the frontend API guide from the exported OpenAPI and public Supabase configuration.

Requires reportlab, pdfplumber and pypdf. Never reads .env, .dev.vars, secrets or
server credentials. Example tokens are replaced with explicit placeholders.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import subprocess
from datetime import datetime
from html import escape
from pathlib import Path
from urllib.parse import urlencode, urlparse
from zoneinfo import ZoneInfo

import pdfplumber
from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Flowable, Frame, KeepTogether, PageBreak, PageTemplate,
    Paragraph, Spacer, Table, TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FONTS = Path('/Users/surajsingh/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/fonts')
NAVY = colors.HexColor('#142D43')
TEAL = colors.HexColor('#087F83')
SLATE = colors.HexColor('#526474')
INK = colors.HexColor('#263B4B')
PALE = colors.HexColor('#F1F6F8')
LINE = colors.HexColor('#D8E4E9')
WHITE = colors.white
METHOD_COLOR = {'GET': TEAL, 'POST': colors.HexColor('#22654D'), 'PATCH': colors.HexColor('#705197'), 'DELETE': colors.HexColor('#A74850')}
PAGE_W, PAGE_H = A4
MARGIN = 39
WIDTH = PAGE_W - 2 * MARGIN
METHODS = {'get', 'post', 'patch', 'delete', 'put', 'head', 'options'}


def clean(value):
    return str(value).translate(str.maketrans({'\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2212': '-', '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u00a0': ' '}))


def register_fonts(directory):
    names = {'Body': 'Ubuntu-R.ttf', 'Bold': 'Ubuntu-B.ttf', 'Italic': 'Ubuntu-RI.ttf', 'Mono': 'SourceCodePro-Regular.ttf'}
    if not all((directory / filename).exists() for filename in names.values()):
        return {'Body': 'Helvetica', 'Bold': 'Helvetica-Bold', 'Italic': 'Helvetica-Oblique', 'Mono': 'Courier'}
    for name, filename in names.items():
        pdfmetrics.registerFont(TTFont(name, str(directory / filename)))
    pdfmetrics.registerFontFamily('Body', normal='Body', bold='Bold', italic='Italic', boldItalic='Bold')
    return {name: name for name in names}


def resolve(spec, node):
    if not isinstance(node, dict):
        return node
    if '$ref' in node:
        if not node['$ref'].startswith('#/'):
            raise ValueError('Only local OpenAPI references are supported')
        target = spec
        for part in node['$ref'][2:].split('/'):
            target = target[part.replace('~1', '/').replace('~0', '~')]
        return {**resolve(spec, target), **{k: v for k, v in node.items() if k != '$ref'}}
    return node


def typename(spec, schema):
    if '$ref' in schema:
        return schema['$ref'].split('/')[-1]
    schema = resolve(spec, schema)
    if 'anyOf' in schema or 'oneOf' in schema:
        return ' | '.join(typename(spec, item) for item in schema.get('anyOf', schema.get('oneOf', [])))
    kind = schema.get('type', 'object')
    if isinstance(kind, list):
        return ' | '.join(kind)
    if kind == 'array':
        return typename(spec, schema.get('items', {})) + '[]'
    if schema.get('format'):
        return f"{kind} ({schema['format']})"
    return kind


def constraints(spec, schema):
    schema = resolve(spec, schema)
    pieces = []
    if 'enum' in schema:
        pieces.append('Allowed: ' + ', '.join(str(value) for value in schema['enum']))
    if 'const' in schema:
        pieces.append('Always ' + json.dumps(schema['const']))
    if 'minimum' in schema or 'maximum' in schema:
        pieces.append(f"Range {schema.get('minimum', 'unbounded')} to {schema.get('maximum', 'unbounded')}")
    if 'minLength' in schema or 'maxLength' in schema:
        pieces.append(f"Length {schema.get('minLength', 0)} to {schema.get('maxLength', 'unbounded')}")
    if 'minItems' in schema or 'maxItems' in schema:
        pieces.append(f"Items {schema.get('minItems', 0)} to {schema.get('maxItems', 'unbounded')}")
    if schema.get('uniqueItems'):
        pieces.append('Unique items')
    if 'default' in schema:
        pieces.append('Default: ' + json.dumps(schema['default']))
    if schema.get('writeOnly'):
        pieces.append('Write only')
    description = schema.get('description', '')
    if description:
        pieces.append(description)
    elif schema.get('pattern'):
        if 'A-Za-z0-9_-' in schema['pattern']:
            pieces.append('Validated token format')
        elif 'd{4}' in schema['pattern']:
            pieces.append('YYYY-MM-DD; valid calendar date')
        else:
            pieces.append('Validated character format')
    if schema.get('type') == 'array' and 'enum' in schema.get('items', {}):
        pieces.append('Values: ' + ', '.join(schema['items']['enum']))
    return '; '.join(clean(piece) for piece in pieces)


def scrub_example(value):
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key == 'accessToken': result[key] = '<ACCESS_TOKEN>'
            elif key == 'refreshToken': result[key] = '<REFRESH_TOKEN>'
            elif key == 'password': result[key] = '<YOUR_LONG_PASSPHRASE>'
            elif key == 'key': result[key] = '<API_KEY>'
            else: result[key] = scrub_example(item)
        return result
    if isinstance(value, list):
        return [scrub_example(item) for item in value]
    return value


def compact_json(value, indent=0, width=102):
    """Pretty JSON that wraps between members, never inside a quoted string."""
    pad = ' ' * indent
    simple = json.dumps(value, ensure_ascii=True, separators=(', ', ': '))
    if len(pad) + len(simple) <= width:
        return pad + simple
    if isinstance(value, dict):
        lines = [pad + '{']
        pending = ' ' * (indent + 2)
        members = list(value.items())
        for index, (key, item) in enumerate(members):
            comma = ',' if index < len(members) - 1 else ''
            encoded = json.dumps(item, ensure_ascii=True, separators=(', ', ': '))
            label = json.dumps(key) + ': '
            piece = label + encoded + comma
            if not isinstance(item, (dict, list)) and len(piece) + indent + 2 <= width:
                if len(pending) + len(piece) + 1 > width:
                    lines.append(pending.rstrip())
                    pending = ' ' * (indent + 2)
                pending += ('' if pending.strip() == '' else ' ') + piece
            else:
                if pending.strip():
                    lines.append(pending.rstrip())
                    pending = ' ' * (indent + 2)
                child = compact_json(item, indent + 2 + len(label), width).splitlines()
                lines.append(' ' * (indent + 2) + label + child[0].lstrip())
                lines.extend(' ' * (indent + 2) + line.lstrip() if line.strip() in ['}', ']'] else line for line in child[1:])
                lines[-1] += comma
        if pending.strip(): lines.append(pending.rstrip())
        lines.append(pad + '}')
        return '\n'.join(lines)
    if isinstance(value, list):
        lines = [pad + '[']
        for index, item in enumerate(value):
            lines.extend(compact_json(item, indent + 2, width).splitlines())
            if index < len(value) - 1: lines[-1] += ','
        lines.append(pad + ']')
        return '\n'.join(lines)
    return pad + simple


class CodeBlock(Flowable):
    def __init__(self, code, font, size=7.7):
        super().__init__()
        self.lines = clean(code).splitlines() or ['']
        self.font = font
        self.size = size
        self.leading = size * 1.28
        self.pad = 7
        self.width = WIDTH
        self.height = len(self.lines) * self.leading + 2 * self.pad

    def wrap(self, availWidth, availHeight):
        self.width = availWidth
        longest = max(pdfmetrics.stringWidth(line, self.font, self.size) for line in self.lines)
        if longest > availWidth - 2 * self.pad:
            self.size = max(6.8, self.size * (availWidth - 2 * self.pad) / longest)
            self.leading = self.size * 1.28
            if max(pdfmetrics.stringWidth(line, self.font, self.size) for line in self.lines) > availWidth - 2 * self.pad + .1:
                raise ValueError(f'Code line is too long: {max(self.lines, key=len)}')
        self.height = len(self.lines) * self.leading + 2 * self.pad
        return self.width, self.height

    def split(self, availWidth, availHeight):
        count = int((availHeight - 2 * self.pad) // self.leading)
        if count < 3 or count >= len(self.lines): return []
        return [CodeBlock('\n'.join(self.lines[:count]), self.font, self.size), CodeBlock('\n'.join(self.lines[count:]), self.font, self.size)]

    def draw(self):
        canvas = self.canv
        canvas.setFillColor(PALE)
        canvas.setStrokeColor(LINE)
        canvas.roundRect(0, 0, self.width, self.height, 4, stroke=1, fill=1)
        canvas.setFillColor(INK)
        canvas.setFont(self.font, self.size)
        y = self.height - self.pad - self.size
        for line in self.lines:
            canvas.drawString(self.pad, y, line)
            y -= self.leading


def draw_icon(canvas, kind, x, y, size=15):
    canvas.saveState()
    canvas.translate(x, y)
    canvas.setStrokeColor(TEAL)
    canvas.setLineWidth(1.2)
    if kind == 'shield':
        path = canvas.beginPath()
        path.moveTo(size / 2, 0); path.lineTo(size * .12, size * .34); path.lineTo(size * .12, size * .85)
        path.lineTo(size / 2, size); path.lineTo(size * .88, size * .85); path.lineTo(size * .88, size * .34); path.close()
        canvas.drawPath(path)
        canvas.line(size * .32, size * .53, size * .45, size * .38); canvas.line(size * .45, size * .38, size * .71, size * .68)
    elif kind == 'code':
        canvas.line(size * .32, size * .2, 0, size * .5); canvas.line(0, size * .5, size * .32, size * .8)
        canvas.line(size * .68, size * .2, size, size * .5); canvas.line(size, size * .5, size * .68, size * .8)
        canvas.line(size * .58, size, size * .42, 0)
    elif kind == 'cloud':
        path = canvas.beginPath()
        path.moveTo(size * .12, size * .2); path.curveTo(-size * .08, size * .4, 0, size * .69, size * .24, size * .64)
        path.curveTo(size * .31, size * 1.05, size * .75, size * 1.06, size * .83, size * .65)
        path.curveTo(size * 1.15, size * .58, size * 1.08, size * .2, size * .88, size * .2); path.close()
        canvas.drawPath(path)
    else:
        canvas.rect(size * .15, 0, size * .75, size)
        canvas.line(size * .3, size * .7, size * .75, size * .7)
        canvas.line(size * .3, size * .45, size * .75, size * .45)
        canvas.line(size * .3, size * .2, size * .65, size * .2)
    canvas.restoreState()


class Heading(Flowable):
    def __init__(self, text, key, fonts, level=0, icon='code', method=None, path=None):
        super().__init__()
        self.text, self.key, self.fonts, self.level, self.icon = clean(text), key, fonts, level, icon
        self.method, self.path = method, path
        self.keepWithNext = True
        self.spaceBefore = 13 if level == 0 else 10
        self.spaceAfter = 6
        self.height = 26 if level == 0 else 23

    def wrap(self, availWidth, availHeight):
        self.width = availWidth
        return availWidth, self.height

    def draw(self):
        canvas = self.canv
        if self.method:
            canvas.setFillColor(METHOD_COLOR.get(self.method, TEAL))
            canvas.roundRect(0, 4, 48, 16, 3, stroke=0, fill=1)
            canvas.setFillColor(WHITE); canvas.setFont(self.fonts['Bold'], 7.8)
            canvas.drawCentredString(24, 9, self.method)
            canvas.setFillColor(NAVY); canvas.setFont(self.fonts['Mono'], 9.3)
            canvas.drawString(56, 8, self.path)
            canvas.setStrokeColor(LINE); canvas.line(0, 0, self.width, 0)
        else:
            draw_icon(canvas, self.icon, 0, 6, 17)
            canvas.setFillColor(NAVY); canvas.setFont(self.fonts['Bold'], 15 if self.level == 0 else 11)
            canvas.drawString(26, 7, self.text)
        canvas.bookmarkHorizontal(self.key, 0, self.height)
        canvas.addOutlineEntry(self.text, self.key, self.level, closed=True)


class Hero(Flowable):
    def __init__(self, fonts, count, version):
        super().__init__(); self.fonts, self.count, self.version = fonts, count, version; self.height = 125

    def wrap(self, availWidth, availHeight): self.width = availWidth; return availWidth, self.height

    def draw(self):
        c = self.canv
        c.setFillColor(NAVY); c.roundRect(0, 0, self.width, self.height, 7, stroke=0, fill=1)
        c.setFillColor(colors.HexColor('#75D4C9')); c.setFont(self.fonts['Bold'], 9)
        c.drawString(18, 99, 'SUPABASE EDGE  /  TYPESCRIPT  /  POSTGRES + STORAGE')
        c.setFillColor(WHITE); c.setFont(self.fonts['Bold'], 30)
        c.drawString(18, 59, 'Frontend API Guide')
        c.setFont(self.fonts['Body'], 10)
        c.drawString(18, 29, f'Complete integration reference - {self.count} operations - API v{self.version}')
        c.setStrokeColor(colors.HexColor('#75D4C9')); c.setLineWidth(1.4)
        c.circle(self.width - 42, 63, 22, stroke=1, fill=0)
        c.line(self.width - 54, 63, self.width - 46, 55); c.line(self.width - 46, 55, self.width - 29, 73)


class Architecture(Flowable):
    def __init__(self, fonts): super().__init__(); self.fonts = fonts; self.height = 73
    def wrap(self, availWidth, availHeight): self.width = availWidth; return availWidth, self.height
    def draw(self):
        c = self.canv
        boxes = [(0, 105, 'Your frontend', 'fetch + Bearer token'), (145, 141, 'Supabase API', 'validate + authorize'), (326, self.width - 326, 'Postgres / Storage', 'data + sessions + files')]
        for x, width, title, subtitle in boxes:
            c.setFillColor(PALE); c.setStrokeColor(LINE); c.roundRect(x, 10, width, 53, 4, stroke=1, fill=1)
            c.setFillColor(NAVY); c.setFont(self.fonts['Bold'], 9); c.drawCentredString(x + width / 2, 41, title)
            c.setFillColor(SLATE); c.setFont(self.fonts['Body'], 7.7); c.drawCentredString(x + width / 2, 25, subtitle)
        for x in [111, 292]:
            c.setStrokeColor(TEAL); c.line(x, 36, x + 27, 36); c.line(x + 27, 36, x + 21, 40); c.line(x + 27, 36, x + 21, 32)


class GuideDoc(BaseDocTemplate):
    def __init__(self, path, fonts, version, generated):
        super().__init__(str(path), pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=48, bottomMargin=42,
                         title='Frontend Foundation API - Integration Guide', author='Frontend Foundation API', subject='Complete generated frontend REST API guide')
        self.fonts, self.version, self.generated = fonts, version, generated
        frame = Frame(MARGIN, 42, WIDTH, PAGE_H - 90, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        self.addPageTemplates(PageTemplate(id='guide', frames=frame, onPage=self.chrome))

    def chrome(self, canvas, doc):
        canvas.saveState()
        canvas.setFont(self.fonts['Bold'], 8); canvas.setFillColor(NAVY)
        canvas.drawString(MARGIN, PAGE_H - 26, 'FRONTEND FOUNDATION API')
        canvas.setFont(self.fonts['Body'], 7.7); canvas.setFillColor(SLATE)
        canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 26, f'API v{self.version} | Integration reference')
        canvas.setStrokeColor(LINE); canvas.line(MARGIN, PAGE_H - 33, PAGE_W - MARGIN, PAGE_H - 33)
        canvas.line(MARGIN, 32, PAGE_W - MARGIN, 32)
        canvas.setFont(self.fonts['Body'], 7.2)
        canvas.drawString(MARGIN, 19, f'Generated from OpenAPI | {self.generated}')
        canvas.drawRightString(PAGE_W - MARGIN, 19, f'Page {doc.page}')
        canvas.restoreState()

    def afterFlowable(self, flowable):
        if isinstance(flowable, Heading) and flowable.level == 0 and flowable.key not in ['start', 'contents']:
            self.notify('TOCEntry', (flowable.level, escape(flowable.text), self.page, flowable.key))


class Builder:
    def __init__(self, spec, config, fonts, base_url, generated):
        self.spec, self.config, self.fonts, self.base_url, self.generated = spec, config, fonts, base_url, generated
        self.story = []
        self.operations = []
        self.styles = {
            'body': ParagraphStyle('body', fontName=fonts['Body'], fontSize=9, leading=12.2, textColor=INK, spaceAfter=4),
            'small': ParagraphStyle('small', fontName=fonts['Body'], fontSize=7.8, leading=10.3, textColor=SLATE, spaceAfter=4),
            'label': ParagraphStyle('label', fontName=fonts['Bold'], fontSize=8.3, leading=10.6, textColor=TEAL, spaceBefore=5, spaceAfter=4, keepWithNext=True),
            'cell': ParagraphStyle('cell', fontName=fonts['Body'], fontSize=7.7, leading=10, textColor=INK),
            'cellhead': ParagraphStyle('cellhead', fontName=fonts['Bold'], fontSize=7.7, leading=10, textColor=WHITE),
        }

    def p(self, text, style='body'):
        return Paragraph(escape(clean(text)).replace('\n', '<br/>'), self.styles[style])

    def add(self, text, style='body'): self.story.append(self.p(text, style))
    def code(self, text): self.story.extend([CodeBlock(text, self.fonts['Mono']), Spacer(1, 5)])
    def label(self, text): self.add(text, 'label')
    def heading(self, title, key, icon='code'):
        self.story.append(Heading(title, key, self.fonts, icon=icon))

    def table(self, headers, rows, widths=None):
        data = [[self.p(item, 'cellhead') for item in headers]]
        data.extend([[self.p(item, 'cell') for item in row] for row in rows])
        table = Table(data, colWidths=widths or [WIDTH / len(headers)] * len(headers), repeatRows=1, hAlign='LEFT')
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), NAVY), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('ROWBACKGROUNDS', (0, 1), (-1, -1), [WHITE, PALE]),
            ('LINEBELOW', (0, 0), (-1, 0), .5, NAVY), ('LINEBELOW', (0, 1), (-1, -1), .3, LINE),
            ('LEFTPADDING', (0, 0), (-1, -1), 6), ('RIGHTPADDING', (0, 0), (-1, -1), 6),
            ('TOPPADDING', (0, 0), (-1, -1), 3.2), ('BOTTOMPADDING', (0, 0), (-1, -1), 3.2),
        ]))
        self.story.extend([table, Spacer(1, 5)])

    def frontmatter(self):
        count = sum(method in METHODS for methods in self.spec['paths'].values() for method in methods)
        self.story.extend([Hero(self.fonts, count, self.spec['info']['version']), Spacer(1, 11)])
        self.add('A practical guide to integrating a local frontend with a real Supabase API. Start with a user session, learn predictable REST calls, and use the endpoint reference when building forms, lists, and uploads.')
        self.story.append(Architecture(self.fonts))
        self.heading('Start in five steps', 'start', 'cloud')
        for number, text in enumerate([
            'Use the live Supabase API base URL, including /functions/v1/backend. Use http://localhost:8787 only for isolated backend development.',
            'Set your public frontend base URL and allow your exact frontend origin in backend CORS configuration.',
            'Register or log in. Keep the returned access and refresh tokens in memory.',
            'Send Authorization: Bearer <ACCESS_TOKEN>. Parse data on success and error.code on failure.',
            'Use pages, filters and PATCH to build UI flows; upload File/Blob bytes directly for private images.',
        ], 1): self.add(f'{number}. {text}')
        self.label('Connection addresses')
        self.table(['Environment', 'Base URL and role'], [
            ['Live API', self.base_url or 'Not supplied in this draft. Paste the verified HTTPS URL returned by deployment.'],
            ['Local backend', 'http://localhost:8787 - isolated PostgreSQL development data'],
            ['Reference and contract', 'Local /docs or portable docs/index.html; live /openapi.json - OpenAPI3.1. Endpoint paths append to the full base URL.'],
        ], [95, WIDTH - 95])
        self.add('The base URL has no /api/v1 suffix, query, fragment or credentials. Examples use placeholders, never built-in credentials. Live accounts and local seed accounts are separate.', 'small')
        self.story.append(Heading('Contents', 'contents', self.fonts, icon='document'))
        toc = TableOfContents()
        toc.levelStyles = [
            ParagraphStyle('toc0', fontName=self.fonts['Bold'], fontSize=9.4, leading=13, leftIndent=0, firstLineIndent=0, textColor=NAVY, spaceBefore=3),
            ParagraphStyle('toc1', fontName=self.fonts['Body'], fontSize=7.8, leading=10.4, leftIndent=12, firstLineIndent=0, textColor=SLATE),
        ]
        self.story.append(toc)
        self.story.append(PageBreak())

    def integration(self):
        self.heading('Frontend setup and first calls', 'frontend-setup', 'code')
        self.add('Your frontend can remain on your machine while the API is hosted on Supabase. In the frontend project, create .env.local with the variable for your framework, then restart the dev server. Published builds must be rebuilt after changing this value.')
        url = self.base_url or '<VERIFIED_HTTPS_API_BASE_URL>'
        self.code(f'# Vite - public API URL only\nVITE_API_BASE_URL={url}\n# Next.js - use this name instead\nNEXT_PUBLIC_API_BASE_URL={url}')
        self.add('Never expose API keys, Supabase account tokens, JWT_SECRET, PASSWORD_PEPPER or IP_HASH_SECRET through VITE_ / NEXT_PUBLIC_ variables. Framework public variables are visible in the browser bundle.')
        self.label('Configure exact CORS origins')
        self.add('Allow only the frontend origins you use. localhost and 127.0.0.1 are different origins; ports and schemes also matter. Production allows HTTP only for configured loopback hosts. The hosted API itself requires HTTPS; published frontend origins require HTTPS. Serve HTML with a dev server, rather than file://.')
        self.code('ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,\nhttp://localhost:5173,http://127.0.0.1:5173,\nhttp://localhost:5500,http://127.0.0.1:5500\n# Put the selected origins on ONE comma-separated configuration line.')
        self.label('Sign in and read projects with fetch')
        self.code("""const baseUrl = import.meta.env.VITE_API_BASE_URL;
// Next.js client: process.env.NEXT_PUBLIC_API_BASE_URL
const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
  method: 'POST', credentials: 'omit',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const login = await loginResponse.json();
if (!loginResponse.ok) throw new Error(login.error.message);
let { accessToken, refreshToken } = login.data; // Memory only.
const response = await fetch(`${baseUrl}/api/v1/projects?page=1&limit=20`, {
  credentials: 'omit', headers: { Authorization: `Bearer ${accessToken}` },
});
const result = await response.json();
if (!response.ok) throw new Error(result.error.message);
renderProjects(result.data, result.meta); // Your UI function.""")
        self.add('fetch rejects for network/transport failures, not HTTP 4xx/5xx. Check response.ok. Retain requestId for support; do not log tokens or raw credentials. Copy examples/frontend.ts into your frontend for typed CRUD, timeouts, AbortSignal support and serialized refresh.')
        self.label('Create, update and remove a resource')
        self.code("""import { LearningApi, ApiClientError } from './frontend';
const api = new LearningApi(import.meta.env.VITE_API_BASE_URL);
await api.login(email, password);
const project = await api.createProject({ name: 'My first project' });
const task = await api.createTask({ title: 'Build the list', projectId: project.id });
await api.updateTask(task.id, { status: 'done' });
const page = await api.tasks({ projectId: project.id, page: 1, limit: 10 });
renderTasks(page.items);
await api.deleteTask(task.id);""")
        self.add('Represent loading, empty, success and error states separately. Disable repeated submissions while writes are pending. Debounce search and abort obsolete reads. Render text with framework interpolation or textContent, never HTML injection helpers.')

    def conventions(self):
        self.heading('Responses, lists and errors', 'conventions', 'document')
        self.add('JSON resource responses use the same envelope. Lists return a data array plus meta; single resources return an object. Session lists return data.sessions and key lists return data.items. Creates return 201; normal reads, PATCH and DELETE return 200. Resource deletes return {id, deleted:true}; revocations return {revoked:true}.')
        self.code(compact_json({'success': True, 'data': [], 'meta': {'page': 1, 'limit': 20, 'total': 0, 'totalPages': 0, 'hasNext': False, 'hasPrevious': False}, 'requestId': '<REQUEST_ID>'}))
        error = {'success': False, 'error': {'code': 'VALIDATION_ERROR', 'message': 'Some fields are invalid', 'details': [{'field': 'name', 'message': 'Use plain text without markup or control characters'}]}, 'requestId': '<REQUEST_ID>'}
        self.code(compact_json(error))
        self.add('The X-Request-Id header matches requestId. OpenAPI JSON, reference HTML/CSS, successful binary downloads and successful 204 CORS preflight do not use this envelope. Download failures still return the JSON error envelope.')
        rows = [
            ['400', 'Malformed JSON/body/header, ambiguous credentials or unexpected DELETE body', 'Fix the request.'],
            ['401', 'Missing, invalid, expired or revoked credentials', 'Refresh once; sign in if refresh fails.'],
            ['403', 'Origin, role, scope or registration policy denies access', 'Explain permission failure; do not retry blindly.'],
            ['404', 'Missing endpoint or resource, including another owner\'s resource', 'Show a missing resource state.'],
            ['409', 'Duplicate email, relation conflict or active API-key cap', 'Resolve the conflict before resubmitting.'],
            ['413 / 415', 'Body too large / unsupported media type or content encoding', 'Reduce bytes / use the documented Content-Type.'],
            ['422', 'Invalid fields, UUID, calendar date or query parameters', 'Show field messages from error.details.'],
            ['429', 'Rate limit exceeded; response includes Retry-After', 'Respect the delay and avoid synchronized retries.'],
            ['500 / 503', 'Internal failure / temporary service or configuration failure', 'Keep requestId; check write state before retrying.'],
        ]
        self.table(['HTTP', 'Meaning', 'Frontend action'], rows, [50, 230, WIDTH - 280])
        self.label('Pagination and search')
        self.add('Default page=1, limit=20, sort=createdAt, order=desc. Page is 1-10000 and limit is 1-100. q is optional trimmed plain text with 1-100 characters; omit empty search. Unknown or duplicate list parameters return 422. Search matches literal substrings: % and _ are escaped, not wildcard operators. A page past the end returns an empty successful list.')
        self.table(['Collection', 'Filters', 'Sort fields / search'], [
            ['Projects', 'status: active | archived', 'createdAt, updatedAt, name / name + description'],
            ['Tasks', 'status: todo | in_progress | done; priority: low | medium | high; projectId: UUID', 'createdAt, updatedAt, title, dueDate / title + description'],
            ['Files', 'contentType: image/png | image/jpeg | image/webp', 'createdAt, filename, size / filename'],
            ['Users (admin)', 'role: member | admin', 'createdAt, name, email / name + email'],
            ['Audit (admin)', 'action: text; actorId: UUID', 'createdAt / no q search'],
        ], [85, 215, WIDTH - 300])
        self.code("""const query = new URLSearchParams({ page: '1', limit: '10', order: 'asc' });
if (search.trim()) query.set('q', search.trim());
const response = await fetch(`${baseUrl}/api/v1/tasks?${query}`, {
  headers: { Authorization: `Bearer ${accessToken}` }, credentials: 'omit',
});""")
        self.add('PATCH changes only supplied fields and must include at least one supported field. Omit a field to keep it; pass null to clear task projectId or dueDate. Dates use YYYY-MM-DD. Deleting a project keeps tasks and sets their projectId to null. Offset pages can move during concurrent changes; use a cursor-based module for future large feeds.', 'small')

    def auth_and_files(self):
        self.heading('Authentication and private files', 'authentication', 'shield')
        self.table(['Caller', 'Authentication header', 'Permissions'], [
            ['Browser user', 'Authorization: Bearer <ACCESS_TOKEN>', 'Owned resources; session/profile management; admin lists require admin role.'],
            ['Trusted server / BFF', 'X-API-Key: <API_KEY>', 'Owned projects/tasks/files only, restricted by explicit scopes.'],
            ['Public endpoint', 'No authentication header', 'Registration, login, refresh and system routes only.'],
        ], [100, 215, WIDTH - 315])
        self.add('Use one authentication method per request; sending both returns 400. Never embed an API key in browser or mobile code. CORS does not keep client-side secrets private. A member and an administrator both see only their own projects, tasks and files. Another owner\'s ID returns 404.')
        self.table(['Scope', 'What it authorizes'], [
            ['resources:read', 'GET project/task collection and detail routes'], ['resources:write', 'POST/PATCH/DELETE project/task routes'],
            ['files:read', 'GET file metadata, collection and private content'], ['files:write', 'POST upload and DELETE file routes'],
        ], [125, WIDTH - 125])
        self.add('Write does not imply read. Create/manage keys with a Bearer session; plaintext keys are returned once. Keys expire in 1-90 days and are capped at 20 active keys per user. Normal browser integrations should use their user\'s session, never a shared key.')
        self.label('Access, refresh and logout lifecycle')
        self.add('Access JWTs expire after expiresIn seconds (default 900). Sessions expire absolutely after seven days by default; refreshing does not extend sessionExpiresAt. Up to 20 active sessions are retained; another login evicts the oldest. PostgreSQL checks current user, role, session and key state on protected requests, so logout, disabling, role changes and revocation take effect before JWT expiry.')
        self.code("""// Serialize this exchange: reuse of the old token revokes the session.
const response = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
  method: 'POST', credentials: 'omit',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ refreshToken }),
});
const result = await response.json();
if (!response.ok) { accessToken = ''; refreshToken = ''; throw new Error('Sign in again'); }
({ accessToken, refreshToken } = result.data); // Store BOTH replacements immediately.
// On logout, POST /api/v1/auth/logout with Bearer auth, then clear both tokens.""")
        self.add('Keep tokens in memory, not URLs, logs or persistent browser storage. The sample client serializes refresh within one instance; coordinate multiple tabs/contexts or use a BFF. A lost rotation response can require sign-in again. Do not blindly retry write timeouts, 429 or 5xx: the first mutation may already have committed. No authentication cookies are set; credentials: omit is appropriate.')
        self.label('Upload and download an image')
        self.add(f"Send a File or Blob as the raw body, not multipart FormData or base64. The current upload cap is {int(self.config['variables']['MAX_UPLOAD_BYTES']) // 1048576} MiB. Static PNG, JPEG and WebP are accepted; signatures, structure, extensions and dimensions are checked. Each dimension is at most 16384 pixels and total pixels at most 40 million. APNG, animated WebP, SVG and HTML are rejected.")
        self.code("""const file = input.files?.[0];
if (file) {
  const response = await fetch(`${baseUrl}/api/v1/files`, {
    method: 'POST', credentials: 'omit',
    headers: { Authorization: `Bearer ${accessToken}`,
      'Content-Type': file.type, 'X-File-Name': file.name },
    body: file,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error.message);
  const content = await fetch(`${baseUrl}${result.data.downloadUrl}`, {
    headers: { Authorization: `Bearer ${accessToken}` }, credentials: 'omit',
  });
  if (!content.ok) throw new Error((await content.json()).error.message);
  const objectUrl = URL.createObjectURL(await content.blob());
  image.src = objectUrl;
  image.onload = () => URL.revokeObjectURL(objectUrl);
}""")
        self.add('Filenames use bounded ASCII characters without paths; spaces become underscores and the extension must match MIME. Storage remains private. An img src cannot attach Bearer auth; use an authorized fetch and a Blob URL. Downloads are attachments with nosniff and private/no-store caching. Validation is structural, not malware scanning or full image decoding.', 'small')

    def operation_reference(self):
        self.heading('Complete endpoint reference', 'endpoints', 'document')
        self.add('Every HTTP operation in docs/openapi.json appears below. Set API_BASE_URL to your selected base URL. ACCESS_TOKEN, REFRESH_TOKEN, API_KEY, RESOURCE_ID and filenames are placeholders or your own values. Request examples choose Bearer auth when supported; trusted server callers may replace that header with X-API-Key when the listed scope allows it. Error status numbers refer to the common error table.')
        groups = {}
        for path, methods in self.spec['paths'].items():
            for method, operation in methods.items():
                if method not in METHODS: continue
                tag = operation.get('tags', ['System'])[0]
                groups.setdefault(tag, []).append((path, method, operation))
        order = ['Authentication', 'Projects', 'Tasks', 'Files', 'Users', 'API Keys', 'Audit', 'System']
        for tag in [*order, *[tag for tag in groups if tag not in order]]:
            if tag not in groups: continue
            self.label(tag.upper())
            for path, method, operation in groups[tag]: self.operation(path, method, operation)

    def operation(self, path, method, operation):
        op_id = operation.get('operationId', method + path)
        self.operations.append((method.upper(), path, op_id))
        self.story.append(Heading(f'{method.upper()} {path}', 'operation-' + op_id, self.fonts, level=1, method=method.upper(), path=path))
        self.add(operation.get('summary', ''), 'label')
        security = operation.get('security', self.spec.get('security', []))
        supports_bearer = any('bearerAuth' in auth for auth in security)
        supports_key = any('apiKeyAuth' in auth for auth in security)
        auth = 'Public; no auth header' if not security else 'Bearer access token' + (' OR trusted-server API key' if supports_key else ' only')
        description = operation.get('description', '')
        scope = re.search(r'Requires (resources:read|resources:write|files:read|files:write)', description)
        if scope: auth += '; API key scope ' + scope.group(1)
        if 'admin' in description.lower() or '(admin only)' in operation.get('summary', '').lower(): auth += '; admin role'
        self.add('AUTH  ' + auth, 'small')
        if description: self.add(description, 'small')
        parameters = [resolve(self.spec, item) for item in operation.get('parameters', [])]
        if parameters:
            rows = []
            for param in parameters:
                notes = constraints(self.spec, param.get('schema', {}))
                if param.get('description') and param['description'] not in notes: notes += ('; ' if notes else '') + param['description']
                rows.append([param['name'] + (' *' if param.get('required') else ''), param['in'] + ' / ' + typename(self.spec, param.get('schema', {})), notes or 'Optional; see request example.'])
            self.table(['Parameter (* required)', 'Location / type', 'Allowed values and behavior'], rows, [105, 110, WIDTH - 215])
        request = resolve(self.spec, operation.get('requestBody', {}))
        content = request.get('content', {})
        json_request = content.get('application/json')
        if json_request:
            schema = resolve(self.spec, json_request.get('schema', {}))
            rows = [[name + (' *' if name in schema.get('required', []) else ''), typename(self.spec, field), constraints(self.spec, field)] for name, field in schema.get('properties', {}).items()]
            if rows: self.table(['JSON body (* required)', 'Type', 'Rules / defaults'], rows, [105, 110, WIDTH - 215])
            self.add('JSON object rejects unknown fields.' + (' Supply at least one field; omitted values remain unchanged.' if schema.get('minProperties') else ''), 'small')
        elif content:
            self.add('REQUEST BODY  Raw binary; Content-Type: ' + ' | '.join(content), 'small')
        elif method in ['post', 'delete', 'patch']:
            self.add('REQUEST BODY  None. Do not send a body.', 'small')
        self.label('Request example')
        request_path = path.replace('{id}', '${RESOURCE_ID}')
        query_params = [param for param in parameters if param.get('in') == 'query']
        if query_params:
            query = {}
            for param in query_params:
                name = param['name']; schema = resolve(self.spec, param.get('schema', {}))
                if name in ['page', 'limit', 'order', 'sort']: query[name] = schema.get('default', 1 if name == 'page' else 20)
            if 'q' in [param['name'] for param in query_params]: query['q'] = 'learn'
            if query: request_path += '?' + urlencode(query)
        lines = [f'curl -X {method.upper()} "${{API_BASE_URL}}{request_path}"']
        if supports_bearer: lines.append('  -H "Authorization: Bearer ${ACCESS_TOKEN}"')
        elif supports_key: lines.append('  -H "X-API-Key: ${API_KEY}"')
        for param in parameters:
            if param.get('in') == 'header' and param.get('required'):
                lines.append(f"  -H '{param['name']}: {param.get('example', '<VALUE>')}'")
        body = None
        if json_request:
            lines.append("  -H 'Content-Type: application/json'")
            lines.append("  --data-binary @- <<'JSON'")
            body = scrub_example(json_request.get('example', {}))
        elif content:
            lines.extend(["  -H 'Content-Type: image/png'", '  --data-binary @profile.png'])
        if len(lines) > 1: lines = [line + ' \\' for line in lines[:-1]] + lines[-1:]
        if body is not None: lines.extend([compact_json(body), 'JSON'])
        self.code('\n'.join(lines))
        successful = [(status, resolve(self.spec, response)) for status, response in operation.get('responses', {}).items() if str(status).startswith('2')]
        for status, response in successful:
            response_content = response.get('content', {})
            response_json = response_content.get('application/json')
            self.label('Response example - HTTP ' + status)
            if response_json and 'example' in response_json:
                example = scrub_example(copy.deepcopy(response_json['example']))
                # Make PATCH examples reflect their declared request while retaining full DTO fields.
                if method == 'patch' and isinstance(example.get('data'), dict) and isinstance(body, dict):
                    example['data'].update({key: value for key, value in body.items() if key in example['data']})
                self.code(compact_json(example))
            else:
                headers = [f'HTTP {status}', 'Content-Type: ' + ' | '.join(response_content)]
                for name, header in response.get('headers', {}).items():
                    header = resolve(self.spec, header)
                    value = header.get('example', header.get('schema', {}).get('const', '<VALUE>'))
                    headers.append(f'{name}: {value}')
                self.code('\n'.join(headers))
                self.add(response.get('description', 'Successful response.') + ' Response body uses the listed media type rather than a resource envelope.', 'small')
            if response_json:
                schema = resolve(self.spec, response_json.get('schema', {}))
                data = schema.get('properties', {}).get('data')
                if data: self.add('RESPONSE TYPE  data: ' + typename(self.spec, data) + '; see the schema catalog. All examples are illustrative, not credentials.', 'small')
            extra = [name for name in response.get('headers', {}) if name.lower() != 'x-request-id']
            if extra: self.add('RESPONSE HEADERS  ' + ', '.join(extra), 'small')
        errors = [status for status in operation.get('responses', {}) if not str(status).startswith('2')]
        self.add('ERROR STATUSES  ' + ', '.join(errors) + '. Common error envelope and actions: Responses, lists and errors.', 'small')

    def schema_catalog(self):
        self.heading('Response schema catalog', 'schemas', 'document')
        self.add('Types below describe response data and pagination. All JSON examples in the endpoint reference retain their full success envelope. UUIDs are opaque server-generated identifiers; timestamps are UTC ISO 8601. Null means an explicitly absent value. Credential/hash/storage-owner internals never appear in normal resource DTOs.')
        names = ['User', 'AuthTokens', 'Session', 'ApiKey', 'CreatedApiKey', 'Project', 'Task', 'File', 'AuditEvent', 'PaginationMeta', 'Revoked', 'Deleted', 'Error', 'ErrorDetail']
        for name in names:
            schema = resolve(self.spec, self.spec['components']['schemas'][name])
            self.label(name)
            rows = []
            for field_name, field in schema.get('properties', {}).items():
                note = constraints(self.spec, field)
                resolved = resolve(self.spec, field)
                if resolved.get('type') == 'object' and resolved.get('properties'):
                    note += ('; ' if note else '') + 'Fields: ' + ', '.join(resolved['properties'])
                rows.append([field_name + (' *' if field_name in schema.get('required', []) else ''), typename(self.spec, field), note or 'Returned field'])
            self.table(['Field (* always present)', 'Type', 'Meaning / constraints'], rows, [105, 130, WIDTH - 235])

    def operations_setup(self):
        self.heading('Local development and deployment', 'operations', 'cloud')
        self.add('Frontend learners only need the live API URL and their own account. Backend contributors can run Node.js 22.12+ and npm locally with persisted PGlite (real PostgreSQL) and private filesystem storage. No cloud account, Docker or card is required for this local mode.')
        self.code('npm ci\nnpm run setup:local\nnpm run db:migrate\nnpm run db:seed\nnpm run dev\n# Open http://localhost:8787/docs')
        self.add('setup:local creates ignored .env.local with four distinct random secrets and restrictive permissions, preserving existing values. Local seed creates learner@local.test/admin@local.test with a generated password printed once; rerunning rotates those local passwords and revokes sessions. Never seed production.')
        self.code('npm run check          # Types, PostgreSQL tests, OpenAPI and Edge bundles\nnpm run format:check\nnpm audit\nnpm run openapi:export # After editing src/openapi.ts')
        self.label('Deploy a separate installation on Supabase Free')
        self.add('Create a Free Supabase project. Set its projectRef/baseUrl in docs/configuration.json and OpenAPI server defaults, and configure exact frontend origins. Supabase supplies its database URL and private Storage credential inside the Edge runtime; never send these to a frontend.')
        self.code('npm run supabase:login\nnpx supabase link --project-ref YOUR_PROJECT_REF\nnpm run setup:production-secrets\nnpm run deploy\nnpm run maintenance:setup')
        self.add('setup:production-secrets creates or preserves four independent server secrets in an ignored permission-restricted backup and sends them to Supabase Secrets. deploy validates the project, checks secret names/configuration, applies tracked PostgreSQL migrations and deploys backend/maintenance with the API bundler. No Docker is required for deployment. The optional Docker-based Supabase local stack provides Edge runtime parity.')
        self.add('verify_jwt=false disables only the native Supabase JWT gate: protected REST routes still verify custom access JWTs, sessions and API-key scopes in the application. Native Supabase Auth tokens do not authenticate this REST API. The separate maintenance function checks its independent secret.')
        self.label('Private operator endpoint - outside the public REST base')
        self.add('POST https://' + self.config['projectRef'] + '.supabase.co/functions/v1/maintenance. Authorization: Bearer <MAINTENANCE_SECRET>; server/Cron only. No query parameters. Send no body or {} (maximum actual body 1024 bytes; Content-Type: application/json). Origin headers are prohibited; never call this from browser code.')
        self.code('HTTP 200\n{"success":true,"data":{"completed":true},"requestId":"<REQUEST_ID>"}')
        self.add('401 invalid credential; 403 browser Origin; 405 non-POST with Allow: POST; 413 oversized body; 415 wrong type/encoding; 422 unexpected JSON; 503 configuration/dependency failure. Cleanup may make partial progress before 503; retry is safe. Separate contract: docs/maintenance-openapi.json.', 'small')
        self.label('Free plan and platform behavior')
        self.add('This deployment uses the Free plan. Included quotas are finite: 500 MB database, 1 GB file storage, 5 GB egress and 500,000 Edge Function invocations per month. Low-activity Free projects may pause after a week. Automatic backups and availability SLAs are not included. Check current Supabase pricing before expanding usage; no paid feature is needed for this learning setup.')
        self.add('Supabase rewrites hosted HTML responses to plain text on the standard free domain. Use this PDF, docs/index.html or the live OpenAPI JSON for integration reference; the styled local /docs page remains available. API calls use HTTPS normally and require no custom domain.')
        self.add('Supabase Cron invokes private maintenance every 15 minutes using pg_cron/pg_net and a token encrypted in Vault. Cleanup retries tombstones and scans orphans after a 24-hour grace period; batches are bounded and backlog-dependent. Monitor failures and quota usage. Application limits do not stop a rejected request from consuming a platform invocation.')
        self.add('GitHub main contains the source, exported contract and PDF. CI validates pushes; the manual deployment workflow uses encrypted SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF and SUPABASE_DB_PASSWORD. Application secrets remain in Supabase. Operator admin promotion requires an existing active account and records an audit event; no default production admin exists.')
        self.code('npm run admin:promote -- you@example.com --production')

    def configuration(self):
        self.heading('Configuration and maintenance reference', 'configuration', 'shield')
        self.add('Non-secret defaults come from docs/configuration.json. Supabase Secrets may override them. Only the complete API URL belongs in public frontend environment variables; never include server credentials in this PDF or browser code.')
        purposes = {
            'ENVIRONMENT': 'development, test or production.',
            'ALLOWED_ORIGINS': 'Exact comma-separated origins; configured loopback HTTP is allowed.',
            'JWT_ISSUER': 'Expected access JWT issuer.',
            'JWT_AUDIENCE': 'Expected access JWT audience.',
            'ACCESS_TOKEN_TTL_SECONDS': 'Access JWT lifetime, 60-900 seconds.',
            'SESSION_TTL_SECONDS': 'Absolute session lifetime, 3600-2592000 seconds; exceeds JWT TTL.',
            'MAX_JSON_BYTES': 'Actual streamed JSON limit, 1024-1048576 bytes.',
            'MAX_UPLOAD_BYTES': 'Actual streamed upload limit, 1024-10485760 bytes.',
            'ALLOW_REGISTRATION': 'true or false; disable registration for closed applications.',
            'AUDIT_RETENTION_DAYS': '1-3650 days; scheduled deletion is bounded.',
        }
        self.table(['Setting', 'Production default', 'Purpose / range'], [[key, value, purposes.get(key, 'Runtime setting')] for key, value in self.config['variables'].items()], [135, 145, WIDTH - 280])
        self.label('Server secrets and platform-injected variables')
        self.table(['Name', 'Purpose / source'], [
            ['JWT_SECRET', 'Independent random HS256 signing secret; 43-1024 characters.'],
            ['PASSWORD_PEPPER', 'Independent password pepper; 43-1024 characters.'],
            ['IP_HASH_SECRET', 'Independent HMAC pseudonym secret; 43-1024 characters.'],
            ['MAINTENANCE_SECRET', 'Independent random secret authorizing the private Cron function.'],
            ['SUPABASE_URL', 'Platform-injected project API gateway URL.'],
            ['SUPABASE_DB_URL', 'Platform-injected server database connection URL; private.'],
            ['SUPABASE_SERVICE_ROLE_KEY', 'Platform-injected private Storage credential; bypasses RLS.'],
            ['VITE_API_BASE_URL / NEXT_PUBLIC_API_BASE_URL', 'Frontend public variable: full live API URL including function path.'],
            ['SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD', 'Operator/CI deployment environment only; never browser variables.'],
        ], [180, WIDTH - 180])
        self.add('Generate secrets from at least 32 random bytes and keep them distinct. setup scripts preserve existing secrets. Changing the password pepper invalidates stored verifiers; plan a migration/reset. JWT-secret rotation invalidates access tokens. Supabase_* variables are injected by the platform and must not be manually submitted with that reserved prefix.')
        self.table(['Capability', 'Behavior'], [
            ['PostgreSQL', 'Users, owned resources, sessions, hashed keys, transactional audits and atomic limits.'],
            ['Private Storage', 'foundation-files bucket; no anonymous policy or public object URL.'],
            ['Request limits', '120 API requests/minute per ingress IP/user; 10 auth attempts/minute per IP/account. Fixed-window atomic counters.'],
            ['Maintenance', 'Every 15 minutes; up to 100 tombstones/100 objects and 1000 rows per expired-row batch.'],
        ], [135, WIDTH - 135])
        self.label('Security and extension boundaries')
        self.add('Passwords use peppered Argon2id v19 with a random 16-byte salt, 19 MiB memory, two iterations and one lane. The pinned embedded WASM heap is bounded below 32 MiB. Strict field allowlists, bound SQL, live database authorization, secure headers, explicit CORS and streamed byte limits guard requests. RLS and grants deny native anon/authenticated access to application tables. Frontend output encoding remains required.')
        self.add('Email verification, password recovery/reset, MFA, breached-password checks and CAPTCHA are future modules. An email identifier is not verified ownership. Extend route/controller -> service -> repository with strict schemas, owner-scoped SQL, migrations, auth/scope gates, transactional audit, OpenAPI and behavior tests. Define monitoring, backup and restore procedures for real production data.')
        self.label('Source documents and official references')
        links = [
            ['OpenAPI JSON', (self.base_url + '/openapi.json') if self.base_url else 'docs/openapi.json'],
            ['Frontend client / guide', 'examples/frontend.ts / docs/frontend.md'],
            ['Architecture / security', 'docs/architecture.md / docs/security.md'],
            ['Deployment / configuration', 'README.md / docs/configuration.json / supabase/config.toml'],
            ['Supabase pricing', 'https://supabase.com/pricing'],
            ['Secrets / runtime', 'https://supabase.com/docs/guides/functions/secrets'],
            ['Platform limits', 'https://supabase.com/docs/guides/functions/limits'],
            ['Project pausing', 'https://supabase.com/docs/guides/platform/free-project-pausing'],
            ['Password guidance', 'https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html'],
        ]
        for title, link in links:
            if link.startswith('https://'):
                self.story.append(Paragraph(escape(title) + ': <link href="' + escape(link, quote=True) + '" color="#087F83">' + escape(link) + '</link>', self.styles['small']))
            else: self.add(title + ': ' + link, 'small')

    def build(self, output):
        self.frontmatter(); self.integration(); self.conventions(); self.auth_and_files()
        self.operation_reference(); self.schema_catalog(); self.operations_setup(); self.configuration()
        doc = GuideDoc(output, self.fonts, self.spec['info']['version'], self.generated)
        doc.multiBuild(self.story)


def load_config():
    return json.loads((ROOT / 'docs/configuration.json').read_text())


def validate(output, spec, operations, qa_path):
    with pdfplumber.open(output) as pdf:
        pages = [page.extract_text() or '' for page in pdf.pages]
        text = '\n'.join(pages)
        missing = [f'{method} {path}' for method, path, _ in operations if f'{method} {path}' not in text]
        if missing: raise ValueError('Missing operation coverage: ' + ', '.join(missing))
        body_bottom = []
        for number, page in enumerate(pdf.pages, 1):
            body_chars = [char for char in page.chars if char['top'] > 42 and char['bottom'] < PAGE_H - 33]
            for char in body_chars:
                if char['x0'] < MARGIN - 1 or char['x1'] > PAGE_W - MARGIN + 1:
                    raise ValueError(f'Horizontal text overflow on page {number}')
            body_bottom.append({'page': number, 'bottom': round(max([char['bottom'] for char in body_chars] or [0]), 1), 'characters': len(body_chars)})
        if '\u25a0' in text: raise ValueError('Unexpected missing-glyph square in PDF')
        forbidden = ['eyJ...example-access-token', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA']
        if any(item in text for item in forbidden): raise ValueError('Unreplaced example credential token')
        page_count = len(pdf.pages)
    reader = PdfReader(str(output))
    report = {
        'output': str(output), 'pageCount': page_count, 'operationCount': len(operations),
        'pathCount': len(spec['paths']), 'missingOperations': [],
        'openApiSha256': hashlib.sha256((ROOT / 'docs/openapi.json').read_bytes()).hexdigest(),
        'outlineEntries': len(reader.outline), 'pageBodyMetrics': body_bottom,
        'visualInspectionRequired': True,
    }
    qa_path.mkdir(parents=True, exist_ok=True)
    (qa_path / 'coverage.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({key: value for key, value in report.items() if key != 'pageBodyMetrics'}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', help='Verified live HTTPS base URL; omit for a deployment-independent draft')
    parser.add_argument('--output', type=Path, default=ROOT / 'output/pdf/frontend-api-guide.pdf')
    parser.add_argument('--font-dir', type=Path, default=DEFAULT_FONTS)
    parser.add_argument('--date', default=datetime.now(ZoneInfo('Asia/Kolkata')).strftime('%d %B %Y'))
    args = parser.parse_args()
    base_url = args.base_url.rstrip('/') if args.base_url else None
    if base_url:
        parsed = urlparse(base_url)
        if parsed.scheme != 'https' or not parsed.netloc or parsed.query or parsed.fragment or parsed.username:
            raise ValueError('--base-url must be a credential-free live HTTPS API base URL')
    spec = json.loads((ROOT / 'docs/openapi.json').read_text())
    config = load_config()
    fonts = register_fonts(args.font_dir)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    builder = Builder(spec, config, fonts, base_url, args.date)
    builder.build(args.output)
    validate(args.output, spec, builder.operations, ROOT / 'tmp/pdfs')


if __name__ == '__main__': main()
