'use strict';

/**
 * Minimal stand-in for the `homey` runtime module that Homey injects into an app's sandbox.
 * It implements only what this app touches, and records everything so tests can assert on it.
 */

const en = require('../../locales/en.json');

class TriggerCard {

  constructor(id, recorder) {
    this.id = id;
    this.recorder = recorder;
    this.runListener = null;
    this.autocompleteListeners = {};
  }

  registerRunListener(listener) {
    this.runListener = listener;
    return this;
  }

  registerArgumentAutocompleteListener(name, listener) {
    this.autocompleteListeners[name] = listener;
    return this;
  }

  async trigger(tokens, state) {
    this.recorder.push({ id: this.id, tokens, state });
    return true;
  }

}

class FakeHomey {

  constructor() {
    this.store = new Map();
    this.triggered = [];
    this.realtimeEvents = [];
    this.cards = { trigger: new Map(), condition: new Map(), action: new Map() };
    this.listeners = new Map();
    this.timers = new Set();

    const card = (kind) => (id) => {
      const registry = this.cards[kind];
      if (!registry.has(id)) registry.set(id, new TriggerCard(id, this.triggered));
      return registry.get(id);
    };

    this.flow = {
      getTriggerCard: card('trigger'),
      getConditionCard: card('condition'),
      getActionCard: card('action'),
    };

    this.settings = {
      get: (key) => (this.store.has(key) ? this.store.get(key) : null),
      set: (key, value) => {
        this.store.set(key, JSON.parse(JSON.stringify(value)));
        this.emit('set', key);
      },
      unset: (key) => this.store.delete(key),
      on: (event, listener) => this.on(`settings:${event}`, listener),
    };

    this.api = {
      realtime: (event, data) => this.realtimeEvents.push({ event, data }),
    };
  }

  /** Resolve a dotted key from the English locale file, like Homey's __() does. */
  __(key) {
    const value = String(key).split('.').reduce((node, part) => (node ? node[part] : undefined), en);
    return typeof value === 'string' ? value : key;
  }

  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(listener);
  }

  emit(event, ...args) {
    const scoped = event === 'set' ? 'settings:set' : event;
    for (const listener of this.listeners.get(scoped) || []) listener(...args);
  }

  // Timers are handed out but never fire: tests drive the sampling loop themselves.
  setInterval(fn, ms) {
    const handle = { fn, ms };
    this.timers.add(handle);
    return handle;
  }

  clearInterval(handle) {
    this.timers.delete(handle);
  }

  setTimeout(fn, ms) {
    return this.setInterval(fn, ms);
  }

  clearTimeout(handle) {
    this.clearInterval(handle);
  }

}

class App {

  constructor(homey) {
    this.homey = homey;
    this.logs = [];
    this.errors = [];
  }

  log(...args) {
    this.logs.push(args.join(' '));
  }

  error(...args) {
    this.errors.push(args.join(' '));
  }

}

class Driver extends App {}
class Device extends App {}

module.exports = { App, Driver, Device, FakeHomey };
