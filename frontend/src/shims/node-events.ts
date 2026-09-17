/**
 * Minimal browser stand-in for node's `events`.
 *
 * vtk.js pulls in xmlbuilder2 (XML IO we never use) which does
 * `class XMLBuilderCBImpl extends EventEmitter`. Without a real class the
 * module throws at import time and takes the whole app down, so we give it
 * one. Only the handful of methods xmlbuilder2 touches are implemented.
 */
type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  private _events: Map<string | symbol, Listener[]> = new Map();

  on(name: string | symbol, fn: Listener): this {
    const list = this._events.get(name) ?? [];
    list.push(fn);
    this._events.set(name, list);
    return this;
  }

  addListener(name: string | symbol, fn: Listener): this {
    return this.on(name, fn);
  }

  once(name: string | symbol, fn: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(name, wrapper);
      fn(...args);
    };
    return this.on(name, wrapper);
  }

  off(name: string | symbol, fn: Listener): this {
    const list = this._events.get(name);
    if (list) this._events.set(name, list.filter((l) => l !== fn));
    return this;
  }

  removeListener(name: string | symbol, fn: Listener): this {
    return this.off(name, fn);
  }

  removeAllListeners(name?: string | symbol): this {
    if (name === undefined) this._events.clear();
    else this._events.delete(name);
    return this;
  }

  listenerCount(name: string | symbol): number {
    return this._events.get(name)?.length ?? 0;
  }

  listeners(name: string | symbol): Listener[] {
    return [...(this._events.get(name) ?? [])];
  }

  eventNames(): (string | symbol)[] {
    return [...this._events.keys()];
  }

  setMaxListeners(): this {
    return this;
  }

  emit(name: string | symbol, ...args: unknown[]): boolean {
    const list = this._events.get(name);
    if (!list?.length) return false;
    [...list].forEach((fn) => fn(...args));
    return true;
  }
}

export default { EventEmitter };
