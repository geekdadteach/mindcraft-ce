// One inventory window owner at a time. Unconfirmed closes quarantine this bot instance.
const held = new WeakMap();
export class WindowBusyError extends Error {
  constructor(message = 'Inventory window busy or requires reconnect') {
    super(message); this.name = 'WindowBusyError';
  }
}
export class SupersededWindowAction extends Error {
  constructor() { super('Inventory action was interrupted'); this.name = 'SupersededWindowAction'; }
}
export function windowLeaseStatus(bot) {
  const lease = held.get(bot);
  return lease ? {busy: true, quarantined: lease.quarantined, label: lease.label} :
    {busy: false, quarantined: false};
}
export async function withInventoryWindow(bot, block, label, operation) {
  if (held.has(bot)) throw new WindowBusyError();
  if (!block || typeof operation !== 'function') throw new TypeError('Block and operation required');
  const lease = {label, quarantined: false};
  held.set(bot, lease);
  const generation = bot._actionGen;
  const verifyOwner = () => {
    if (generation !== bot._actionGen || bot.interrupt_code === true)
      throw new SupersededWindowAction();
  };
  let window = null, opening = false, closed = false, result, failed = null;
  try {
    verifyOwner();
    opening = true;
    window = await bot.openContainer(block);
    opening = false;
    verifyOwner();
    result = await operation(window, verifyOwner);
    verifyOwner();
  } catch (error) {
    failed = error;
  } finally {
    if (window) {
      try {
        await window.close();
        closed = !(bot.currentWindow && bot.currentWindow === window);
      } catch (error) {
        console.warn('[ai-player] inventory: close failed; lease quarantined until reconnect: ' + error.message);
      }
    } else if (!opening) {
      // An abort that occurs before openContainer starts owns no window.
      closed = true;
    }
    if (closed) held.delete(bot);
    else {
      lease.quarantined = true;
      console.warn('[ai-player] inventory: unconfirmed window closure for ' + label + '; blocking more inventory windows');
    }
  }
  if (!closed) throw new WindowBusyError('Inventory window closure unconfirmed; reconnect required before reuse');
  if (failed) throw failed;
  return result;
}
