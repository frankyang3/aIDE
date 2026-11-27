'use strict';
const fs = require('fs');
const path = require('path');

/** Tiny JSON-file store: whole-object reads, debounced atomic writes. */
class Store {
  constructor(file, defaults = {}) {
    this.file = file;
    this.data = { ...defaults };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // First run, or an unreadable file: start from defaults.
    }
    this.timer = null;
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Could not save state:', err.message);
    }
  }
}

module.exports = { Store };
