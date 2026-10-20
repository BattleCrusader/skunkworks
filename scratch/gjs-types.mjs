/** The measurement the registry's GRAPESJS_TYPES set is built from (S4a). */
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body><div id="g"></div></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window; globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
for (const n of ['HTMLElement','Element','Node','DOMParser','XMLSerializer']) globalThis[n] = dom.window[n];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
const grapesjs = (await import('grapesjs')).default;
const editor = grapesjs.init({ headless: true, container: document.getElementById('g'), storageManager: false });
const all = editor.Components.getTypes();
console.log(Object.keys(all).map((k) => (all[k] && all[k].id) || k).sort().join(' '));
