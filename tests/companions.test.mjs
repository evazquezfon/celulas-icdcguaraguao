import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function setup() {
  const nodes = new Map();
  function element() { return { value: '', dataset: {}, children: [], append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); child.remove = () => this.children.splice(this.children.indexOf(child), 1); }, focus() {}, checkValidity() { return Boolean(this.value.trim()); } }; }
  const companions = () => nodes.get('companions-container')?.children.flatMap(row => row.children.filter(child => 'companionName' in child.dataset)) || [];
  const document = { createElement: element, getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, querySelectorAll(selector) { return selector === '[data-companion-name]' ? companions() : []; } };
  const context = vm.createContext({ document, console });
  const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1].replace(/init\(\);\s*$/, '');
  vm.runInContext(script, context);
  vm.runInContext("CONFIG = { fields: [{ id: 'name', required: true }] }; selectedPlace = { id: 'church' }; showToast = () => {}; loadSpots = async () => {}; showConfirmation = (...args) => { confirmation = args; };", context);
  document.getElementById('field-name').value = 'Eva Cruz';
  return { context, document, companions, run: code => vm.runInContext(code, context) };
}
test('adds and removes a companion with only a name field', () => {
  const s = setup(); s.run('addCompanion()');
  assert.equal(s.companions().length, 1); assert.equal(s.companions()[0].required, true);
  assert.equal(s.document.getElementById('participant-count').textContent, 'Total: 2 participantes');
  s.document.getElementById('companions-container').children[0].children[2].onclick();
  assert.equal(s.companions().length, 0);
});
test('submits names once and uses the confirmed server count', async () => {
  const s = setup(); s.run('addCompanion()'); s.companions()[0].value = ' Ana Rivera ';
  s.run('calls = []; api = async (action, data) => { calls.push(data); return { ok: true, registeredCount: 2 }; };');
  const first = s.run('submitRegistration()'); const second = s.run('submitRegistration()');
  await Promise.all([first, second]);
  assert.equal(s.run('calls.length'), 1); assert.equal(s.run('calls[0].companions[0]'), 'Ana Rivera'); assert.equal(s.run('confirmation[2]'), 2);
});
test('blocks resubmission after an unconfirmed write', async () => {
  const s = setup(); s.run('calls = 0; api = async () => { calls++; return { ok: false, uncertain: true, error: "Verificar inscripción" }; };');
  await s.run('submitRegistration()'); await s.run('submitRegistration()');
  assert.equal(s.run('calls'), 1); assert.equal(s.document.getElementById('btn-register').disabled, true);
});
test('shows both capacity quantities and allows correction', async () => {
  const s = setup(); s.run('addCompanion()'); s.companions()[0].value = 'Ana Rivera';
  s.run('api = async () => ({ ok: false, full: true, available: 1, requested: 2 });');
  await s.run('submitRegistration()');
  assert.match(s.document.getElementById('registration-error').textContent, /2 participantes y quedan 1 cupos/);
  assert.equal(s.document.getElementById('btn-register').disabled, false);
});
