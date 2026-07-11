'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const algosPage = require('../algos.js');
const downloadsPage = require('../downloads.js');

const ROOT = path.join(__dirname, '..');

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  add(...names) {
    names.forEach((name) => this.values.add(name));
  }

  remove(...names) {
    names.forEach((name) => this.values.delete(name));
  }

  contains(name) {
    return this.values.has(name);
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  constructor({ id = '', classes = [], dataset = {}, attributes = {} } = {}) {
    this.id = id;
    this.classList = new FakeClassList(classes);
    this.dataset = { ...dataset };
    this.attributes = new Map(Object.entries(attributes));
    this.listeners = new Map();
    this.children = [];
    this.nextElementSibling = null;
    this.ownerDocument = null;
    this.textContent = '';
  }

  append(...children) {
    children.forEach((child) => {
      child.ownerDocument = this.ownerDocument;
      this.children.push(child);
    });
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type, properties = {}) {
    const event = {
      defaultPrevented: false,
      key: properties.key,
      target: properties.target || this,
      preventDefault() { this.defaultPrevented = true; },
    };
    (this.listeners.get(type) || []).forEach((listener) => listener(event));
    return event;
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  querySelector(selector) {
    if (selector === '[data-lightbox-close]') {
      return this.children.find((child) => Object.hasOwn(child.dataset, 'lightboxClose')) || null;
    }
    return null;
  }
}

class FakeDocument {
  constructor(elements) {
    this.elements = elements;
    this.listeners = new Map();
    this.activeElement = null;
    elements.forEach((element) => { element.ownerDocument = this; });
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type, properties = {}) {
    const event = {
      defaultPrevented: false,
      key: properties.key,
      target: properties.target || this,
      preventDefault() { this.defaultPrevented = true; },
    };
    (this.listeners.get(type) || []).forEach((listener) => listener(event));
    return event;
  }

  getElementById(id) {
    return this.elements.find((element) => element.id === id) || null;
  }

  querySelectorAll(selector) {
    if (selector.startsWith('.')) {
      const className = selector.slice(1);
      return this.elements.filter((element) => element.classList.contains(className));
    }
    const dataMatch = selector.match(/^\[data-([a-z-]+)\]$/);
    if (dataMatch) {
      const property = dataMatch[1].replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      return this.elements.filter((element) => Object.hasOwn(element.dataset, property));
    }
    return [];
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function assertExternalDeferredScript(html, expectedSource) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0][1], new RegExp(`\\bsrc=["']${expectedSource.replace('.', '\\.')}["']`, 'i'));
  assert.match(scripts[0][1], /\bdefer\b/i);
  assert.equal(scripts[0][2].trim(), '');
}

test('interactive pages use external scripts and contain no executable inline handlers or dangerous sinks', () => {
  const algosHtml = read('algos.html');
  const algosJs = read('algos.js');
  const downloadsHtml = read('downloads.html');
  const downloadsJs = read('downloads.js');
  const indexHtml = read('index.html');

  assertExternalDeferredScript(algosHtml, 'algos.js');
  assertExternalDeferredScript(downloadsHtml, 'downloads.js');

  for (const content of [algosHtml, downloadsHtml, indexHtml]) {
    assert.doesNotMatch(content, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(content, /(?:href|src)\s*=\s*["']\s*javascript:/i);
  }
  for (const content of [algosHtml + algosJs, downloadsHtml + downloadsJs, indexHtml]) {
    assert.doesNotMatch(content, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/);
    assert.doesNotMatch(content, /\bnew\s+Function\b|\beval\s*\(/);
  }
  assert.doesNotMatch(algosJs + downloadsJs, /\b(?:window\.)?event\s*\./);
});

test('algo session buttons filter cards and category headings without a global event object', () => {
  const allButton = new FakeElement({ classes: ['filter-btn', 'active'], dataset: { sessionFilter: 'all' } });
  const usButton = new FakeElement({ classes: ['filter-btn'], dataset: { sessionFilter: 'US' } });
  const asianButton = new FakeElement({ classes: ['filter-btn'], dataset: { sessionFilter: 'Asian' } });
  const euroButton = new FakeElement({ classes: ['filter-btn'], dataset: { sessionFilter: 'European' } });
  const firstCategory = new FakeElement({ classes: ['cat-header'] });
  const usCard = new FakeElement({ classes: ['algo-card'], dataset: { sessions: 'US' } });
  const asianCard = new FakeElement({ classes: ['algo-card'], dataset: { sessions: 'Asian' } });
  const secondCategory = new FakeElement({ classes: ['cat-header'] });
  const euroCard = new FakeElement({ classes: ['algo-card'], dataset: { sessions: 'European' } });
  const boundary = new FakeElement({ classes: ['summary-section'] });

  firstCategory.nextElementSibling = usCard;
  usCard.nextElementSibling = asianCard;
  asianCard.nextElementSibling = secondCategory;
  secondCategory.nextElementSibling = euroCard;
  euroCard.nextElementSibling = boundary;

  const documentRef = new FakeDocument([
    allButton, usButton, asianButton, euroButton,
    firstCategory, usCard, asianCard, secondCategory, euroCard, boundary,
  ]);
  algosPage.init(documentRef);

  asianButton.dispatch('click');
  assert.equal(asianButton.getAttribute('aria-pressed'), 'true');
  assert.equal(allButton.getAttribute('aria-pressed'), 'false');
  assert.equal(usCard.classList.contains('hidden'), true);
  assert.equal(asianCard.classList.contains('hidden'), false);
  assert.equal(euroCard.classList.contains('hidden'), true);
  assert.equal(firstCategory.classList.contains('hidden'), false);
  assert.equal(secondCategory.classList.contains('hidden'), true);

  allButton.dispatch('click');
  assert.equal([usCard, asianCard, euroCard].every((card) => !card.classList.contains('hidden')), true);
  assert.equal(secondCategory.classList.contains('hidden'), false);
});

test('downloads controls expand details and operate a keyboard-safe local-image lightbox', () => {
  const expandButton = new FakeElement({ dataset: { expandTarget: 'details' } });
  const details = new FakeElement({ id: 'details', classes: ['expanded-description'] });
  const safeImage = new FakeElement({
    dataset: { lightbox: '' },
    attributes: { src: 'images/example.png', alt: 'Example chart' },
  });
  const unsafeImage = new FakeElement({
    dataset: { lightbox: '' },
    attributes: { src: 'javascript:alert(1)', alt: 'Unsafe' },
  });
  const closeButton = new FakeElement({ dataset: { lightboxClose: '' } });
  const lightbox = new FakeElement({ id: 'lightbox', classes: ['lightbox'] });
  const preview = new FakeElement({ id: 'lightbox-img' });
  const documentRef = new FakeDocument([
    expandButton, details, safeImage, unsafeImage, closeButton, lightbox, preview,
  ]);
  lightbox.append(closeButton, preview);
  closeButton.ownerDocument = documentRef;
  preview.ownerDocument = documentRef;

  downloadsPage.init(documentRef);

  expandButton.dispatch('click');
  assert.equal(details.classList.contains('show'), true);
  assert.equal(details.getAttribute('aria-hidden'), 'false');
  assert.equal(expandButton.getAttribute('aria-expanded'), 'true');
  assert.equal(expandButton.textContent, 'Show Less');

  const spaceEvent = safeImage.dispatch('keydown', { key: ' ' });
  assert.equal(spaceEvent.defaultPrevented, true);
  assert.equal(lightbox.classList.contains('show'), true);
  assert.equal(lightbox.getAttribute('aria-hidden'), 'false');
  assert.equal(preview.getAttribute('src'), 'images/example.png');
  assert.equal(preview.getAttribute('alt'), 'Example chart');
  assert.equal(documentRef.activeElement, closeButton);

  const escapeEvent = documentRef.dispatch('keydown', { key: 'Escape' });
  assert.equal(escapeEvent.defaultPrevented, true);
  assert.equal(lightbox.classList.contains('show'), false);
  assert.equal(preview.getAttribute('src'), null);
  assert.equal(documentRef.activeElement, safeImage);

  unsafeImage.dispatch('click');
  assert.equal(lightbox.classList.contains('show'), false);
  assert.equal(preview.getAttribute('src'), null);
});

test('lightbox source validator admits only bounded local image paths', () => {
  assert.equal(downloadsPage.isSafeLocalImagePath('images/chart-01.webp'), true);
  assert.equal(downloadsPage.isSafeLocalImagePath('javascript:alert(1)'), false);
  assert.equal(downloadsPage.isSafeLocalImagePath('images/../secret.png'), false);
  assert.equal(downloadsPage.isSafeLocalImagePath('https://example.com/chart.png'), false);
  assert.equal(downloadsPage.isSafeLocalImagePath('images/chart.svg'), false);
});

test('index limits outbound referrers and embeds YouTube with a minimal capability set', () => {
  const html = read('index.html');
  const targetBlankLinks = [...html.matchAll(/<a\b[^>]*\btarget=["']_blank["'][^>]*>/gi)];

  assert.ok(targetBlankLinks.length > 0);
  targetBlankLinks.forEach((match) => {
    assert.match(match[0], /\brel=["'][^"']*\bnoopener\b[^"']*\bnoreferrer\b[^"']*["']/i);
  });
  assert.match(html, /<meta\b[^>]*name=["']referrer["'][^>]*content=["']strict-origin-when-cross-origin["']/i);

  const iframe = html.match(/<iframe\b([\s\S]*?)<\/iframe>/i);
  assert.ok(iframe);
  assert.match(iframe[1], /\bsrc=["']https:\/\/www\.youtube\.com\/embed\//i);
  assert.match(iframe[1], /\breferrerpolicy=["']strict-origin-when-cross-origin["']/i);
  assert.match(iframe[1], /\bsandbox=["']allow-presentation allow-same-origin allow-scripts["']/i);
  assert.match(iframe[1], /\ballow=["']autoplay; encrypted-media; fullscreen; picture-in-picture["']/i);
  assert.doesNotMatch(iframe[1], /accelerometer|clipboard-write|gyroscope|web-share/i);
});
